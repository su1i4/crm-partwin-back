"""Заглушка ocr-service для смоука: на любой POST отдаёт строки из файла (путь — 1-й аргумент)."""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LINES, PORT = sys.argv[1], int(sys.argv[2])


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        ok = b'name="file"' in body
        data = json.dumps({"lines": json.load(open(LINES)) if ok else [], "ms": 5}).encode()
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", PORT), H).serve_forever()
