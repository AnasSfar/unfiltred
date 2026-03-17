#!/usr/bin/env python3
"""
Détecte les tracks Taylor Swift présents sur kworb mais absents de notre DB,
et les ajoute dans songs.db + songs.json (section "kworb_extras").

Usage :
    python backfill_from_kworb.py
    python backfill_from_kworb.py --dry-run   # affiche sans écrire
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Dépendances manquantes : pip install requests beautifulsoup4")
    sys.exit(1)

# ── Paths ──────────────────────────────────────────────────────────────────────
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT  = _SCRIPT_DIR.parents[2]
DB_ROOT     = _REPO_ROOT / "db"

DB_PATH         = DB_ROOT / "songs.db"
DISCOGRAPHY_DIR = DB_ROOT / "discography"
SONGS_JSON_PATH = DISCOGRAPHY_DIR / "songs.json"

# ── Config ─────────────────────────────────────────────────────────────────────
ARTIST_ID       = "06HL4z0CvFAxyc27GXpf02"
KWORB_SONGS_URL = f"https://kworb.net/spotify/artist/{ARTIST_ID}_songs.html"
TRACK_ID_RE     = re.compile(r"spotify\.com/track/([A-Za-z0-9]+)")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}


# ── Helpers ────────────────────────────────────────────────────────────────────

def slugify(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text.lower())
    text = re.sub(r"[\s\-]+", "_", text.strip())
    return text


def fetch(url: str) -> str:
    r = requests.get(url, headers=HEADERS, timeout=20)
    r.raise_for_status()
    return r.text


# ── Parser ─────────────────────────────────────────────────────────────────────

def parse_songs_page(html: str) -> list[dict]:
    """
    Retourne une liste de { track_id, title, is_feature } depuis la page _songs.html.
    Les features ont un `*` devant le lien.
    """
    soup = BeautifulSoup(html, "html.parser")
    results = []
    seen = set()

    for a in soup.find_all("a", href=TRACK_ID_RE):
        m = TRACK_ID_RE.search(a["href"])
        if not m:
            continue
        track_id = m.group(1)
        if track_id in seen:
            continue
        seen.add(track_id)

        title = a.get_text(strip=True)
        # Détecte feature : le texte brut de la cellule parente commence par *
        parent_text = a.parent.get_text(strip=True) if a.parent else ""
        is_feature = parent_text.startswith("*")

        results.append({
            "track_id":   track_id,
            "title":      title,
            "is_feature": is_feature,
        })

    return results


# ── DB + JSON ──────────────────────────────────────────────────────────────────

def existing_track_ids(conn: sqlite3.Connection) -> set[str]:
    return {row[0] for row in conn.execute("SELECT track_id FROM songs")}


def existing_title_slugs(conn: sqlite3.Connection) -> set[str]:
    return {slugify(row[0]) for row in conn.execute("SELECT title FROM songs")}


def insert_track(conn: sqlite3.Connection, track: dict) -> None:
    spotify_url  = f"https://open.spotify.com/track/{track['track_id']}"
    primary      = "Taylor Swift"
    artists_json = json.dumps(["Taylor Swift"], ensure_ascii=False)

    conn.execute(
        """
        INSERT OR IGNORE INTO songs
            (track_id, title, spotify_url, image_url, streams, daily_streams,
             last_updated, primary_artist, artists_json)
        VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
        """,
        (track["track_id"], track["title"], spotify_url, primary, artists_json),
    )
    conn.execute(
        """
        INSERT OR IGNORE INTO appearances (track_id, album, section)
        VALUES (?, 'Standalone & Extras', 'kworb_extras')
        """,
        (track["track_id"],),
    )


def add_to_songs_json(new_tracks: list[dict]) -> int:
    data: list[dict] = json.loads(SONGS_JSON_PATH.read_text(encoding="utf-8"))

    # Cherche ou crée la section kworb_extras
    group = next(
        (g for g in data
         if g.get("album") == "Standalone & Extras"
         and g.get("section") == "kworb_extras"),
        None,
    )
    if group is None:
        group = {"album": "Standalone & Extras", "section": "kworb_extras",
                 "track_count": 0, "tracks": []}
        data.append(group)

    existing_ids = {
        m.group(1)
        for t in group["tracks"]
        if (m := TRACK_ID_RE.search(t.get("url", "")))
    }

    added = 0
    for track in new_tracks:
        if track["track_id"] in existing_ids:
            continue

        group["tracks"].append({
            "title":           track["title"],
            "url":             f"https://open.spotify.com/intl-fr/track/{track['track_id']}",
            "type":            "standalone",
            "edition":         "extras",
            "display_section": "Kworb Extras",
            "display_order":   9999,
            "base_title":      track["title"],
            "album":           "Standalone & Extras",
            "primary_artist":  "Taylor Swift",
            "featured_artists": [],
            "artists":         ["Taylor Swift"],
            "title_clean":     track["title"],
            "song_family":     slugify(track["title"]),
            "version_tag":     None,
        })
        existing_ids.add(track["track_id"])
        added += 1

    group["track_count"] = len(group["tracks"])
    SONGS_JSON_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return added


# ── Main ───────────────────────────────────────────────────────────────────────

def run(dry_run: bool) -> None:
    print(f"Récupération de {KWORB_SONGS_URL} …")
    html = fetch(KWORB_SONGS_URL)

    kworb_tracks = parse_songs_page(html)
    print(f"{len(kworb_tracks)} tracks trouvés sur kworb.\n")

    with sqlite3.connect(DB_PATH) as conn:
        known_ids    = existing_track_ids(conn)
        known_slugs  = existing_title_slugs(conn)

    new_tracks = [
        t for t in kworb_tracks
        if t["track_id"] not in known_ids
        and slugify(t["title"]) not in known_slugs
    ]

    if not new_tracks:
        print("Aucun track manquant. Notre DB est à jour.")
        return

    print(f"{len(new_tracks)} tracks manquants :")
    for t in new_tracks:
        feat = " [feature]" if t["is_feature"] else ""
        print(f"  + {t['title']}{feat}  ({t['track_id']})")

    if dry_run:
        print("\n[DRY-RUN] Aucune écriture.")
        return

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        for track in new_tracks:
            insert_track(conn, track)
        conn.commit()

    added = add_to_songs_json(new_tracks)

    print(f"\n{len(new_tracks)} tracks insérés dans songs.db")
    print(f"{added} tracks ajoutés à songs.json (section kworb_extras)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Détecte les tracks manquants depuis kworb")
    parser.add_argument("--dry-run", action="store_true", help="Simule sans écrire")
    args = parser.parse_args()
    run(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
