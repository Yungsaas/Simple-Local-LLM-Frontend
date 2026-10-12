#!/usr/bin/env python3
"""
Local MCP bridge for ollama-chat.html.

MCP servers (like the one built into Roblox Studio) speak JSON-RPC over a
program's stdin/stdout, which a web page can't launch or talk to. This script
launches the servers listed in mcp_servers.json, does the MCP handshake, and
exposes them to the chat page over a small HTTP API on localhost:

    GET  /status   open: is the bridge up, is the caller's token valid
    GET  /tools    (token) every tool of every configured server
    POST /call     (token) {"server", "tool", "arguments"} -> the tool's output

mcp_servers.json uses the same format MCP clients use:

    { "mcpServers": { "Name": { "command": "...", "args": ["..."],
                                "env": {"K": "V"}, "cwd": "..." } } }

Servers start the first time the chat page asks for tools, and are stopped
when this script stops. Environment variables like %LOCALAPPDATA% are expanded.

Security:
  * Binds to 127.0.0.1 only, and only accepts Host: localhost / 127.0.0.1
    (blocks DNS rebinding).
  * The page's Origin must be file:// ("null") or localhost, as with
    local_cors_proxy.py, BUT that alone can't stop other web pages (a sandboxed
    iframe also sends "null"), and these tools can change your projects. So
    /tools and /call also require a secret token, generated on first run and
    stored in mcp_bridge_token.txt. Paste it into the app's Settings once.
  * Only the commands in your own mcp_servers.json can ever be launched; the
    HTTP API cannot add or change them.

Usage:  python3 mcp_bridge.py [port] [config_path]     (default 8766)
No dependencies -- standard library only.
"""

import hmac
import itertools
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
CONFIG_PATH = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'mcp_servers.json')
TOKEN_PATH = os.path.join(HERE, 'mcp_bridge_token.txt')

PROTOCOL_VERSION = '2025-06-18'
INIT_TIMEOUT = 30          # seconds to wait for a server's initialize handshake
LIST_TIMEOUT = 30          # seconds to wait for tools/list
CALL_TIMEOUT = 120         # seconds to wait for a tool call (Studio can be slow)
LIST_CACHE_SECONDS = 10    # tools/list results are reused for this long
MAX_BODY_BYTES = 5_000_000


class McpError(Exception):
    pass


# ---------------------------------------------------------------- token ----

def load_token():
    try:
        with open(TOKEN_PATH, 'r', encoding='utf-8') as f:
            existing = f.read().strip()
        if len(existing) >= 20:
            return existing
    except OSError:
        pass
    token = secrets.token_urlsafe(24)
    with open(TOKEN_PATH, 'w', encoding='utf-8') as f:
        f.write(token + '\n')
    try:
        os.chmod(TOKEN_PATH, 0o600)
    except OSError:
        pass
    return token


TOKEN = load_token()


# --------------------------------------------------------- MCP server ----

