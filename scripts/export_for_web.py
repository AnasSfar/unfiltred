from __future__ import annotations

import csv
import json
import re
import sqlite3
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

DB_PATH = ROOT / "data" / "songs.db"
HISTORY_CSV_PATH = ROOT / "data" / "history.csv"

DISCOGRAPHY_DIR = ROOT / "discography"
ALBUMS_DIR = DISCOGRAPHY_DIR / "albums"
MISC_DIR = DISCOGRAPHY_DIR / "misc"
COVERS_JSON_PATH = ALBUMS_DIR / "covers.json"

SITE_DATA_DIR = ROOT / "site" / "data"
SONGS_JSON_PATH = SITE_DATA_DIR / "songs.json"
ALBUMS_JSON_PATH = SITE_DATA_DIR / "albums.json"
HISTORY_JSON_PATH = SITE_DATA_DIR / "history.json"

TRACK_ID_RE = re.compile(r"track/([A-Za-z0-9]+)")

MILESTONES = [
    100_000_000,
    200_000_000,
    300_000_000,
    400_000_000,
    500_000_000,
    600_000_000,
    700_000_000,
    800_000_000,
    900_000_000,
    1_000_000_000,
    1_100_000_000,
    1_200_000_000,
    1_300_000_000,
    1_400_000_000,
    1_500_000_000,
    1_600_000_000,
    1_700_000_000,
    1_800_000_000,
    1_900_000_000,
    2_000_000_000,
    2_100_000_000,
    2_200_000_000,
    2_300_000_000,
    2_400_000_000,
    2_500_000_000,
    2_600_000_000,
    2_700_000_000,
    2_800_000_000,
    2_900_000_000,
    3_000_000_000,
    3_100_000_000,
    3_200_000_000,
    3_300_000_000,
    3_400_000_000,
    3_500_000_000,
]


def load_album_covers() -> dict:
    if not COVERS_JSON_PATH.exists():
        return {}
    with COVERS_JSON_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def extract_track_id(url: str | None) -> str | None:
    if not url:
        return None
    match = TRACK_ID_RE.search(url)
    return match.group(1) if match else None


def normalize_title_for_site(title: str) -> str:
    return (title or "").strip().casefold()


def format_milestone_label(value: int | None) -> str | None:
    if value is None:
        return None

    if value >= 1_000_000_000:
        b = value / 1_000_000_000
        return f"{int(b)}B" if b.is_integer() else f"{b:.1f}B"

    m = value / 1_000_000
    return f"{int(m)}M" if m.is_integer() else f"{m:.1f}M"


def current_milestone(streams: int | None) -> int | None:
    if streams is None:
        return None

    current = None
    for milestone in MILESTONES:
        if streams >= milestone:
            current = milestone
        else:
            break
    return current


def next_milestone(streams: int | None) -> int | None:
    if streams is None:
        return None

    for milestone in MILESTONES:
        if streams < milestone:
            return milestone

    x = MILESTONES[-1]
    while streams >= x:
        x += 100_000_000
    return x


