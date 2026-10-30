"""Заглушка внешних сервисов для смоука этапа 7: НБКР (GET /nbkr.xml — файл из 1-го аргумента)
и Telegram Bot API (POST /bot<token>/sendMessage — тело дописывается строкой в файл из 2-го аргумента)."""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

XML, LOG, PORT = sys.argv[1], sys.argv[2], int(sys.argv[3])


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/nbkr.xml"):
            return self._send(200, open(XML, "rb").read(), "application/xml")
        self._send(404, "{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode()
        if "/sendMessage" in self.path:
            with open(LOG, "a") as f:
                f.write(json.dumps(json.loads(body), ensure_ascii=False) + "\n")
            return self._send(200, '{"ok":true,"result":{}}')
        self._send(404, "{}")

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", PORT), H).serve_forever()
