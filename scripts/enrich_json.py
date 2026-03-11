import json
import re
import unicodedata
from pathlib import Path

DISCOGRAPHY_DIR = Path("discography")

FEATURE_REGEX = re.compile(
    r"\((?:feat\.|ft\.|featuring)\s+([^)]+)\)",
    re.IGNORECASE
)

VERSION_BLOCK_REGEX = re.compile(
    r"\((?:feat\.|ft\.|featuring|from the vault|taylor'?s version|deluxe|remix|acoustic|live|version|demo)[^)]+\)",
    re.IGNORECASE
)

SPLIT_REGEX = re.compile(r"\s*(?:,|&| x | and )\s*", re.IGNORECASE)


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def slugify(value: str) -> str:
    normalized = normalize_text(value)
    return normalized.replace(" ", "_")


def extract_featured_artists(title: str) -> list[str]:
    match = FEATURE_REGEX.search(title or "")
    if not match:
        return []

    raw = match.group(1).strip()
    parts = [p.strip() for p in SPLIT_REGEX.split(raw) if p.strip()]
    return parts


def clean_title(title: str) -> str:
    cleaned = FEATURE_REGEX.sub("", title or "").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned


def extract_version_tag(track: dict, title: str, title_clean: str, featured_artists: list[str]) -> str:
    type_value = str(track.get("type") or "").strip().lower()
    edition = str(track.get("edition") or "").strip().lower()
    display_section = str(track.get("display_section") or "").strip().lower()
    base_title = str(track.get("base_title") or "").strip()

    tags = []

    if featured_artists:
        tags.append("featured")

    if "remix" in title.lower() or "remix" in type_value or "remix" in display_section:
        tags.append("remix")

    if "acoustic" in title.lower() or "acoustic" in type_value:
        tags.append("acoustic")

    if "live" in title.lower() or "live" in type_value:
        tags.append("live")

    if "demo" in title.lower() or "demo" in type_value:
        tags.append("demo")

    if "deluxe" in edition or "deluxe" in display_section:
        tags.append("deluxe")

    if "vault" in title.lower() or "vault" in type_value:
        tags.append("vault")

    if "taylor's version" in title.lower() or "taylors version" in normalize_text(title):
        tags.append("taylors_version")

    if type_value and type_value not in {"song", "track"}:
        tags.append(type_value)

    if not tags:
        if title.strip() == title_clean.strip() and (not base_title or base_title.strip() == title.strip()):
            return "standard"
        return "alternate"

    seen = []
    for tag in tags:
        if tag not in seen:
            seen.append(tag)

    return "__".join(seen)


def build_song_family(track: dict, title_clean: str) -> str:
    album = str(track.get("album") or "").strip()
    base_title = str(track.get("base_title") or "").strip()

    family_source = title_clean or base_title or track.get("title") or ""
    return slugify(family_source)


def enrich_track(track: dict, album_name: str) -> dict:
    title = track.get("title", "").strip()
    featured_artists = extract_featured_artists(title)

    primary_artist = "Taylor Swift"
    artists = [primary_artist, *featured_artists]

    title_clean = clean_title(title)
    version_tag = extract_version_tag(track, title, title_clean, featured_artists)
    song_family = build_song_family(track, title_clean)

    track["album"] = track.get("album") or album_name
    track["primary_artist"] = primary_artist
    track["featured_artists"] = featured_artists
    track["artists"] = artists
    track["title_clean"] = title_clean
    track["song_family"] = song_family
    track["version_tag"] = version_tag

    return track


def process_file(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))

    tracks = data.get("tracks")
    if not isinstance(tracks, list):
        return

    album_name = str(data.get("album") or "").strip()

    for track in tracks:
        if isinstance(track, dict):
            enrich_track(track, album_name)

    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"Updated: {path}")


def main() -> None:
    files = sorted(DISCOGRAPHY_DIR.rglob("*.json"))
    for path in files:
        process_file(path)


if __name__ == "__main__":
    main()