def write_json(path: Path, payload) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_db_songs() -> list[dict]:
    if not DB_PATH.exists():
        raise FileNotFoundError(f"Database not found: {DB_PATH}")

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT
                track_id,
                title,
                spotify_url,
                image_url,
                streams,
                daily_streams,
                last_updated
            FROM songs
            ORDER BY title COLLATE NOCASE, track_id
            """
        ).fetchall()

    songs = []
    for row in rows:
        streams = row["streams"]
        current_ms = current_milestone(streams)
        next_ms = next_milestone(streams)
        remaining = None if streams is None or next_ms is None else max(next_ms - streams, 0)

        songs.append(
            {
                "track_id": row["track_id"],
                "title": row["title"],
                "title_key": normalize_title_for_site(row["title"]),
                "spotify_url": row["spotify_url"],
                "image_url": row["image_url"],
                "streams": row["streams"],
                "daily_streams": row["daily_streams"],
                "last_updated": row["last_updated"],
                "current_milestone": current_ms,
                "current_milestone_label": format_milestone_label(current_ms),
                "next_milestone": next_ms,
                "next_milestone_label": format_milestone_label(next_ms),
                "remaining_to_next_milestone": remaining,
                "appearances": [],
            }
        )

    return songs


def load_raw_history() -> tuple[list[str], dict[str, dict[str, dict]]]:
    if not HISTORY_CSV_PATH.exists():
        return [], {}

    by_date: dict[str, dict[str, dict]] = defaultdict(dict)

    with HISTORY_CSV_PATH.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)

        for row in reader:
            date_value = (row.get("date") or "").strip()
            track_id = (row.get("track_id") or "").strip()

            if not date_value or not track_id:
                continue

            streams_raw = (row.get("streams") or "").strip()
            daily_raw = (row.get("daily_streams") or "").strip()

            try:
                streams = int(streams_raw) if streams_raw else None
            except ValueError:
                streams = None

            try:
                daily_streams = int(daily_raw) if daily_raw else None
            except ValueError:
                daily_streams = None

            by_date[date_value][track_id] = {
                "streams": streams,
                "daily_streams": daily_streams,
            }

    return sorted(by_date.keys()), dict(by_date)


def history_count_by_track(raw_history_by_date: dict[str, dict[str, dict]]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)

    for _, day_data in raw_history_by_date.items():
        for track_id in day_data.keys():
            counts[track_id] += 1

    return dict(counts)


def choose_best_song(group: list[dict], counts: dict[str, int]) -> dict:
    def score(song: dict):
        main_count = sum(1 for app in song.get("appearances", []) if app.get("source_type") == "album")
        misc_count = sum(1 for app in song.get("appearances", []) if app.get("source_type") == "misc")
        return (
            main_count,
            counts.get(song["track_id"], 0),
            song["streams"] or 0,
            song["daily_streams"] or 0,
            1 if song.get("image_url") else 0,
            misc_count,
            song["track_id"],
        )

    return max(group, key=score)


def dedupe_songs_for_site(
    songs: list[dict],
    raw_history_by_date: dict[str, dict[str, dict]],
) -> tuple[list[dict], dict[str, str]]:
    counts = history_count_by_track(raw_history_by_date)

    groups: dict[str, list[dict]] = defaultdict(list)
    for song in songs:
        groups[song["title_key"]].append(song)

    deduped = []
    old_to_kept: dict[str, str] = {}

    for _, group in groups.items():
        if len(group) == 1:
            kept = dict(group[0])
            kept["merged_track_ids"] = [kept["track_id"]]
            deduped.append(kept)
            old_to_kept[kept["track_id"]] = kept["track_id"]
            continue

        kept = dict(choose_best_song(group, counts))
        merged_track_ids = [song["track_id"] for song in group]

        merged_appearances = []
        seen = set()
        for song in group:
            for app in song.get("appearances", []):
                key = (
                    app.get("source_type"),
                    app.get("album"),
                    app.get("section"),
                    app.get("group"),
                    app.get("edition"),
                    app.get("display_section"),
                    app.get("type"),
                )
                if key not in seen:
                    seen.add(key)
                    merged_appearances.append(app)

        kept["appearances"] = merged_appearances
        kept["merged_track_ids"] = merged_track_ids

        album_apps = [a for a in merged_appearances if a.get("source_type") == "album"]
        primary = album_apps[0] if album_apps else (merged_appearances[0] if merged_appearances else None)

        kept["primary_album"] = primary.get("album") if primary else None
        kept["primary_section"] = primary.get("section") if primary else None
        kept["type"] = primary.get("type") if primary else kept.get("type")
        kept["edition"] = primary.get("edition") if primary else kept.get("edition")
        kept["display_section"] = primary.get("display_section") if primary else kept.get("display_section")
        kept["display_order"] = primary.get("display_order") if primary else kept.get("display_order")
        kept["base_title"] = primary.get("base_title") if primary else kept.get("base_title")

        deduped.append(kept)

        for song in group:
            old_to_kept[song["track_id"]] = kept["track_id"]

    deduped.sort(key=lambda s: (s["title"].casefold(), s["track_id"]))
    return deduped, old_to_kept


def merge_history_by_kept_track(
    dates: list[str],
    raw_history_by_date: dict[str, dict[str, dict]],
    old_to_kept: dict[str, str],
) -> dict[str, dict[str, dict]]:
    merged: dict[str, dict[str, dict]] = {}

    for date_value in dates:
        merged[date_value] = {}
        buckets: dict[str, list[dict]] = defaultdict(list)

        for old_track_id, values in raw_history_by_date.get(date_value, {}).items():
            kept_track_id = old_to_kept.get(old_track_id, old_track_id)
            buckets[kept_track_id].append(values)

        for kept_track_id, entries in buckets.items():
            best = max(
                entries,
                key=lambda v: (
                    v.get("streams") is not None,
                    v.get("streams") or 0,
                    v.get("daily_streams") is not None,
                    v.get("daily_streams") or 0,
                ),
            )
            merged[date_value][kept_track_id] = {
                "streams": best.get("streams"),
                "daily_streams": best.get("daily_streams"),
            }

    return merged


def enrich_history_with_milestones(
    dates: list[str],
    by_date: dict[str, dict[str, dict]],
) -> dict[str, dict[str, dict]]:
    previous_streams_by_track: dict[str, int | None] = {}
    enriched: dict[str, dict[str, dict]] = {}

    for date_value in dates:
        enriched[date_value] = {}
        day_data = by_date.get(date_value, {})

        for track_id, values in day_data.items():
            streams = values.get("streams")
            daily_streams = values.get("daily_streams")
            prev_streams = previous_streams_by_track.get(track_id)

            curr_ms = current_milestone(streams)
            nxt_ms = next_milestone(streams)
            remaining = None if streams is None or nxt_ms is None else max(nxt_ms - streams, 0)

            crossed = None
            if streams is not None:
                prev_ms = current_milestone(prev_streams) if prev_streams is not None else None
                if curr_ms is not None:
                    if prev_ms is None and streams >= curr_ms:
                        crossed = curr_ms
                    elif prev_ms is not None and curr_ms > prev_ms:
                        crossed = curr_ms

            enriched[date_value][track_id] = {
                "streams": streams,
                "daily_streams": daily_streams,
                "current_milestone": curr_ms,
                "current_milestone_label": format_milestone_label(curr_ms),
                "next_milestone": nxt_ms,
                "next_milestone_label": format_milestone_label(nxt_ms),
                "remaining_to_next_milestone": remaining,
                "crossed_milestone_today": crossed,
                "crossed_milestone_today_label": format_milestone_label(crossed),
            }

            previous_streams_by_track[track_id] = streams

    return enriched


def add_ranks(songs: list[dict]) -> list[dict]:
    songs_copy = [dict(song) for song in songs]

    total_sorted = sorted(
        songs_copy,
        key=lambda s: (s.get("streams") is not None, s.get("streams") or 0, s["title"].casefold()),
        reverse=True,
    )
    daily_sorted = sorted(
        songs_copy,
        key=lambda s: (s.get("daily_streams") is not None, s.get("daily_streams") or 0, s["title"].casefold()),
        reverse=True,
    )

    rank_total = {song["track_id"]: i for i, song in enumerate(total_sorted, 1)}
    rank_daily = {song["track_id"]: i for i, song in enumerate(daily_sorted, 1)}

    for song in songs_copy:
        song["rank_total"] = rank_total.get(song["track_id"])
        song["rank_daily"] = rank_daily.get(song["track_id"])

    return songs_copy


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def build_discography_index() -> tuple[dict, list[dict]]:
    track_appearances_by_id: dict[str, list[dict]] = defaultdict(list)
    albums_payload: list[dict] = []
    album_map: dict[str, dict] = {}

    if ALBUMS_DIR.exists():
        for album_dir in sorted([p for p in ALBUMS_DIR.iterdir() if p.is_dir()], key=lambda p: p.name.casefold()):
            album_name = album_dir.name
            album_track_ids_ordered = []
            album_sections = []

            for json_file in sorted(album_dir.glob("*.json"), key=lambda p: p.name.casefold()):
                try:
                    data = read_json(json_file)
                except Exception:
                    continue

                file_tracks = []
                section_name = data.get("section") or json_file.stem

                for track in data.get("tracks", []):
                    track_id = extract_track_id(track.get("url") or track.get("spotify_url"))
                    if not track_id:
                        continue

                    track_type = track.get("type")
                    edition = track.get("edition")
                    display_section = track.get("display_section")
                    display_order = track.get("display_order")
                    base_title = track.get("base_title")

                    file_tracks.append(
                        {
                            "track_id": track_id,
                            "title": track.get("title"),
                            "type": track_type,
                            "edition": edition,
                            "display_section": display_section,
                            "display_order": display_order,
                            "base_title": base_title,
                            "section": section_name,
                            "source_file": json_file.name,
                        }
                    )
                    album_track_ids_ordered.append(track_id)

                    track_appearances_by_id[track_id].append(
                        {
                            "source_type": "album",
                            "album": album_name,
                            "section": section_name,
                            "group": None,
                            "source_path": str(json_file.relative_to(ROOT)),
                            "type": track_type,
                            "edition": edition,
                            "display_section": display_section,
                            "display_order": display_order,
                            "base_title": base_title,
                        }
                    )

                album_sections.append(
                    {
                        "name": section_name,
                        "file": json_file.name,
                        "tracks": file_tracks,
                        "track_ids": [t["track_id"] for t in file_tracks],
                        "track_count": len(file_tracks),
                    }
                )

            unique_ids = []
            seen = set()
            for tid in album_track_ids_ordered:
                if tid not in seen:
                    seen.add(tid)
                    unique_ids.append(tid)

            album_payload = {
                "album": album_name,
                "kind": "album",
                "sections": album_sections,
                "track_ids": unique_ids,
                "track_count": len(unique_ids),
            }

            albums_payload.append(album_payload)
            album_map[album_name] = album_payload

    misc_groups = []
    misc_all_track_ids = []

    if MISC_DIR.exists():
        for misc_group_dir in sorted([p for p in MISC_DIR.iterdir() if p.is_dir()], key=lambda p: p.name.casefold()):
            group_name = misc_group_dir.name
            group_sections = []
            group_track_ids = []

            for json_file in sorted(misc_group_dir.glob("*.json"), key=lambda p: p.name.casefold()):
                try:
                    data = read_json(json_file)
                except Exception:
                    continue

                section_name = data.get("section") or json_file.stem
                section_tracks = []

                for track in data.get("tracks", []):
                    track_id = extract_track_id(track.get("url") or track.get("spotify_url"))
                    if not track_id:
                        continue

                    track_type = track.get("type")
                    edition = track.get("edition")
                    display_section = track.get("display_section")
                    display_order = track.get("display_order")
                    base_title = track.get("base_title")

                    track_entry = {
                        "track_id": track_id,
                        "title": track.get("title"),
                        "type": track_type,
                        "edition": edition,
                        "display_section": display_section,
                        "display_order": display_order,
                        "base_title": base_title,
                        "section": section_name,
                        "source_file": json_file.name,
                    }

                    section_tracks.append(track_entry)
                    group_track_ids.append(track_id)
                    misc_all_track_ids.append(track_id)

                    track_appearances_by_id[track_id].append(
                        {
                            "source_type": "misc",
                            "album": "Misc",
                            "section": section_name,
                            "group": group_name,
                            "source_path": str(json_file.relative_to(ROOT)),
                            "type": track_type,
                            "edition": edition,
                            "display_section": display_section,
                            "display_order": display_order,
                            "base_title": base_title,
                        }
                    )

                    if group_name in album_map:
                        album_sections = album_map[group_name]["sections"]
                        existing_section = next(
                            (
                                s for s in album_sections
                                if s.get("name") == section_name and s.get("file") == json_file.name
                            ),
                            None,
                        )

                        if existing_section is None:
                            existing_section = {
                                "name": section_name,
                                "file": json_file.name,
                                "tracks": [],
                                "track_ids": [],
                                "track_count": 0,
                            }
                            album_sections.append(existing_section)

                        if track_id not in existing_section["track_ids"]:
                            existing_section["tracks"].append(track_entry)
                            existing_section["track_ids"].append(track_id)
                            existing_section["track_count"] = len(existing_section["track_ids"])

                        album_map[group_name]["track_ids"] = list(
                            dict.fromkeys(album_map[group_name]["track_ids"] + [track_id])
                        )
                        album_map[group_name]["track_count"] = len(album_map[group_name]["track_ids"])

                        track_appearances_by_id[track_id].append(
                            {
                                "source_type": "album",
                                "album": group_name,
                                "section": section_name,
                                "group": "misc",
                                "source_path": str(json_file.relative_to(ROOT)),
                                "type": track_type,
                                "edition": edition,
                                "display_section": display_section,
                                "display_order": display_order,
                                "base_title": base_title,
                            }
                        )

                group_sections.append(
                    {
                        "name": section_name,
                        "file": json_file.name,
                        "tracks": section_tracks,
                        "track_ids": [t["track_id"] for t in section_tracks],
                        "track_count": len(section_tracks),
                    }
                )

            unique_group_ids = []
            seen_group = set()
            for tid in group_track_ids:
                if tid not in seen_group:
                    seen_group.add(tid)
                    unique_group_ids.append(tid)

            misc_groups.append(
                {
                    "name": group_name,
                    "sections": group_sections,
                    "track_ids": unique_group_ids,
                    "track_count": len(unique_group_ids),
                }
            )

    if misc_groups:
        unique_misc_ids = []
        seen_misc = set()
        for tid in misc_all_track_ids:
            if tid not in seen_misc:
                seen_misc.add(tid)
                unique_misc_ids.append(tid)

        albums_payload.append(
            {
                "album": "Misc",
                "kind": "misc",
                "groups": misc_groups,
                "track_ids": unique_misc_ids,
                "track_count": len(unique_misc_ids),
            }
        )

    return dict(track_appearances_by_id), albums_payload


def group_album_tracks_for_display(album: dict, songs_by_id: dict[str, dict]) -> dict:
    if album.get("kind") != "album":
        return album

    all_entries = []

    for section in album.get("sections", []):
        for track in section.get("tracks", []):
            kept_id = track["track_id"]
            if kept_id not in songs_by_id:
                continue

            block_name = track.get("display_section") or track.get("edition") or "Other Editions"

            all_entries.append(
                {
                    "track_id": kept_id,
                    "title": songs_by_id[kept_id]["title"],
                    "display_section": block_name,
                    "display_order": track.get("display_order") if track.get("display_order") is not None else 999999,
                }
            )

    grouped = {}
    seen = set()

    for entry in sorted(
        all_entries,
        key=lambda x: (
            x["display_order"],
            (x["title"] or "").casefold(),
            x["track_id"],
        ),
    ):
        track_id = entry["track_id"]
        if track_id in seen:
            continue
        seen.add(track_id)

        block_name = entry["display_section"]
        grouped.setdefault(block_name, []).append(track_id)

    album["display_blocks"] = [
        {
            "key": name,
            "name": name,
            "track_ids": track_ids,
            "track_count": len(track_ids),
        }
        for name, track_ids in grouped.items()
    ]

    return album


def enrich_albums_payload(albums_payload: list[dict], songs_by_id: dict[str, dict]) -> list[dict]:
    out = []
    album_covers = load_album_covers()

    for album in albums_payload:
        track_ids = album.get("track_ids", [])
        tracks = [songs_by_id[tid] for tid in track_ids if tid in songs_by_id]

        album_name = album.get("album")
        cover_entry = album_covers.get(album_name, {})
        cover_url = cover_entry.get("cover_url")

        if not cover_url:
            cover_url = next((t.get("image_url") for t in tracks if t.get("image_url")), None)

        total_streams_sum = sum((t.get("streams") or 0) for t in tracks)
        daily_streams_sum = sum((t.get("daily_streams") or 0) for t in tracks)

        top_song_total = max(tracks, key=lambda t: t.get("streams") or 0)["track_id"] if tracks else None
        top_song_daily = max(tracks, key=lambda t: t.get("daily_streams") or 0)["track_id"] if tracks else None

        enriched = dict(album)
        enriched["image_url"] = cover_url
        enriched["total_streams_sum"] = total_streams_sum
        enriched["daily_streams_sum"] = daily_streams_sum
        enriched["top_song_total"] = top_song_total
        enriched["top_song_daily"] = top_song_daily

        if album.get("album") == "Misc":
            for group in enriched.get("groups", []):
                group_tracks = [songs_by_id[tid] for tid in group.get("track_ids", []) if tid in songs_by_id]
                group["image_url"] = next((t.get("image_url") for t in group_tracks if t.get("image_url")), None)
                group["total_streams_sum"] = sum((t.get("streams") or 0) for t in group_tracks)
                group["daily_streams_sum"] = sum((t.get("daily_streams") or 0) for t in group_tracks)
        else:
            enriched = group_album_tracks_for_display(enriched, songs_by_id)

        out.append(enriched)

    return out


def build_summary(
    songs: list[dict],
    albums: list[dict],
    dates: list[str],
    history_by_date: dict[str, dict[str, dict]],
) -> dict:
    latest_date = dates[-1] if dates else None
    latest_day = history_by_date.get(latest_date, {}) if latest_date else {}

    return {
        "total_songs": len(songs),
        "total_albums": len(albums),
        "songs_with_images": sum(1 for s in songs if s.get("image_url")),
        "songs_with_streams": sum(1 for s in songs if s.get("streams") is not None),
        "songs_with_daily_streams": sum(1 for s in songs if s.get("daily_streams") is not None),
        "history_dates_count": len(dates),
        "latest_date": latest_date,
        "songs_updated_on_latest_date": len(latest_day),
        "total_combined_streams": sum((s.get("streams") or 0) for s in songs),
        "milestones_crossed_on_latest_date": sum(
            1 for values in latest_day.values() if values.get("crossed_milestone_today") is not None
        ),
    }


def export_for_web() -> None:
    SITE_DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"ROOT = {ROOT}")
    print(f"DB_PATH = {DB_PATH}")
    print(f"HISTORY_CSV_PATH = {HISTORY_CSV_PATH}")
    raw_songs = load_db_songs()
    dates, raw_history_by_date = load_raw_history()
    print(f"ROOT = {ROOT}")
    print(f"HISTORY_CSV_PATH = {HISTORY_CSV_PATH}")
    print(f"HISTORY_JSON_PATH = {HISTORY_JSON_PATH}")
    print(f"Last 10 dates found: {dates[-10:]}")
    print(f"Rows on 2026-03-11: {len(raw_history_by_date.get('2026-03-11', {}))}")
    print(f"Last 10 dates found: {dates[-10:]}")
    print(f"Rows on 2026-03-10: {len(raw_history_by_date.get('2026-03-10', {}))}")
    track_appearances_by_id, albums_payload_raw = build_discography_index()

    for song in raw_songs:
        song["appearances"] = track_appearances_by_id.get(song["track_id"], [])

        album_apps = [a for a in song["appearances"] if a.get("source_type") == "album"]
        primary = album_apps[0] if album_apps else (song["appearances"][0] if song["appearances"] else None)

        song["primary_album"] = primary.get("album") if primary else None
        song["primary_section"] = primary.get("section") if primary else None
        song["type"] = primary.get("type") if primary else None
        song["edition"] = primary.get("edition") if primary else None
        song["display_section"] = primary.get("display_section") if primary else None
        song["display_order"] = primary.get("display_order") if primary else None
        song["base_title"] = primary.get("base_title") if primary else None

    deduped_songs, old_to_kept = dedupe_songs_for_site(raw_songs, raw_history_by_date)
    merged_history = merge_history_by_kept_track(dates, raw_history_by_date, old_to_kept)
    history_by_date = enrich_history_with_milestones(dates, merged_history)

    latest_date = dates[-1] if dates else None
    latest_values = history_by_date.get(latest_date, {})

    for song in deduped_songs:
        day = latest_values.get(song["track_id"])
        if day:
            song["streams"] = day.get("streams")
            song["daily_streams"] = day.get("daily_streams")
            song["current_milestone"] = day.get("current_milestone")
            song["current_milestone_label"] = day.get("current_milestone_label")
            song["next_milestone"] = day.get("next_milestone")
            song["next_milestone_label"] = day.get("next_milestone_label")
            song["remaining_to_next_milestone"] = day.get("remaining_to_next_milestone")

    deduped_songs = add_ranks(deduped_songs)
    songs_by_id = {song["track_id"]: song for song in deduped_songs}

    albums_payload_filtered = []
    for album in albums_payload_raw:
        filtered = dict(album)

        filtered["track_ids"] = list(
            dict.fromkeys(
                old_to_kept.get(tid, tid)
                for tid in album.get("track_ids", [])
                if old_to_kept.get(tid, tid) in songs_by_id
            )
        )
        filtered["track_count"] = len(filtered["track_ids"])

        if filtered.get("album") == "Misc":
            new_groups = []
            for group in filtered.get("groups", []):
                new_group = dict(group)
                new_group["track_ids"] = list(
                    dict.fromkeys(
                        old_to_kept.get(tid, tid)
                        for tid in group.get("track_ids", [])
                        if old_to_kept.get(tid, tid) in songs_by_id
                    )
                )
                new_group["track_count"] = len(new_group["track_ids"])

                new_sections = []
                for section in group.get("sections", []):
                    new_section = dict(section)
                    section_tracks = []

                    seen_ids = set()
                    for track in section.get("tracks", []):
                        kept_id = old_to_kept.get(track["track_id"], track["track_id"])
                        if kept_id not in songs_by_id or kept_id in seen_ids:
                            continue
                        seen_ids.add(kept_id)

                        new_track = dict(track)
                        new_track["track_id"] = kept_id
                        section_tracks.append(new_track)

                    new_section["tracks"] = section_tracks
                    new_section["track_ids"] = [t["track_id"] for t in section_tracks]
                    new_section["track_count"] = len(section_tracks)
                    new_sections.append(new_section)

                new_group["sections"] = new_sections
                new_groups.append(new_group)

            filtered["groups"] = new_groups

        else:
            new_sections = []
            for section in filtered.get("sections", []):
                new_section = dict(section)
                section_tracks = []

                seen_ids = set()
                for track in section.get("tracks", []):
                    kept_id = old_to_kept.get(track["track_id"], track["track_id"])
                    if kept_id not in songs_by_id or kept_id in seen_ids:
                        continue
                    seen_ids.add(kept_id)

                    new_track = dict(track)
                    new_track["track_id"] = kept_id
                    section_tracks.append(new_track)

                new_section["tracks"] = section_tracks
                new_section["track_ids"] = [t["track_id"] for t in section_tracks]
                new_section["track_count"] = len(section_tracks)
                new_sections.append(new_section)

            filtered["sections"] = new_sections

        albums_payload_filtered.append(filtered)

    albums_payload = enrich_albums_payload(albums_payload_filtered, songs_by_id)
    summary = build_summary(deduped_songs, albums_payload, dates, history_by_date)

    songs_payload = {
        "summary": summary,
        "songs": deduped_songs,
    }

    albums_payload_out = {
        "summary": {
            "total_albums": len(albums_payload),
            "latest_date": latest_date,
        },
        "albums": albums_payload,
    }

    history_payload = {
        "summary": {
            "latest_date": latest_date,
            "dates_count": len(dates),
        },
        "dates": dates,
        "by_date": history_by_date,
    }

    write_json(SONGS_JSON_PATH, songs_payload)
    write_json(ALBUMS_JSON_PATH, albums_payload_out)
    print(f"history latest_date to write = {latest_date}")
    print(f"history dates to write = {dates[-5:]}")
    write_json(HISTORY_JSON_PATH, history_payload)

    print(f"Exported songs:   {SONGS_JSON_PATH}")
    print(f"Exported albums:  {ALBUMS_JSON_PATH}")
    print(f"Exported history: {HISTORY_JSON_PATH}")
    print(f"Songs exported:   {len(deduped_songs)}")
    print(f"Albums exported:  {len(albums_payload)}")
    print(f"Dates exported:   {len(dates)}")


def main() -> None:
    export_for_web()


if __name__ == "__main__":
    main()