class McpServer:
    """One MCP server process, spoken to as newline-delimited JSON-RPC."""

    def __init__(self, name, spec):
        self.name = name
        self.command = os.path.expandvars(str(spec['command']))
        self.args = [os.path.expandvars(str(a)) for a in (spec.get('args') or [])]
        self.env = {k: os.path.expandvars(str(v)) for k, v in (spec.get('env') or {}).items()}
        self.cwd = os.path.expandvars(str(spec['cwd'])) if spec.get('cwd') else None

        self.proc = None
        self.state = 'stopped'      # stopped | starting | running | error
        self.error = ''
        self.tool_count = 0

        self._lock = threading.RLock()         # guards start/stop
        self._write_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending = {}                     # request id -> {'event', 'msg'}
        self._ids = itertools.count(1)
        self._stderr_tail = deque(maxlen=15)
        self._tools = None
        self._tools_at = 0.0

    # -- process lifecycle --

    def ensure_started(self):
        with self._lock:
            if self.proc is not None and self.proc.poll() is None and self.state == 'running':
                return
            self._kill()
            self.state = 'starting'
            self.error = ''
            self._stderr_tail.clear()
            self._tools = None
            env = os.environ.copy()
            env.update(self.env)
            try:
                proc = subprocess.Popen(
                    [self.command] + self.args,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    env=env, cwd=self.cwd,
                )
            except OSError as e:
                self.state = 'error'
                self.error = f'Could not start "{self.command}": {e}'
                raise McpError(self.error)
            self.proc = proc
            threading.Thread(target=self._read_stdout, args=(proc,), daemon=True).start()
            threading.Thread(target=self._read_stderr, args=(proc,), daemon=True).start()
            try:
                self._request('initialize', {
                    'protocolVersion': PROTOCOL_VERSION,
                    'capabilities': {},
                    'clientInfo': {'name': 'ollama-chat-mcp-bridge', 'version': '1.0'},
                }, INIT_TIMEOUT)
                self._notify('notifications/initialized')
            except McpError as e:
                detail = self._stderr_summary()
                self._kill()
                self.state = 'error'
                self.error = f'{e}{detail}'
                raise McpError(self.error)
            self.state = 'running'

    def _kill(self):
        proc, self.proc = self.proc, None
        if proc is None:
            return
        try:
            proc.stdin.close()
        except Exception:
            pass
        if proc.poll() is None:
            if os.name == 'nt':
                # The server is usually started through cmd.exe, so kill the whole tree.
                subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                               capture_output=True)
            else:
                proc.terminate()
            try:
                proc.wait(timeout=3)
            except Exception:
                proc.kill()

    def stop(self):
        with self._lock:
            self._kill()
            self.state = 'stopped'

    def _stderr_summary(self):
        lines = [l for l in self._stderr_tail if l.strip()]
        return ('\nServer output: ' + ' | '.join(lines[-5:])) if lines else ''

    # -- reader threads --

    def _read_stdout(self, proc):
        try:
            for raw in iter(proc.stdout.readline, b''):
                line = raw.decode('utf-8', errors='replace').strip()
                if not line.startswith('{'):
                    continue  # banner text etc., not protocol traffic
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                self._handle_message(msg)
        except Exception:
            pass
        finally:
            if self.proc is proc and self.state == 'running':
                self.state = 'stopped'
                self.error = 'The MCP server process exited.' + self._stderr_summary()
            self._fail_pending('The MCP server process exited.' + self._stderr_summary())

    def _read_stderr(self, proc):
        try:
            for raw in iter(proc.stderr.readline, b''):
                self._stderr_tail.append(raw.decode('utf-8', errors='replace').strip())
        except Exception:
            pass

    def _handle_message(self, msg):
        if 'id' in msg and ('result' in msg or 'error' in msg) and 'method' not in msg:
            with self._pending_lock:
                slot = self._pending.get(msg['id'])
            if slot:
                slot['msg'] = msg
                slot['event'].set()
        elif 'method' in msg and 'id' in msg:
            # A request from the server to us (ping, roots/list, sampling, ...).
            if msg['method'] == 'ping':
                self._send({'jsonrpc': '2.0', 'id': msg['id'], 'result': {}})
            else:
                self._send({'jsonrpc': '2.0', 'id': msg['id'],
                            'error': {'code': -32601, 'message': 'Method not supported by this client.'}})
        elif msg.get('method') == 'notifications/tools/list_changed':
            self._tools = None

    def _fail_pending(self, message):
        with self._pending_lock:
            slots = list(self._pending.values())
        for slot in slots:
            if not slot['event'].is_set():
                slot['msg'] = {'error': {'message': message}}
                slot['event'].set()

    # -- JSON-RPC --

    def _send(self, obj):
        proc = self.proc
        if proc is None or proc.poll() is not None:
            raise McpError('The MCP server is not running.')
        data = (json.dumps(obj) + '\n').encode('utf-8')
        try:
            with self._write_lock:
                proc.stdin.write(data)
                proc.stdin.flush()
        except (OSError, ValueError):
            raise McpError('The MCP server closed its input.')

    def _notify(self, method, params=None):
        msg = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            msg['params'] = params
        self._send(msg)

    def _request(self, method, params, timeout):
        rid = next(self._ids)
        slot = {'event': threading.Event(), 'msg': None}
        with self._pending_lock:
            self._pending[rid] = slot
        try:
            self._send({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params})
            if not slot['event'].wait(timeout):
                raise McpError(f'Timed out after {timeout}s waiting for "{method}".')
        finally:
            with self._pending_lock:
                self._pending.pop(rid, None)
        msg = slot['msg'] or {}
        if 'error' in msg:
            err = msg['error']
            text = err.get('message') if isinstance(err, dict) else str(err)
            raise McpError(str(text or 'Unknown MCP error'))
        return msg.get('result') or {}

    # -- public operations --

    def list_tools(self, force=False):
        self.ensure_started()
        if not force and self._tools is not None and time.time() - self._tools_at < LIST_CACHE_SECONDS:
            return self._tools
        tools, cursor = [], None
        for _ in range(20):
            res = self._request('tools/list', {'cursor': cursor} if cursor else {}, LIST_TIMEOUT)
            tools.extend(res.get('tools') or [])
            cursor = res.get('nextCursor')
            if not cursor:
                break
        self._tools, self._tools_at = tools, time.time()
        self.tool_count = len(tools)
        return tools

    def call_tool(self, tool, arguments):
        self.ensure_started()
        return self._request('tools/call', {'name': tool, 'arguments': arguments or {}}, CALL_TIMEOUT)

    def info(self):
        return {'name': self.name, 'state': self.state, 'error': self.error, 'toolCount': self.tool_count}


def flatten_result(res):
    """Turns an MCP tools/call result into (text, is_error)."""
    parts = []
    for block in res.get('content') or []:
        kind = block.get('type')
        if kind == 'text':
            parts.append(block.get('text', ''))
        elif kind == 'image':
            parts.append(f"[image omitted: {block.get('mimeType', 'image')}]")
        elif kind == 'resource':
            r = block.get('resource') or {}
            parts.append(r.get('text') or f"[resource: {r.get('uri', '')}]")
        elif kind == 'resource_link':
            parts.append(f"[resource link: {block.get('uri', '')}]")
        else:
            parts.append(f'[{kind} content omitted]')
    text = '\n'.join(p for p in parts if p)
    if not text and res.get('structuredContent') is not None:
        text = json.dumps(res['structuredContent'], indent=2)
    return (text or '(The tool returned no output.)'), bool(res.get('isError'))


