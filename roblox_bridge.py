#!/usr/bin/env python3
"""
Local bridge between ollama-chat.html and a Roblox Studio plugin.

  browser --POST /tool--> this script <--GET /plugin/poll-- Studio plugin
                                       <--POST /plugin/result--

Studio plugins can only make outbound HTTP requests, so the plugin long-polls
this script for commands and posts the results back. The chat page POSTs a
command to /tool and waits for the result.

Security: binds to 127.0.0.1 only; the Host header must be localhost (blocks
DNS rebinding); browser routes use the same Origin allowlist as
local_cors_proxy.py; plugin routes reject any request that has an Origin
header (the plugin sends none, a web page can't omit it).

Usage:  python3 roblox_bridge.py [port]      (default 8766)
No dependencies -- standard library only.
"""

import json
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
POLL_HOLD_SECONDS = 20       # how long an empty plugin poll waits before returning 204
TOOL_TIMEOUT_SECONDS = 45    # how long the browser waits for Studio to answer
PLUGIN_STALE_SECONDS = 45    # plugin counts as disconnected if it hasn't polled this recently
MAX_BODY_BYTES = 5_000_000

_cond = threading.Condition()
_pending = []        # commands waiting for the plugin to pick them up
_waiting = set()     # ids the browser is still waiting on
_results = {}        # id -> {'ok': bool, 'result': str}
_plugin_last_seen = 0.0


def _plugin_connected():
    return (time.time() - _plugin_last_seen) < PLUGIN_STALE_SECONDS


def _origin_allowed(origin):
    if not origin or origin == 'null':
        return True
    try:
        return urlparse(origin).hostname in ('localhost', '127.0.0.1')
    except ValueError:
        return False


def _host_allowed(host):
    if not host or host.startswith('['):
        return False
    return host.rsplit(':', 1)[0] in ('127.0.0.1', 'localhost')


class Handler(BaseHTTPRequestHandler):
    def _reply(self, status, payload=None, origin=None):
        body = b'' if payload is None else json.dumps(payload).encode('utf-8')
        self.send_response(status)
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _guard(self, plugin_route):
        """Returns (allowed, origin). Sends the 403 itself when not allowed."""
        origin = self.headers.get('Origin')
        if not _host_allowed(self.headers.get('Host')):
            self._reply(403, {'ok': False, 'result': 'Forbidden host.'})
            return False, None
        if plugin_route:
            if origin:
                self._reply(403, {'ok': False, 'result': 'Plugin endpoints are not available to web pages.'})
                return False, None
        elif not _origin_allowed(origin):
            print(f'[roblox_bridge] Refused request from disallowed origin: {origin}')
            self._reply(403, {'ok': False, 'result': 'Forbidden: origin not allowed.'})
            return False, None
        return True, origin

    def _read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_BODY_BYTES:
            raise ValueError('Request body too large.')
        raw = self.rfile.read(length) if length else b'{}'
        return json.loads(raw or b'{}')

    def do_OPTIONS(self):
        ok, origin = self._guard(False)
        if not ok:
            return
        self.send_response(204)
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/plugin/poll':
            self._handle_poll()
        elif path == '/status':
            ok, origin = self._guard(False)
            if ok:
                self._reply(200, {'ok': True, 'plugin_connected': _plugin_connected()}, origin)
        else:
            self._reply(404, {'ok': False, 'result': 'Not found.'})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/tool':
            self._handle_tool()
        elif path == '/plugin/result':
            self._handle_result()
        else:
            self._reply(404, {'ok': False, 'result': 'Not found.'})

    def _handle_poll(self):
        global _plugin_last_seen
        ok, _ = self._guard(True)
        if not ok:
            return
        deadline = time.time() + POLL_HOLD_SECONDS
        with _cond:
            _plugin_last_seen = time.time()
            while not _pending:
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                _cond.wait(remaining)
            cmd = _pending.pop(0) if _pending else None
            _plugin_last_seen = time.time()
        if cmd:
            self._reply(200, cmd)
        else:
            self._reply(204)

    def _handle_tool(self):
        ok, origin = self._guard(False)
        if not ok:
            return
        try:
            data = self._read_json()
            tool = data.get('tool')
            args = data.get('args') or {}
            if not isinstance(tool, str) or not tool.startswith('roblox_') or not isinstance(args, dict):
                raise ValueError('Expected {"tool": "roblox_...", "args": {...}}.')
        except Exception as e:
            self._reply(400, {'ok': False, 'result': f'Bad request: {e}'}, origin)
            return

        if not _plugin_connected():
            self._reply(503, {'ok': False, 'result': (
                'The Roblox Studio plugin is not connected. In Studio, open the Plugins tab, '
                'click "Ollama Bridge", and accept the HTTP permission prompt.')}, origin)
            return

        cmd_id = uuid.uuid4().hex
        cmd = {'id': cmd_id, 'tool': tool, 'args': args}
        with _cond:
            _pending.append(cmd)
            _waiting.add(cmd_id)
            _cond.notify_all()
            deadline = time.time() + TOOL_TIMEOUT_SECONDS
            while cmd_id not in _results:
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
                _cond.wait(remaining)
            result = _results.pop(cmd_id, None)
            _waiting.discard(cmd_id)
            if result is None and cmd in _pending:
                _pending.remove(cmd)

        if result is None:
            self._reply(504, {'ok': False, 'result': 'Timed out waiting for Roblox Studio to respond.'}, origin)
        else:
            self._reply(200, result, origin)

    def _handle_result(self):
        ok, _ = self._guard(True)
        if not ok:
            return
        try:
            data = self._read_json()
            cmd_id = data['id']
        except Exception as e:
            self._reply(400, {'ok': False, 'result': f'Bad request: {e}'})
            return
        with _cond:
            if cmd_id in _waiting:   # ignore late results nobody is waiting for
                _results[cmd_id] = {'ok': bool(data.get('ok')), 'result': str(data.get('result', ''))}
                _cond.notify_all()
        self._reply(200, {'ok': True})

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.daemon_threads = True
    print(f'Roblox bridge running at http://127.0.0.1:{PORT}')
    print('Bound to 127.0.0.1 only. In Studio, click "Ollama Bridge" in the Plugins tab to connect.')
    print('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')