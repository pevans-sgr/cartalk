"""Localhost status page for the monitor (stdlib only — no FastAPI/uvicorn).

Bound to localhost and published to ``evans-apps.org`` by a Cloudflare tunnel running
beside the daemon. Reachable only when the Pi has internet — i.e. parked in the garage on
home Wi-Fi — which is exactly when you want to review what was caught. Three routes:

* ``/``            — auto-refreshing HTML: state, live voltage/RPM, uptime, caught events.
* ``/status.json`` — the same data as JSON (for scripts / the page fetch).
* ``/events/<f>``  — download one captured fault snapshot.

The server runs in a daemon thread and reads a live status dict via a provider callback,
so it never blocks the monitor loop.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

from .store import EventStore

_PAGE = """<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>cartalk monitor</title>
<style>
 body{{font:16px/1.5 system-ui,sans-serif;margin:0;background:#111;color:#eee}}
 header{{padding:1rem;background:#1c1c1c}}
 .wrap{{max-width:640px;margin:0 auto;padding:1rem}}
 .dot{{display:inline-block;width:.7em;height:.7em;border-radius:50%;margin-right:.4em}}
 .active{{background:#3fb950}} .parked_awake{{background:#d29922}} .sleep{{background:#6e7681}}
 .k{{color:#8b949e}} .big{{font-size:2rem;font-weight:600}}
 table{{width:100%;border-collapse:collapse;margin-top:1rem}}
 td,th{{text-align:left;padding:.4rem .2rem;border-bottom:1px solid #30363d}}
 a{{color:#58a6ff}}
</style></head><body>
<header class=wrap><span class="dot {state}"></span><b>cartalk monitor</b> — {state}</header>
<div class=wrap>
 <p class=big>{volts} V <span class=k>{rpm}</span></p>
 <p><span class=k>uptime</span> {uptime} &nbsp; <span class=k>samples</span> {samples}
    &nbsp; <span class=k>events caught</span> <b>{nevents}</b></p>
 <p class=k>{watched}</p>
 <h3>Caught faults</h3>
 {events}
</div>
<script>setTimeout(()=>location.reload(),5000)</script>
</body></html>"""


def _fmt_uptime(seconds: float) -> str:
    s = int(seconds)
    d, s = divmod(s, 86400)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    parts = ([f"{d}d"] if d else []) + ([f"{h}h"] if h or d else []) + [f"{m}m"]
    return " ".join(parts)


def render_page(status: dict, events: list[dict]) -> str:
    if events:
        rows = "".join(
            f"<tr><td><a href='/events/{e['name']}'>{e['name']}</a></td>"
            f"<td>{e.get('summary','')}</td></tr>" for e in events)
        events_html = f"<table><tr><th>file</th><th>what</th></tr>{rows}</table>"
    else:
        events_html = "<p class=k>none yet — armed and watching.</p>"
    volts = status.get("volts")
    rpm = status.get("rpm")
    return _PAGE.format(
        state=status.get("state", "active"),
        volts=f"{volts:.2f}" if isinstance(volts, (int, float)) else "—",
        rpm=f"{rpm:.0f} rpm" if isinstance(rpm, (int, float)) else "",
        uptime=_fmt_uptime(status.get("uptime", 0)),
        samples=status.get("samples", 0),
        nevents=len(events),
        watched=status.get("watched", ""),
        events=events_html,
    )


def make_server(host: str, port: int, status_provider: Callable[[], dict],
                store: EventStore) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # silence default stderr logging
            pass

        def _send(self, code, body: bytes, ctype="text/html; charset=utf-8"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                body = render_page(status_provider(), store.list_events()).encode()
                self._send(200, body)
            elif self.path == "/status.json":
                payload = {"status": status_provider(), "events": store.list_events()}
                self._send(200, json.dumps(payload).encode(), "application/json")
            elif self.path.startswith("/events/"):
                path = store.event_path(self.path[len("/events/"):])
                if path is None:
                    self._send(404, b"not found", "text/plain")
                    return
                with open(path, "rb") as f:
                    self._send(200, f.read(), "application/json")
            else:
                self._send(404, b"not found", "text/plain")

        def do_HEAD(self):
            # Health-checkers / uptime monitors probe with HEAD — answer it (headers only).
            known = (self.path in ("/", "/index.html", "/status.json")
                     or (self.path.startswith("/events/")
                         and store.event_path(self.path[len("/events/"):]) is not None))
            self.send_response(200 if known else 404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()

    server = ThreadingHTTPServer((host, port), Handler)
    return server
