#!/usr/bin/env python3
"""
Local dashboard server. Serves the React UI and a tiny JSON API over the watcher's data.

    python server.py            ->  http://localhost:8765   (PORT env var overrides)

API:
    GET  /api/summary           every product's latest/previous/lowest/highest price, page path, category names
    GET  /api/series?key=...    price changes of one product
    GET  /api/config            current config.json
    PUT  /api/config            update ntfy_topic / ship / sail_date / categories / watch / booked
    GET  /api/check             is a check running, and the last check's output
    POST /api/check             run watch.py now
"""

import json
import os
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from store import ROOT, build_summary, load_config, read_history, save_config, series_for

UI_DIST = ROOT / "ui" / "dist"
PORT = int(os.environ.get("PORT", "8765"))
EDITABLE_KEYS = ("ntfy_topic", "ship", "sail_date", "currency", "categories", "watch", "booked")
_check_lock = threading.Lock()
_check_state = {"running": False, "last_output": ""}


def run_check() -> None:
    with _check_lock:
        _check_state["running"] = True
    try:
        proc = subprocess.run([sys.executable, str(ROOT / "watcher" / "watch.py")],
                              capture_output=True, text=True, timeout=600)
        _check_state["last_output"] = (proc.stdout + proc.stderr).strip()[-4000:]
    except Exception as e:  # noqa: BLE001
        _check_state["last_output"] = f"error: {e}"
    finally:
        _check_state["running"] = False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(UI_DIST), **kw)

    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/summary":
            return self._json(build_summary())
        if url.path == "/api/series":
            key = (parse_qs(url.query).get("key") or [""])[0]
            return self._json({"key": key, "series": series_for(read_history(), key)})
        if url.path == "/api/config":
            return self._json(load_config())
        if url.path == "/api/check":
            return self._json(_check_state)
        if url.path.startswith("/api/"):
            return self._json({"error": "not found"}, 404)
        if not UI_DIST.exists():
            self.send_response(503)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"UI not built. Run `make ui` first.")
            return
        # SPA fallback: serve index.html for non-file paths
        if "." not in Path(url.path).name:
            self.path = "/index.html"
        return super().do_GET()

    def do_PUT(self):
        if self.path.startswith("/api/config"):
            incoming = self._read_body()
            cfg = load_config()
            for key in EDITABLE_KEYS:
                if key in incoming:
                    cfg[key] = incoming[key]
            save_config(cfg)
            return self._json(cfg)
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path.startswith("/api/check"):
            if _check_state["running"]:
                return self._json({"started": False, "reason": "already running"})
            threading.Thread(target=run_check, daemon=True).start()
            return self._json({"started": True})
        self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    print(f"Dashboard: http://localhost:{PORT}   (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
