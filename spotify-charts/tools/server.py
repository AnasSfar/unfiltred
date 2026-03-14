#!/usr/bin/env python3
"""
Lancer depuis tools/ :
  python server.py
Puis ouvrir http://localhost:8765 dans le navigateur.
"""
import json
import re
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

BASE = Path(__file__).parent.parent  # Spotify\

def find_dir(name):
    for candidate in [name, name.lower(), name.upper()]:
        p = BASE / candidate
        if p.is_dir():
            return p
    return None

FR_DIR     = find_dir('Fr')
GLOBAL_DIR = find_dir('Global')
FR_PATH     = (FR_DIR     / 'ts_history.json') if FR_DIR     else None
GLOBAL_PATH = (GLOBAL_DIR / 'ts_history.json') if GLOBAL_DIR else None

print(f"BASE      : {BASE}")
print(f"Fr        : {FR_PATH or 'INTROUVABLE'}")
print(f"Global    : {GLOBAL_PATH or 'INTROUVABLE'}")


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        p = self.path.split('?')[0]
        if p == '/save/comparaison':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
                filename = Path(data['filename']).name  # strip any path traversal
                content  = data['content']
                dest_dir = BASE / 'comparaisons'
                dest_dir.mkdir(exist_ok=True)
                (dest_dir / filename).write_text(content, encoding='utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(b'{"ok":true}')
                print(f"Comparaison sauvegardee : comparaisons/{filename}")
            except Exception as e:
                self.send_error(400, str(e))
        else:
            self.send_error(404)

    def do_GET(self):
        p = self.path.split('?')[0]  # strip query string

        if p == '/data/fr':
            self.serve_json(FR_PATH)
        elif p == '/data/global':
            self.serve_json(GLOBAL_PATH)
        elif p == '/data/fr/meta':
            self.serve_meta(FR_DIR)
        elif p == '/data/global/meta':
            self.serve_raw_json({})  # Global has no songs_db
        elif re.match(r'^/data/(fr|global)/tweet/\d{4}-\d{2}-\d{2}$', p):
            parts = p.split('/')
            src_name, date_str = parts[2], parts[4]
            self.serve_tweet(src_name, date_str)
        elif p == '/' or p == '/index.html':
            self.serve_file(BASE / 'ts_tracker.html', 'text/html')
        elif p == '/comparaison' or p == '/comparaison.html':
            self.serve_file(BASE / 'comparaison.html', 'text/html')
        else:
            self.send_error(404)

    def serve_json(self, path):
        if path is None or not path.exists():
            self.send_error(404, f'Fichier introuvable : {path}')
            return
        self._send_bytes(path.read_bytes(), 'application/json')

    def serve_raw_json(self, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self._send_bytes(data, 'application/json')

    def serve_meta(self, src_dir):
        """Song metadata (album, release_date) from songs_db.json — TS only."""
        if src_dir is None:
            self.serve_raw_json({})
            return
        db_path = src_dir / 'songs_db.json'
        if not db_path.exists():
            self.serve_raw_json({})
            return
        db = json.loads(db_path.read_text(encoding='utf-8'))
        meta = {}
        for key, val in db.items():
            if '|||' not in key:
                continue
            artist, track = key.split('|||', 1)
            if 'taylor swift' not in artist.lower():
                continue
            meta[track] = {
                'album': val.get('album', '') or '',
                'release_date': val.get('release_date', '') or '',
            }
        self.serve_raw_json(meta)

    def serve_tweet(self, src_name, date_str):
        """Serve tweet.txt for a given source and date."""
        src_dir = FR_DIR if src_name == 'fr' else GLOBAL_DIR
        if src_dir is None:
            self.send_error(404)
            return
        try:
            year, month, _ = date_str.split('-')
            tweet_path = src_dir / year / f"{int(month):02d}" / date_str / 'tweet.txt'
        except Exception:
            self.send_error(400)
            return
        if not tweet_path.exists():
            self.send_error(404)
            return
        self._send_bytes(tweet_path.read_bytes(), 'text/plain; charset=utf-8')

    def serve_file(self, path, mime):
        self._send_bytes(path.read_bytes(), mime)

    def _send_bytes(self, data, mime):
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        pass  # silencieux


if __name__ == '__main__':
    port = 8765
    print(f'TS Tracker -> http://localhost:{port}')
    HTTPServer(('localhost', port), Handler).serve_forever()
