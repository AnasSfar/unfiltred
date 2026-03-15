from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT  = _SCRIPT_DIR.parents[2]
ROOT        = _REPO_ROOT / "website"
DISCOGRAPHY_DIR = ROOT / "discography"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "songs.db"

DATA_DIR.mkdir(parents=True, exist_ok=True)

TRACK_ID_RE = re.compile(r"track/([A-Za-z0-9]+)")


def extract_track_id(url: str) -> str | None:
    if not url:
        return None
    match = TRACK_ID_RE.search(url)
    return match.group(1) if match else None


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    cols = conn.execute(f"PRAGMA table_info({table})").fetchall()
    col_names = {c[1] for c in cols}
    if column not in col_names:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def create_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS songs (
            track_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            spotify_url TEXT NOT NULL,
            image_url TEXT,
            streams INTEGER,
            daily_streams INTEGER,
            last_updated TEXT
        )
        """
    )

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS appearances (
            track_id TEXT NOT NULL,
            album TEXT NOT NULL,
            section TEXT NOT NULL,
            PRIMARY KEY (track_id, album, section),
            FOREIGN KEY (track_id) REFERENCES songs(track_id)
        )
        """
    )

    ensure_column(conn, "songs", "image_url", "TEXT")

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_appearances_track_id ON appearances(track_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_appearances_album ON appearances(album)"
    )


def init_db(conn: sqlite3.Connection) -> None:
    create_tables(conn)

    song_count = 0
    appearance_count = 0
    skipped_tracks = 0

    for json_file in sorted(DISCOGRAPHY_DIR.rglob("*.json")):
        data = load_json(json_file)

        album = (data.get("album") or "").strip()
        section = (data.get("section") or "").strip()

        if not album or not section:
            print(f"[WARN] album or section missing in {json_file}")
            continue

        tracks = data.get("tracks", [])
        if not isinstance(tracks, list):
            print(f"[WARN] invalid tracks list in {json_file}")
            continue

        for track in tracks:
            if not isinstance(track, dict):
                skipped_tracks += 1
                continue

            title = (track.get("title") or "").strip()
            spotify_url = (track.get("url") or track.get("spotify_url") or "").strip()

            if not title or not spotify_url:
                skipped_tracks += 1
                continue

            track_id = extract_track_id(spotify_url)
            if not track_id:
                print(f"[WARN] track id not found for URL in {json_file}: {spotify_url}")
                skipped_tracks += 1
                continue

            cur = conn.execute(
                """
                INSERT OR IGNORE INTO songs (
                    track_id, title, spotify_url, image_url, streams, daily_streams, last_updated
                )
                VALUES (?, ?, ?, NULL, NULL, NULL, NULL)
                """,
                (track_id, title, spotify_url),
            )
            if cur.rowcount > 0:
                song_count += 1

            conn.execute(
                """
                UPDATE songs
                SET title = COALESCE(NULLIF(title, ''), ?),
                    spotify_url = COALESCE(NULLIF(spotify_url, ''), ?)
                WHERE track_id = ?
                """,
                (title, spotify_url, track_id),
            )

            conn.execute(
                """
                INSERT OR IGNORE INTO appearances (track_id, album, section)
                VALUES (?, ?, ?)
                """,
                (track_id, album, section),
            )
            appearance_count += 1

    conn.commit()

    total_songs = conn.execute("SELECT COUNT(*) FROM songs").fetchone()[0]
    total_appearances = conn.execute("SELECT COUNT(*) FROM appearances").fetchone()[0]

    print(f"Database: {DB_PATH}")
    print(f"Songs inserted this run: {song_count}")
    print(f"Appearances processed this run: {appearance_count}")
    print(f"Skipped tracks: {skipped_tracks}")
    print(f"Total songs in DB: {total_songs}")
    print(f"Total appearances in DB: {total_appearances}")


def main() -> None:
    if not DISCOGRAPHY_DIR.exists():
        raise FileNotFoundError(f"discography folder not found: {DISCOGRAPHY_DIR}")

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        init_db(conn)


if __name__ == "__main__":
    main()