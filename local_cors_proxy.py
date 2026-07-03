#!/usr/bin/env python3
"""
Tiny local CORS proxy for ollama-chat.html's web_search / web_fetch tools.

Browsers block page JavaScript from fetching arbitrary third-party URLs (CORS);
a server-side script has no such limit. This listens on localhost, does the
fetch itself, and returns the result with permissive CORS headers. Nothing
routes through a third party -- the only hops are browser -> this script and
this script -> the URL the tool asked for.

Security: it binds to 127.0.0.1 only, but any browser tab is also "on your
machine", so every request's Origin is checked against an allowlist (file://
pages and http(s)://localhost / 127.0.0.1 on any port) to stop other sites
using it as an open proxy -- see `_origin_allowed`. A request with no Origin
(e.g. curl) is allowed, since a hostile page can't forge that.

Usage:
    python3 local_cors_proxy.py [port] [idle_minutes]

Default port 8765; point the app's Settings -> "CORS proxy" field at
http://127.0.0.1:8765/?url=. A page can't stop this process for you, so it
self-stops after some minutes of inactivity (default 30; pass 0 to disable):
    python3 local_cors_proxy.py 8765 0

No dependencies -- standard library only.
"""

import os
import sys
import time
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
IDLE_TIMEOUT_MINUTES = float(sys.argv[2]) if len(sys.argv) > 2 else 30
TIMEOUT = 15  # seconds -- generous for slow pages, short enough to fail fast

# How often (seconds) to print the "still running" heartbeat below. It stands
# in for the default per-request access log, whose constant "GET ... 400 -"
# lines read like errors to anyone not used to server logs.
HEARTBEAT_SECONDS = 60
HEARTBEAT_MESSAGE = '[Local LLM web access] service is running with no issues.'

_last_request_time = time.time()
_last_request_lock = threading.Lock()


def _touch():
    global _last_request_time
    with _last_request_lock:
        _last_request_time = time.time()


def _idle_watchdog():
    while True:
        time.sleep(30)
        with _last_request_lock:
            idle_seconds = time.time() - _last_request_time
        if idle_seconds > IDLE_TIMEOUT_MINUTES * 60:
            print(f'[local_cors_proxy] Idle for {IDLE_TIMEOUT_MINUTES:.0f} min, shutting down.')
            os._exit(0)


def _heartbeat():
    # The only routine output once the proxy is up: individual requests aren't
    # logged (normal 400/404s would look like errors), but real fetch failures
    # still print immediately from do_GET's except blocks.
    while True:
        time.sleep(HEARTBEAT_SECONDS)
        print(HEARTBEAT_MESSAGE)


def _origin_allowed(origin):
    """
    True if `origin` is safe to serve -- i.e. a hostile page couldn't have
    forged it: no Origin at all (curl/same-origin, nothing to spoof), "null"
    (what browsers send for the file:// pages this app is normally opened as),
    or http(s)://localhost / 127.0.0.1 on any port (a local web server).
    Anything else is refused as traffic from a page that isn't this app.
    """
    if not origin or origin == 'null':
        return True
    try:
        hostname = urlparse(origin).hostname
    except ValueError:
        return False
    return hostname in ('localhost', '127.0.0.1')


class ProxyHandler(BaseHTTPRequestHandler):
    def _cors_headers(self, origin):
        # Echo the already-validated origin rather than '*'. Equivalent here
        # (no cookies), but keeps the header meaningful if that ever changes.
        self.send_header('Access-Control-Allow-Origin', origin if origin else '*')
        self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')

    def _plain_text(self, status, message):
        self.send_response(status)
        self._cors_headers(self.headers.get('Origin'))
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.end_headers()
        self.wfile.write(message.encode('utf-8'))

    def _reject_origin(self, origin):
        print(f'[local_cors_proxy] Refused request from disallowed origin: {origin}')
        self.send_response(403)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'Forbidden: origin not allowed.')

    def do_OPTIONS(self):
        _touch()
        origin = self.headers.get('Origin')
        if not _origin_allowed(origin):
            self._reject_origin(origin)
            return
        # Preflight support, in case the browser ever sends one.
        self.send_response(204)
        self._cors_headers(origin)
        self.end_headers()

    def do_GET(self):
        _touch()
        origin = self.headers.get('Origin')
        if not _origin_allowed(origin):
            self._reject_origin(origin)
            return
        # parse_qs already fully percent-decodes values. Do NOT add an
        # unquote() here: an earlier version did, double-decoding the target
        # URL's own '%20's into spaces and causing the "URL can't contain
        # control characters" failures.
        query = parse_qs(urlparse(self.path).query)
        target = query.get('url', [None])[0]

        if not target:
            self._plain_text(400, "Missing '?url=' parameter.")
            return

        if not (target.startswith('http://') or target.startswith('https://')):
            self._plain_text(400, 'Only http:// and https:// URLs are allowed.')
            return

        try:
            req = urllib.request.Request(
                target,
                headers={
                    # A realistic header set stops some sites (DuckDuckGo
                    # included) from serving a stripped page, a bot challenge,
                    # or a block to obvious script traffic.
                    'User-Agent': (
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                        'AppleWebKit/537.36 (KHTML, like Gecko) '
                        'Chrome/124.0.0.0 Safari/537.36'
                    ),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                body = resp.read()
                content_type = resp.headers.get('Content-Type', 'text/plain; charset=utf-8')

            self.send_response(200)
            self._cors_headers(origin)
            self.send_header('Content-Type', content_type)
            self.end_headers()
            self.wfile.write(body)

        except urllib.error.HTTPError as e:
            # Reflect the real upstream status so the app's error handling
            # (res.ok checks) sees an accurate failure rather than a
            # successful-looking 200 with an error message inside it.
            print(f'[local_cors_proxy] Upstream error fetching {target}: HTTP {e.code} {e.reason}')
            self._plain_text(e.code, f'Upstream error {e.code}: {e.reason}')

        except Exception as e:
            # Printed here (not just sent to the browser) so the real reason
            # shows up directly in this terminal, e.g. "URLError" (network/
            # SSL/DNS issue) vs "TimeoutError" (upstream too slow) vs
            # "ConnectionResetError" (target actively cut the connection,
            # often a bot-block) point at very different problems.
            print(f'[local_cors_proxy] Failed fetching {target}: {type(e).__name__}: {e}')
            self._plain_text(502, f'Proxy fetch failed: {type(e).__name__}: {e}')

    def log_message(self, fmt, *args):
        # Deliberately silent: http.server's default logs every request,
        # including normal preflight 400s that read like errors. Real failures
        # still print from do_GET's except blocks, and the heartbeat confirms
        # health in between.
        pass


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), ProxyHandler)
    server.daemon_threads = True  # so stray in-flight requests don't block process exit
    print(f'Local CORS proxy running at http://127.0.0.1:{PORT}/?url=<target>')
    print('Bound to 127.0.0.1 only (not reachable from your network).')
    print('Only requests from file:// pages or http(s)://localhost/127.0.0.1 are served.')
    print("Point the app's Settings -> CORS proxy field at that address.")
    threading.Thread(target=_heartbeat, daemon=True).start()
    if IDLE_TIMEOUT_MINUTES > 0:
        print(f'Will auto-stop after {IDLE_TIMEOUT_MINUTES:.0f} min of inactivity (pass 0 as a second argument to disable).')
        threading.Thread(target=_idle_watchdog, daemon=True).start()
    else:
        print('Auto-shutdown disabled, will run until you stop it.')
    print('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