# ------------------------------------------------------------- config ----

def load_servers():
    try:
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
    except OSError as e:
        sys.exit(f'Could not read {CONFIG_PATH}: {e}')
    except ValueError as e:
        sys.exit(f'{CONFIG_PATH} is not valid JSON: {e}')
    entries = cfg.get('mcpServers') if isinstance(cfg, dict) else None
    if not isinstance(entries, dict) or not entries:
        sys.exit(f'{CONFIG_PATH} needs a non-empty "mcpServers" object.')
    servers = {}
    for name, spec in entries.items():
        if not isinstance(spec, dict) or not spec.get('command'):
            sys.exit(f'Server "{name}" in {CONFIG_PATH} needs a "command".')
        servers[name] = McpServer(name, spec)
    return servers


SERVERS = load_servers()


# --------------------------------------------------------------- HTTP ----

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
    def _reply(self, status, payload=None):
        body = b'' if payload is None else json.dumps(payload).encode('utf-8')
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _guard(self):
        """Host + Origin checks. Sends the 403 itself and returns False if refused."""
        if not _host_allowed(self.headers.get('Host')):
            self._reply(403, {'ok': False, 'error': 'Forbidden host.'})
            return False
        origin = self.headers.get('Origin')
        if not _origin_allowed(origin):
            print(f'[mcp_bridge] Refused request from disallowed origin: {origin}')
            self._reply(403, {'ok': False, 'error': 'Forbidden: origin not allowed.'})
            return False
        return True

    def _authorized(self):
        supplied = (self.headers.get('X-Bridge-Token') or '').encode('utf-8')
        return hmac.compare_digest(supplied, TOKEN.encode('utf-8'))

    def _require_token(self):
        if self._authorized():
            return True
        self._reply(401, {'ok': False, 'error': (
            'Missing or wrong bridge token. Copy the token shown when mcp_bridge.py starts '
            '(also in mcp_bridge_token.txt) into the app\'s Settings.')})
        return False

    def _read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_BODY_BYTES:
            raise ValueError('Request body too large.')
        raw = self.rfile.read(length) if length else b'{}'
        return json.loads(raw or b'{}')

    def do_OPTIONS(self):
        if not self._guard():
            return
        self.send_response(204)
        origin = self.headers.get('Origin')
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if not self._guard():
            return
        path = urlparse(self.path).path
        if path == '/status':
            authorized = self._authorized()
            payload = {'ok': True, 'authorized': authorized}
            if authorized:
                payload['servers'] = [s.info() for s in SERVERS.values()]
            self._reply(200, payload)
        elif path == '/tools':
            if self._require_token():
                self._handle_tools()
        else:
            self._reply(404, {'ok': False, 'error': 'Not found.'})

    def do_POST(self):
        if not self._guard():
            return
        if urlparse(self.path).path == '/call':
            if self._require_token():
                self._handle_call()
        else:
            self._reply(404, {'ok': False, 'error': 'Not found.'})

    def _handle_tools(self):
        tools = []
        for server in SERVERS.values():
            try:
                for t in server.list_tools():
                    tools.append({
                        'server': server.name,
                        'name': t.get('name'),
                        'title': t.get('title'),
                        'description': t.get('description') or '',
                        'inputSchema': t.get('inputSchema') or {'type': 'object', 'properties': {}},
                        'annotations': t.get('annotations') or {},
                    })
            except McpError:
                pass  # the reason is in server.error, reported below
        self._reply(200, {'ok': True, 'tools': tools, 'servers': [s.info() for s in SERVERS.values()]})

    def _handle_call(self):
        try:
            data = self._read_json()
            server = SERVERS.get(data.get('server'))
            tool = data.get('tool')
            arguments = data.get('arguments') or {}
            if server is None or not isinstance(tool, str) or not isinstance(arguments, dict):
                raise ValueError('Expected {"server": "<configured name>", "tool": "<name>", "arguments": {...}}.')
        except Exception as e:
            self._reply(400, {'ok': False, 'error': f'Bad request: {e}'})
            return
        try:
            res = server.call_tool(tool, arguments)
        except McpError as e:
            self._reply(502, {'ok': False, 'error': str(e)})
            return
        text, is_error = flatten_result(res)
        self._reply(200, {'ok': True, 'isError': is_error, 'text': text})

    def log_message(self, fmt, *args):
        pass


def main():
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.daemon_threads = True
    print(f'MCP bridge running at http://127.0.0.1:{PORT}')
    print('Bound to 127.0.0.1 only (not reachable from your network).')
    print(f'Config: {CONFIG_PATH}  ({", ".join(SERVERS)})')
    print('')
    print('Paste this token into the chat app: Settings -> MCP bridge token')
    print(f'    {TOKEN}')
    print('')
    print('Servers start when the chat app first asks for tools. Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping...')
    finally:
        for s in SERVERS.values():
            s.stop()


if __name__ == '__main__':
    main()