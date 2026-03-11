import json
import re
from pathlib import Path

DISCO_DIR = Path("discography")
SONG_DIR = Path("data/songs")

SONG_DIR.mkdir(parents=True, exist_ok=True)

def get_track_id(url):
    m = re.search(r"track/([A-Za-z0-9]+)", url)
    return m.group(1) if m else None

songs = {}

for file in DISCO_DIR.rglob("*.json"):
    data = json.loads(file.read_text(encoding="utf-8"))

    album = data.get("album")
    section = data.get("section")

    for track in data.get("tracks", []):
        title = track["title"]
        url = track["url"]

        track_id = get_track_id(url)
        if not track_id:
            continue

        if track_id not in songs:
            songs[track_id] = {
                "title": title,
                "spotify_url": url,
                "streams": None,
                "daily_streams": None,
                "last_updated": None,
                "appearances": []
            }

        songs[track_id]["appearances"].append({
            "album": album,
            "section": section
        })

for track_id, song in songs.items():
    slug = re.sub(r"[^a-z0-9]+", "_", song["title"].lower()).strip("_")
    path = SONG_DIR / f"{slug}.json"

    path.write_text(
        json.dumps(song, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )

print(f"{len(songs)} songs indexed")