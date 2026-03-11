from http.server import BaseHTTPRequestHandler
import json
import subprocess


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            result = subprocess.run(
                ["python", "scripts/update_streams.py"],
                capture_output=True,
                text=True
            )

            response = {
                "status": "ok",
                "stdout": result.stdout,
                "stderr": result.stderr
            }

            self.send_response(200)

        except Exception as e:
            response = {"error": str(e)}
            self.send_response(500)

        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())