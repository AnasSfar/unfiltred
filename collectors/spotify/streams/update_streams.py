from __future__ import annotations

import csv
import json
import re
import subprocess
import threading
import time
import unicodedata
from datetime import date, timedelta
from pathlib import Path
from queue import Empty, Queue
import sys

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

import export_for_web

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.notify import send as notify

NTFY_TOPIC = "taylormuseum-streams"

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT  = _SCRIPT_DIR.parents[2]
ROOT        = _REPO_ROOT / "website"
DATA_DIR    = ROOT / "data"
_DB_ROOT    = _REPO_ROOT / "db"

HISTORY_PATH     = _DB_ROOT / "streams_history.csv"
FAILED_PATH      = DATA_DIR / "not_found_today.csv"
DISCOGRAPHY_DIR  = _DB_ROOT / "discography"
DB_ALBUMS_JSON   = DISCOGRAPHY_DIR / "albums.json"
DB_SONGS_JSON    = DISCOGRAPHY_DIR / "songs.json"
ARTIST_PATH      = DISCOGRAPHY_DIR / "artist.json"
ARTIST_URL = "https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02"

HEADLESS = False
MAX_PARALLEL_PAGES = 15
PAGE_GOTO_TIMEOUT_MS = 20_000
DEBUG_PAGE_PREVIEW = False

PROBE_TITLES = [
    "Cruel Summer",
    "Anti-Hero",
    "Blank Space",
    "Style",
    "cardigan",
]
MIN_SUCCESSFUL_PROBES = 2
MIN_UPDATED_PROBES_TO_START = 1

PENDING_RETRY_SLEEP_SECONDS = 5 * 60
MIN_PENDING_TRACKS_FOR_RETRY = 3
MAX_PENDING_RETRY_ROUNDS = 6
INCREMENTAL_PUBLISH_ON_UPDATE = False
EARLY_TWITTER_THRESHOLD = 50  # post Twitter dès que N tracks sont mises à jour

NOT_FOUND_STREAK_PATH = DATA_DIR / "not_found_streak.json"
MAX_NOT_FOUND_DAYS = 7  # suppress + delete after this many consecutive not-found days

START_TIME = None


def get_scrape_date_str() -> str:
    return date.today().isoformat()


def get_stats_date_str() -> str:
    return (date.today() - timedelta(days=1)).isoformat()


def format_int(value: int | None) -> str:
    if value is None:
        return "N/A"
    return f"{value:,}".replace(",", " ")


def parse_int_from_text(value: str | None) -> int | None:
    if not value:
        return None

    digits = re.sub(r"[^\d]", "", value)
    if not digits:
        return None

    try:
        return int(digits)
    except ValueError:
        return None


def extract_track_id(url: str | None) -> str | None:
    if not url:
        return None
    match = re.search(r"track/([A-Za-z0-9]+)", url)
    return match.group(1) if match else None


def normalize_spotify_track_url(url: str) -> str:
    track_id = extract_track_id(url)
    if track_id:
        return f"https://open.spotify.com/track/{track_id}"
    return url.strip()


def is_duration_line(text: str) -> bool:
    return bool(re.fullmatch(r"\d{1,2}:\d{2}", text.strip()))


def is_large_number_line(text: str) -> bool:
    cleaned = text.strip().replace("\u202f", " ").replace("\xa0", " ")
    if not re.fullmatch(r"[\d\s,.\']+", cleaned):
        return False
    value = parse_int_from_text(cleaned)
    return value is not None and value >= 1000


def normalize_title(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower().strip()
    value = value.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    value = re.sub(r"\s+", " ", value)
    return value


def extract_monthly_listeners_and_rank_from_text(text: str) -> tuple[int | None, int | None]:
    if not text:
        return None, None

    monthly_listeners = None
    monthly_rank = None
    text_compact = re.sub(r"\s+", " ", text).strip()

    monthly_patterns = [
        r"([\d\s.,]+)\s+monthly listeners",
        r"monthly listeners\s*[:\-]?\s*([\d\s.,]+)",
        r"([\d\s.,]+)\s+auditeurs mensuels",
        r"auditeurs mensuels\s*[:\-]?\s*([\d\s.,]+)",
    ]

    for pattern in monthly_patterns:
        match = re.search(pattern, text_compact, re.IGNORECASE)
        if match:
            monthly_listeners = parse_int_from_text(match.group(1))
            if monthly_listeners is not None:
                break

    rank_patterns = [
        r"#\s*([\d\s.,]+)\s+in the world",
        r"world\s*rank\s*[:\-]?\s*#?\s*([\d\s.,]+)",
        r"ranked\s*#\s*([\d\s.,]+)",
        r"#\s*([\d\s.,]+)\s+dans le monde",
    ]

    for pattern in rank_patterns:
        match = re.search(pattern, text_compact, re.IGNORECASE)
        if match:
            monthly_rank = parse_int_from_text(match.group(1))
            if monthly_rank is not None:
                break

    return monthly_listeners, monthly_rank


def block_unneeded(route):
    request = route.request
    url = request.url.lower()
    resource_type = request.resource_type

    blocked_resource_types = {"media", "font"}
    blocked_keywords = (
        "doubleclick",
        "googletagmanager",
        "google-analytics",
        "analytics",
        "facebook",
        "pixel",
        "ads",
        ".mp4",
        ".webm",
        ".mp3",
        ".wav",
        ".ogg",
        ".woff",
        ".woff2",
        ".ttf",
    )

    if resource_type in blocked_resource_types or any(x in url for x in blocked_keywords):
        route.abort()
    else:
        route.continue_()


def maybe_accept_cookies(page) -> None:
    patterns = [
        r"Accept",
        r"Accept all",
        r"Accepter",
        r"Autoriser",
    ]

    for pattern in patterns:
        try:
            page.get_by_role("button", name=re.compile(pattern, re.I)).click(timeout=1500)
            page.wait_for_timeout(800)
            return
        except Exception:
            pass


def launch_browser(playwright):
    return playwright.chromium.launch(
        headless=HEADLESS,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
        ],
    )


def extract_artist_image(page) -> str | None:
    selectors = [
        'img[alt="Taylor Swift"]',
        'img[src*="i.scdn.co"]',
        "img",
    ]

    for selector in selectors:
        try:
            loc = page.locator(selector)
            count = min(loc.count(), 12)
        except Exception:
            continue

        for i in range(count):
            try:
                src = (loc.nth(i).get_attribute("src") or "").strip()
                alt = (loc.nth(i).get_attribute("alt") or "").strip()
            except Exception:
                continue

            if not src:
                continue

            if "i.scdn.co" in src:
                if alt.lower() == "taylor swift" or selector != 'img[alt="Taylor Swift"]':
                    return src

    return None


def scrape_artist_metadata() -> dict:
    result = {
        "name": "Taylor Swift",
        "spotify_url": ARTIST_URL,
        "image_url": None,
        "monthly_listeners": None,
        "monthly_rank": None,
        "updated_at": get_scrape_date_str(),
    }

    p = sync_playwright().start()
    browser = launch_browser(p)
    context = browser.new_context(locale="fr-FR")
    page = context.new_page()
    page.route("**/*", block_unneeded)

    try:
        success = False

        for attempt in range(2):
            try:
                page.goto(ARTIST_URL, wait_until="commit", timeout=PAGE_GOTO_TIMEOUT_MS)
                page.wait_for_timeout(4000)
                maybe_accept_cookies(page)
                success = True
                break
            except PlaywrightTimeoutError:
                print(f"Artist page timeout ({attempt + 1}/2)")
                page.wait_for_timeout(2000)
            except Exception as e:
                print(f"Artist page error ({attempt + 1}/2): {e}")
                page.wait_for_timeout(2000)

        if not success:
            return result

        for wait_ms in (1000, 2000, 4000, 6000):
            page.wait_for_timeout(wait_ms)

            try:
                body_text = page.locator("body").inner_text(timeout=5000)
            except Exception:
                body_text = ""

            image_url = extract_artist_image(page)
            monthly_listeners, monthly_rank = extract_monthly_listeners_and_rank_from_text(body_text)

            if image_url:
                result["image_url"] = image_url
            if monthly_listeners is not None:
                result["monthly_listeners"] = monthly_listeners
            if monthly_rank is not None:
                result["monthly_rank"] = monthly_rank

            if result["image_url"] and result["monthly_listeners"] is not None:
                break

    finally:
        browser.close()
        p.stop()

    return result


def load_existing_artist_metadata() -> dict:
    if not ARTIST_PATH.exists():
        return {}

    try:
        return json.loads(ARTIST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_artist_metadata(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ARTIST_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def update_artist_metadata(pre_scraped: dict | None = None) -> dict:
    existing = load_existing_artist_metadata()
    scraped = pre_scraped if pre_scraped is not None else scrape_artist_metadata()

    merged = {
        "name": scraped.get("name") or existing.get("name") or "Taylor Swift",
        "spotify_url": scraped.get("spotify_url") or existing.get("spotify_url") or ARTIST_URL,
        "image_url": scraped.get("image_url") or existing.get("image_url"),
        "monthly_listeners": (
            scraped.get("monthly_listeners")
            if scraped.get("monthly_listeners") is not None
            else existing.get("monthly_listeners")
        ),
        "monthly_rank": (
            scraped.get("monthly_rank")
            if scraped.get("monthly_rank") is not None
            else existing.get("monthly_rank")
        ),
        "updated_at": get_scrape_date_str(),
    }

    save_artist_metadata(merged)

    print(
        "Artist metadata updated | "
        f"monthly_listeners={format_int(merged.get('monthly_listeners'))} | "
        f"rank={merged.get('monthly_rank') if merged.get('monthly_rank') is not None else 'N/A'}"
    )

    return merged




def load_active_track_ids_from_discography() -> set[str]:
    active_track_ids = set()

    for db_file in [DB_ALBUMS_JSON, DB_SONGS_JSON]:
        if not db_file.exists():
            continue
        try:
            sections = json.loads(db_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        for data in sections:
            for track in data.get("tracks", []):
                url = (track.get("url") or track.get("spotify_url") or "").strip()
                track_id = extract_track_id(url)
                if track_id:
                    active_track_ids.add(track_id)

    return active_track_ids


def ensure_history_file() -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)

    if not HISTORY_PATH.exists():
        with HISTORY_PATH.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["date", "track_id", "streams", "daily_streams"])


def append_history_row(row: list) -> None:
    with HISTORY_PATH.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(row)


def load_today_history_track_ids(stats_date: str) -> set[str]:
    if not HISTORY_PATH.exists():
        return set()

    done = set()
    with HISTORY_PATH.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)

        for row in reader:
            if row.get("date") != stats_date:
                continue

            track_id = row.get("track_id")
            if not track_id:
                continue

            daily_raw = (row.get("daily_streams") or "").strip()
            if not daily_raw:
                continue

            try:
                if int(daily_raw) > 0:
                    done.add(track_id)
            except ValueError:
                pass

    return done


def get_last_history_total(track_id: str) -> int | None:
    if not HISTORY_PATH.exists():
        return None

    last = None
    with HISTORY_PATH.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row.get("track_id") == track_id:
                try:
                    last = int(row["streams"])
                except Exception:
                    pass
    return last


MAX_DAILY_INCREASE = 50_000_000  # 50M streams/day is already extreme; more = scraping error

def has_real_update(previous_streams: int | None, new_streams: int) -> bool:
    if previous_streams is None:
        return True
    if new_streams <= previous_streams:
        return False
    if new_streams - previous_streams > MAX_DAILY_INCREASE:
        print(
            f"  [ANOMALY REJECTED] {new_streams:,} "
            f"(prev={previous_streams:,}, delta=+{new_streams - previous_streams:,}) "
            f"— exceeds {MAX_DAILY_INCREASE:,}/day cap, skipping"
        )
        return False
    return True


def load_tracks_from_discography(active_track_ids: set[str] | None = None) -> list[dict]:
    seen: dict[str, dict] = {}

    for db_file in [DB_ALBUMS_JSON, DB_SONGS_JSON]:
        if not db_file.exists():
            continue
        try:
            sections = json.loads(db_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        for section in sections:
            for track in section.get("tracks", []):
                url = (track.get("url") or track.get("spotify_url") or "").strip()
                track_id = extract_track_id(url)
                if not track_id or track_id in seen:
                    continue
                title = (track.get("title") or "").strip()
                if not title:
                    continue
                if active_track_ids is not None and track_id not in active_track_ids:
                    continue
                spotify_url = f"https://open.spotify.com/track/{track_id}"
                image_url = track.get("image_url") or None
                artists = track.get("artists") or []
                primary_artist = track.get("primary_artist") or (artists[0] if artists else None)
                seen[track_id] = {
                    "track_id": track_id,
                    "title": title,
                    "spotify_url": spotify_url,
                    "streams": None,
                    "daily_streams": None,
                    "last_updated": None,
                    "image_url": image_url,
                    "primary_artist": primary_artist,
                    "artists_json": json.dumps(artists),
                }

    tracks = list(seen.values())
    tracks.sort(key=lambda t: t["title"].casefold())
    return tracks


def build_track_lookup(tracks: list[dict]) -> dict[str, list[dict]]:
    lookup: dict[str, list[dict]] = {}
    for track in tracks:
        key = normalize_title(track["title"])
        lookup.setdefault(key, []).append(track)
    return lookup



def save_failed_rows(rows: list[dict]) -> None:
    if not rows:
        if FAILED_PATH.exists():
            FAILED_PATH.unlink()
        return

    with FAILED_PATH.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["title", "track_id", "spotify_url", "status"])
        for row in rows:
            writer.writerow(
                [
                    row["title"],
                    row["track_id"],
                    row.get("spotify_url", ""),
                    row.get("status", ""),
                ]
            )


def load_not_found_streak() -> dict:
    if not NOT_FOUND_STREAK_PATH.exists():
        return {}
    try:
        return json.loads(NOT_FOUND_STREAK_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_not_found_streak(streak: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    NOT_FOUND_STREAK_PATH.write_text(
        json.dumps(streak, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def update_not_found_streak(streak: dict, not_found_ids: set, updated_ids: set) -> None:
    for track_id in not_found_ids:
        streak[track_id] = streak.get(track_id, 0) + 1
    for track_id in updated_ids:
        streak.pop(track_id, None)




def remove_track_from_discography(track_id: str) -> int:
    """Remove a track from db/discography/albums.json and songs.json. Returns sections modified."""
    removed = 0
    for db_file in [DB_ALBUMS_JSON, DB_SONGS_JSON]:
        if not db_file.exists():
            continue
        try:
            sections = json.loads(db_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        changed = False
        for data in sections:
            tracks = data.get("tracks", [])
            new_tracks = [
                t for t in tracks
                if extract_track_id(t.get("url") or t.get("spotify_url") or "") != track_id
            ]
            if len(new_tracks) < len(tracks):
                data["tracks"] = new_tracks
                data["track_count"] = len(new_tracks)
                changed = True
                removed += 1
        if changed:
            db_file.write_text(
                json.dumps(sections, ensure_ascii=False, indent=2), encoding="utf-8"
            )
    return removed


def purge_stale_tracks(streak: dict, tracks: list[dict]) -> list[str]:
    """Remove tracks that have been not_found for MAX_NOT_FOUND_DAYS consecutive days from discography."""
    deleted = []
    for track_id, count in list(streak.items()):
        if count >= MAX_NOT_FOUND_DAYS:
            title = next(
                (t["title"] for t in tracks if t["track_id"] == track_id), track_id
            )
            print(
                f"AUTO-DELETE | {title} | track_id={track_id} | "
                f"not found for {count} consecutive days — removing from discography"
            )
            remove_track_from_discography(track_id)
            del streak[track_id]
            deleted.append(track_id)
    return deleted


def git_commit_and_push(message: str | None = None) -> None:
    try:
        subprocess.run(
            ["git", "add", "db/", "website/site/data/", "website/site/history/"],
            cwd=str(_REPO_ROOT), check=True,
        )
        diff = subprocess.run(
            ["git", "diff", "--cached", "--quiet"],
            cwd=str(_REPO_ROOT), check=False,
        )
        if diff.returncode == 0:
            print("No git changes to commit.")
            return

        msg = message or f"daily update {date.today().isoformat()}"
        subprocess.run(["git", "commit", "-m", msg], cwd=str(_REPO_ROOT), check=True)
        subprocess.run(["git", "push"], cwd=str(_REPO_ROOT), check=True)
        print("Git commit + push done.")
    except subprocess.CalledProcessError as e:
        print(f"Git commit/push failed: {e}")


def _load_track_priorities() -> dict[str, int]:
    """Retourne {track_id: max daily_streams} depuis l'historique pour trier les tracks."""
    result: dict[str, int] = {}
    if not HISTORY_PATH.exists():
        return result
    with HISTORY_PATH.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            tid = row.get("track_id", "")
            ds_raw = row.get("daily_streams", "")
            if tid and ds_raw:
                try:
                    ds = int(ds_raw)
                    if ds > result.get(tid, 0):
                        result[tid] = ds
                except ValueError:
                    pass
    return result


def _run_early_twitter(stats_date: str) -> None:
    try:
        print(f"\n[Twitter] Posting early top 15 after {EARLY_TWITTER_THRESHOLD} tracks done...")
        export_for_web.export_for_web()
        subprocess.run([sys.executable, str(_SCRIPT_DIR / "migrate_streams_to_csv.py")], check=False)
        subprocess.run([sys.executable, str(_SCRIPT_DIR / "post_streams_twitter.py"), stats_date], check=False)
        print("[Twitter] Early post done.")
    except Exception as e:
        print(f"[Twitter] Early post error: {e}")


def incremental_publish_update(
    track: dict,
    stats_date: str,
    publish_lock: threading.Lock,
) -> None:
    if not INCREMENTAL_PUBLISH_ON_UPDATE:
        return

    with publish_lock:
        try:
            print(
                f"Incremental publish | {track['title']} | "
                f"{track['track_id']} | stats_date={stats_date}"
            )
            export_for_web.export_for_web()
            git_commit_and_push(f"track update {stats_date} {track['track_id']}")
        except Exception as e:
            print(
                f"Incremental publish failed for {track['title']} "
                f"({track['track_id']}): {e}"
            )


def extract_main_track_playcount_from_lines(lines: list[str]) -> tuple[int | None, str | None]:
    if not lines:
        return None, None

    start_idx = None
    for i, line in enumerate(lines):
        if line.strip().lower() == "titre":
            start_idx = i
            break

    if start_idx is None:
        return None, None

    end_markers = {
        "connectez-vous",
        "se connecter",
        "artiste",
        "recommandés",
        "basees sur ce titre",
        "basées sur ce titre",
        "titres populaires par",
        "sorties populaires par taylor swift",
    }

    block: list[str] = []
    for line in lines[start_idx + 1:]:
        normalized = normalize_title(line.strip())
        if normalized in end_markers:
            break
        block.append(line.strip())

    if not block:
        return None, None

    for i, line in enumerate(block):
        if is_duration_line(line):
            for j in range(i + 1, min(i + 6, len(block))):
                candidate = block[j].strip()
                if candidate in {"•", "-", ""}:
                    continue
                if is_large_number_line(candidate):
                    value = parse_int_from_text(candidate)
                    if value is not None:
                        return value, candidate

    numeric_candidates = []
    for line in block:
        cleaned = line.strip()
        if is_large_number_line(cleaned):
            value = parse_int_from_text(cleaned)
            if value is not None:
                numeric_candidates.append((value, cleaned))

    if len(numeric_candidates) == 1:
        return numeric_candidates[0]

    return None, None


def extract_recommended_tracks_from_lines(lines: list[str]) -> list[dict]:
    if not lines:
        return []

    start_idx = None
    for i, line in enumerate(lines):
        normalized = normalize_title(line)
        if normalized == "recommandes":
            start_idx = i
            break

    if start_idx is None:
        return []

    block: list[str] = []
    end_markers = {
        "titres populaires par",
        "sorties populaires par taylor swift",
        "sorties populaires par",
        "afficher plus",
    }

    for line in lines[start_idx + 1:]:
        normalized = normalize_title(line)
        if normalized in end_markers:
            break
        block.append(line.strip())

    if not block:
        return []

    results: list[dict] = []
    i = 0
    while i < len(block):
        title = block[i].strip()
        norm_title = normalize_title(title)

        if (
            not title
            or norm_title in {"basees sur ce titre", "basées sur ce titre", "e", "taylor swift"}
            or title in {"•", "-", "..."}
            or is_large_number_line(title)
            or is_duration_line(title)
            or title.isdigit()
        ):
            i += 1
            continue

        found_streams = None
        found_duration = None

        for j in range(i + 1, min(i + 8, len(block))):
            candidate = block[j].strip()

            if is_large_number_line(candidate) and found_streams is None:
                found_streams = parse_int_from_text(candidate)
                continue

            if is_duration_line(candidate) and found_duration is None:
                found_duration = candidate

            if found_streams is not None and found_duration is not None:
                break

        if found_streams is not None:
            results.append(
                {
                    "title": title,
                    "streams": found_streams,
                    "duration": found_duration,
                }
            )

        i += 1

    deduped = []
    seen = set()
    for row in results:
        key = normalize_title(row["title"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)

    return deduped


def extract_page_data(page) -> tuple[int | None, str | None, list[dict]]:
    try:
        body_text = page.locator("body").inner_text(timeout=5000)
    except Exception:
        return None, None, []

    if not body_text:
        return None, None, []

    lines = [
        line.replace("\u202f", " ").replace("\xa0", " ").strip()
        for line in body_text.splitlines()
    ]
    lines = [line for line in lines if line]

    total, raw = extract_main_track_playcount_from_lines(lines)
    recs = extract_recommended_tracks_from_lines(lines)
    return total, raw, recs


def debug_page_preview(page, title: str, url: str) -> None:
    if not DEBUG_PAGE_PREVIEW:
        return

    try:
        body_text = page.locator("body").inner_text(timeout=5000)
    except Exception:
        body_text = ""

    try:
        page_title = page.title()
    except Exception:
        page_title = ""

    print()
    print("=" * 80)
    print(f"TRACK: {title}")
    print(f"URL asked: {url}")
    print(f"URL final: {page.url}")
    print(f"PAGE TITLE: {page_title}")
    print("BODY PREVIEW:")
    print(body_text[:2500])
    print("=" * 80)
    print()


def scrape_track_total(page, title: str, url: str) -> tuple[int | None, str | None, str, list[dict]]:
    clean_url = normalize_spotify_track_url(url)

    for attempt in range(3):
        try:
            page.goto(clean_url, wait_until="commit", timeout=PAGE_GOTO_TIMEOUT_MS)
            page.wait_for_timeout(500)
            maybe_accept_cookies(page)

            if DEBUG_PAGE_PREVIEW:
                debug_page_preview(page, title, clean_url)

            for wait_ms in (500, 1000, 2000):
                total, raw, recs = extract_page_data(page)
                if total is not None:
                    return total, raw, "ok", recs
                page.wait_for_timeout(wait_ms)

            return None, None, "not_found", []

        except PlaywrightTimeoutError:
            print(f"SCRAPE TIMEOUT on {title}: {clean_url} (attempt {attempt + 1}/3)")
            try:
                page.wait_for_timeout(1500)
            except Exception:
                pass

        except Exception as e:
            print(f"SCRAPE ERROR on {title}: {e} (attempt {attempt + 1}/3)")
            try:
                page.wait_for_timeout(1000)
            except Exception:
                pass

    return None, None, "timeout", []



def compute_daily(previous_streams: int | None, new_streams: int) -> int | None:
    if previous_streams is None:
        return None

    diff = new_streams - previous_streams
    if diff < 0:
        return None

    return diff


def try_apply_track_update(
    track: dict,
    total: int,
    scrape_date: str,
    stats_date: str,
    lock: threading.Lock,
    publish_lock: threading.Lock,
    debug_mode: bool = False,
) -> dict:
    track_id = track["track_id"]
    last_total = get_last_history_total(track_id)
    daily = compute_daily(last_total, total)
    real_update = has_real_update(last_total, total)

    # En mode debug on ne touche pas à streams_history — on veut juste
    # peupler le CSV sans polluer les dates avant l'update officiel Spotify.
    if not debug_mode and (real_update or last_total is None):
        row = [stats_date, track_id, total, daily if daily is not None else ""]
        with lock:
            append_history_row(row)

        status = "updated"

        incremental_publish_update(
            track=track,
            stats_date=stats_date,
            publish_lock=publish_lock,
        )
    else:
        status = "pending"

    return {
        "track_id": track_id,
        "title": track["title"],
        "spotify_url": track["spotify_url"],
        "status": status,
        "streams": total,
        "daily_streams": daily,
    }



def live_progress(i, total, title, result):
    elapsed = time.perf_counter() - START_TIME if START_TIME else 0

    done = max(i - 1, 0) if result is None else i
    remaining = ((elapsed / done) * max(total - done, 0)) if done > 0 else 0
    eta = f"{int(remaining // 60)}m {int(remaining % 60)}s"
    prefix = f"[{i}/{total}] {title}"

    if result is None:
        print(f"{prefix} ... scraping | ETA {eta}")
        return

    status = result.get("status")

    if status == "updated":
        print(
            f"{prefix} OK | total={format_int(result.get('streams'))} | "
            f"daily={format_int(result.get('daily_streams'))} | ETA {eta}"
        )
    elif status == "pending":
        print(
            f"{prefix} PENDING | total={format_int(result.get('streams'))} | "
            f"no new streams yet | ETA {eta}"
        )
    elif status == "skipped":
        print(f"{prefix} SKIPPED | ETA {eta}")
    elif status == "timeout":
        print(f"{prefix} TIMEOUT | ETA {eta}")
    elif status == "error":
        print(f"{prefix} ERROR | ETA {eta}")
    elif status == "not_found":
        print(f"{prefix} NOT FOUND | ETA {eta}")
    else:
        print(f"{prefix} {status.upper()} | ETA {eta}")


def _probe_on_page(probe_tracks: list[dict], page) -> dict:
    results = []
    successful_probes = 0
    updated_probes = 0

    for track in probe_tracks:
        title = track["title"]
        url = track["spotify_url"]
        total, raw, scrape_status, _ = scrape_track_total(page, title, url)

        if scrape_status == "ok" and total is not None:
            successful_probes += 1
            last_total = get_last_history_total(track["track_id"])
            updated = has_real_update(last_total, total)
            if updated:
                updated_probes += 1

            results.append(
                {
                    "title": title,
                    "status": "ok",
                    "streams": total,
                    "previous_streams": last_total,
                    "updated": updated,
                    "raw": raw,
                }
            )
        else:
            results.append(
                {
                    "title": title,
                    "status": scrape_status,
                    "streams": None,
                    "previous_streams": get_last_history_total(track["track_id"]),
                    "updated": False,
                    "raw": None,
                }
            )

    can_start_full_run = (
        successful_probes >= MIN_SUCCESSFUL_PROBES
        and updated_probes >= MIN_UPDATED_PROBES_TO_START
    )

    return {
        "can_start_full_run": can_start_full_run,
        "successful_probes": successful_probes,
        "updated_probes": updated_probes,
        "results": results,
    }


def run_probe(tracks: list[dict]) -> dict:
    track_lookup = build_track_lookup(tracks)
    probe_tracks: list[dict] = []

    for title in PROBE_TITLES:
        matches = track_lookup.get(normalize_title(title), [])
        if len(matches) == 1:
            probe_tracks.append(matches[0])

    if not probe_tracks:
        print("Probe skipped: no probe tracks found in database.")
        return {
            "can_start_full_run": True,
            "successful_probes": 0,
            "updated_probes": 0,
            "results": [],
        }

    p = sync_playwright().start()
    browser = launch_browser(p)
    context = browser.new_context(locale="fr-FR")
    page = context.new_page()
    page.route("**/*", block_unneeded)

    try:
        return _probe_on_page(probe_tracks, page)
    finally:
        browser.close()
        p.stop()


def _worker(
    queue,
    results,
    failed_results,
    lock,
    publish_lock,
    on_progress,
    total_tracks,
    debug_mode=False,
    early_twitter_trigger=None,
):
    p = sync_playwright().start()
    browser = launch_browser(p)
    context = browser.new_context(locale="fr-FR")
    page = context.new_page()
    page.route("**/*", block_unneeded)

    try:
        while True:
            try:
                item = queue.get_nowait()
            except Empty:
                break

            i = item["index"]
            track = item["track"]
            scrape_date = item["scrape_date"]
            stats_date = item["stats_date"]
            log_title = f"{track['title']} [{track['track_id'][-6:]}]"

            if on_progress:
                on_progress(i, total_tracks, log_title, None)

            total, raw, scrape_status, _ = scrape_track_total(
                page, track["title"], track["spotify_url"]
            )

            if scrape_status == "timeout":
                result = {
                    "track_id": track["track_id"],
                    "title": track["title"],
                    "spotify_url": track["spotify_url"],
                    "status": "timeout",
                }
                with lock:
                    failed_results.append(dict(result))

            elif scrape_status == "error":
                result = {
                    "track_id": track["track_id"],
                    "title": track["title"],
                    "spotify_url": track["spotify_url"],
                    "status": "error",
                }
                with lock:
                    failed_results.append(dict(result))

            elif scrape_status == "not_found" or total is None:
                result = {
                    "track_id": track["track_id"],
                    "title": track["title"],
                    "spotify_url": track["spotify_url"],
                    "status": "not_found",
                }
                with lock:
                    failed_results.append(dict(result))

            else:
                result = try_apply_track_update(
                    track=track,
                    total=total,
                    scrape_date=scrape_date,
                    stats_date=stats_date,
                    lock=lock,
                    publish_lock=publish_lock,
                    debug_mode=debug_mode,
                )
                result["raw"] = raw
                if early_twitter_trigger:
                    early_twitter_trigger()

            with lock:
                results[i - 1] = result

            if on_progress:
                on_progress(i, total_tracks, log_title, result)

            queue.task_done()

    finally:
        print("Worker finished.")
        try:
            browser.close()
        except Exception:
            pass
        try:
            p.stop()
        except Exception:
            pass


def run_update(on_progress=None, skip_track_ids: set | None = None, stats_date_override: str | None = None, debug_mode: bool = False):
    ensure_history_file()

    scrape_date = get_scrape_date_str()
    stats_date = stats_date_override or get_stats_date_str()

    skip_track_ids = skip_track_ids or set()

    active_track_ids = load_active_track_ids_from_discography()
    tracks = load_tracks_from_discography(active_track_ids)
    total_tracks = len(tracks)

    # Trier par popularité : les tracks avec le plus de daily_streams en premier
    priorities = _load_track_priorities()
    tracks.sort(key=lambda t: -priorities.get(t["track_id"], 0))

    # Trigger pour poster le top 15 tôt, dès EARLY_TWITTER_THRESHOLD tracks mises à jour
    _early_fired = threading.Event()
    _counter = [0]
    _counter_lock = threading.Lock()

    def early_twitter_trigger():
        if _early_fired.is_set():
            return
        with _counter_lock:
            _counter[0] += 1
            if _counter[0] < EARLY_TWITTER_THRESHOLD or _early_fired.is_set():
                return
            _early_fired.set()
        threading.Thread(target=_run_early_twitter, args=(stats_date,), daemon=True).start()

    already_done_for_stats_date = load_today_history_track_ids(stats_date)

    queue = Queue()
    failed_results: list[dict] = []
    results = [None] * total_tracks

    for index, track in enumerate(tracks, 1):
        log_title = f"{track['title']} [{track['track_id'][-6:]}]"
        if track["track_id"] in already_done_for_stats_date or track["track_id"] in skip_track_ids:
            results[index - 1] = {
                "track_id": track["track_id"],
                "title": track["title"],
                "spotify_url": track["spotify_url"],
                "status": "skipped",
            }
            if on_progress:
                on_progress(index, total_tracks, log_title, results[index - 1])
            continue

        queue.put({
            "index": index,
            "track": track,
            "scrape_date": scrape_date,
            "stats_date": stats_date,
        })

    if queue.qsize() > 0:
        lock = threading.Lock()
        publish_lock = threading.Lock()
        worker_count = min(MAX_PARALLEL_PAGES, queue.qsize())

        workers = [
            threading.Thread(
                target=_worker,
                args=(
                    queue,
                    results,
                    failed_results,
                    lock,
                    publish_lock,
                    on_progress,
                    total_tracks,
                    debug_mode,
                    early_twitter_trigger if not debug_mode else None,
                ),
                daemon=True,
            )
            for _ in range(worker_count)
        ]

        for w in workers:
            w.start()

        print(f"Waiting for {worker_count} worker(s) to finish...")
        queue.join()
        for w in workers:
            w.join(timeout=5)
        print("All worker threads joined.")

    final_done_for_stats_date = load_today_history_track_ids(stats_date)
    filtered_results = [r for r in results if r is not None]

    return {
        "scrape_date": scrape_date,
        "stats_date": stats_date,
        "total_tracks": total_tracks,
        "done_tracks": len(final_done_for_stats_date),
        "remaining_tracks": max(total_tracks - len(final_done_for_stats_date), 0),
        "all_done": len(final_done_for_stats_date) >= total_tracks,
        "updated_this_run": sum(1 for r in filtered_results if r["status"] == "updated"),
        "pending_this_run": sum(1 for r in filtered_results if r["status"] == "pending"),
        "skipped_this_run": sum(1 for r in filtered_results if r["status"] == "skipped"),
        "timeout_this_run": len([r for r in failed_results if r["status"] == "timeout"]),
        "error_this_run": len([r for r in failed_results if r["status"] == "error"]),
        "not_found_this_run": len([r for r in failed_results if r["status"] == "not_found"]),
        "results": filtered_results,
        "failed_results": failed_results,
    }


def get_update_state_for_stats_date() -> tuple[int, int]:
    stats_date = get_stats_date_str()
    active_track_ids = load_active_track_ids_from_discography()
    total_tracks = len(load_tracks_from_discography(active_track_ids))
    done_tracks = len(load_today_history_track_ids(stats_date))
    return done_tracks, total_tracks


def print_remaining_details(summary: dict) -> None:
    print()
    print("Tracks still not done for this stats date:")

    remaining_details = []

    for r in summary["results"]:
        if r["status"] == "pending":
            remaining_details.append(
                f"PENDING | {r['title']} | {r.get('track_id', '')} | "
                f"total={format_int(r.get('streams'))} | "
                f"daily={format_int(r.get('daily_streams'))}"
            )

    for r in summary["failed_results"]:
        if r["status"] in {"not_found", "timeout", "error"}:
            remaining_details.append(
                f"{r['status'].upper()} | {r['title']} | "
                f"{r.get('track_id', '')} | {r.get('spotify_url', '')}"
            )

    if remaining_details:
        for line in remaining_details:
            print(line)
    else:
        print("None.")


def print_summary_block(summary: dict) -> None:
    print()
    print(
        f"Progress {summary['stats_date']}: "
        f"{summary['done_tracks']}/{summary['total_tracks']} "
        f"| remaining={summary['remaining_tracks']} "
        f"| pending={summary['pending_this_run']} "
        f"| timeout={summary['timeout_this_run']} "
        f"| error={summary['error_this_run']} "
        f"| not_found={summary['not_found_this_run']}"
    )


def main():
    global START_TIME
    START_TIME = time.perf_counter()

    ensure_history_file()

    # ── Argument parsing ───────────────────────────────────────────────────────
    # Usage:
    #   python update_streams.py                   → run normal (with probe)
    #   python update_streams.py 2025-10-02        → force stats date
    #   python update_streams.py --debug           → skip probe, use today's date
    #   python update_streams.py --debug 2025-10-02 → skip probe, force date
    #   python update_streams.py --dry-run         → scrape only, zéro modification
    debug_mode = "--debug" in sys.argv
    dry_run_mode = "--dry-run" in sys.argv
    remaining_args = [a for a in sys.argv[1:] if a not in ("--debug", "--dry-run")]

    stats_date_override = None
    if remaining_args:
        try:
            date.fromisoformat(remaining_args[0])
            stats_date_override = remaining_args[0]
        except ValueError:
            print(f"Invalid date '{remaining_args[0]}', expected YYYY-MM-DD")
            sys.exit(1)

    if dry_run_mode:
        print("[DRY-RUN] Scraping uniquement — aucune modification (CSV, git, Twitter)")
        debug_mode = True  # réutilise la logique debug pour skip les writes CSV
    elif debug_mode:
        print("[DEBUG] Mode debug activé — probe désactivé, pas de date associée")

    stats_date = stats_date_override or get_stats_date_str()
    print(f"Target stats date: {stats_date}")

    # Discover new kworbs extras before loading the track list
    print("Checking kworbs for new extra tracks...")
    try:
        _backfill_cmd = [sys.executable, str(_SCRIPT_DIR / "backfill_from_kworb.py")]
        if dry_run_mode:
            _backfill_cmd.append("--dry-run")
        subprocess.run(_backfill_cmd, check=False)
    except Exception as e:
        print(f"Kworbs backfill failed (non-fatal): {e}")

    active_track_ids = load_active_track_ids_from_discography()
    tracks = load_tracks_from_discography(active_track_ids)

    already_done_for_stats_date = set() if debug_mode else load_today_history_track_ids(stats_date)
    done_tracks_before_run = len(already_done_for_stats_date)
    total_tracks = len(tracks)

    if debug_mode:
        print(f"[DEBUG] Scraping {total_tracks} tracks (aucune date associée)")
    else:
        print(f"Current progress for {stats_date}: {done_tracks_before_run}/{total_tracks}")

    should_run_probe = done_tracks_before_run == 0 and stats_date_override is None and not debug_mode

    if should_run_probe:
        track_lookup = build_track_lookup(tracks)
        probe_tracks: list[dict] = []
        for title in PROBE_TITLES:
            matches = track_lookup.get(normalize_title(title), [])
            if len(matches) == 1:
                probe_tracks.append(matches[0])

        if not probe_tracks:
            print("Probe skipped: no probe tracks found in database.")
        else:
            _p = sync_playwright().start()
            _browser = launch_browser(_p)
            _context = _browser.new_context(locale="fr-FR")
            _page = _context.new_page()
            _page.route("**/*", block_unneeded)

            try:
                while True:
                    print("Running probe check...")

                    probe = _probe_on_page(probe_tracks, _page)

                    print(
                        f"Probe result | successful={probe['successful_probes']} | "
                        f"updated={probe['updated_probes']} | "
                        f"start_full_run={probe['can_start_full_run']}"
                    )

                    for row in probe["results"]:
                        if row["status"] == "ok":
                            print(
                                f"PROBE {row['title']} | "
                                f"current={format_int(row['streams'])} | "
                                f"previous={format_int(row['previous_streams'])} | "
                                f"updated={'yes' if row['updated'] else 'no'}"
                            )
                        else:
                            print(f"PROBE {row['title']} | status={row['status']}")

                    if probe["can_start_full_run"]:
                        break

                    print()
                    print("Spotify does not appear to have started the next daily update yet.")
                    print("Retrying in 1 minute...")
                    time.sleep(60)
            finally:
                _browser.close()
                _p.stop()
    elif done_tracks_before_run < total_tracks:
        print("Partial progress already exists for this stats date.")
        print("Skipping probe and resuming unfinished tracks.")
    else:
        print("All tracks already appear done for this stats date.")
        print("Skipping probe and refreshing export/publish anyway.")

    print()
    print("=" * 70)
    print("Full run")
    print("=" * 70)

    _artist_result: list[dict | None] = [None]

    def _scrape_artist_bg():
        _artist_result[0] = scrape_artist_metadata()

    artist_thread = threading.Thread(target=_scrape_artist_bg, daemon=True)
    artist_thread.start()

    summary = run_update(on_progress=live_progress, stats_date_override=stats_date_override, debug_mode=debug_mode)
    print_summary_block(summary)

    # Accumulate not_found track IDs so retries skip them entirely
    not_found_ids: set[str] = {
        r["track_id"] for r in summary["failed_results"] if r["status"] == "not_found"
    }

    retry_round = 0
    while (
        not debug_mode
        and not summary["all_done"]
        and summary["pending_this_run"] > summary["total_tracks"] // 2
        and retry_round < MAX_PENDING_RETRY_ROUNDS
    ):
        retry_round += 1

        print()
        print(
            f"Detected {summary['pending_this_run']} unchanged track(s) "
            f"for {summary['stats_date']}."
        )
        if not_found_ids:
            print(f"Skipping {len(not_found_ids)} not-found track(s) on this retry.")

        print("Committing partial progress before retry...")
        git_commit_and_push(f"partial export {summary['stats_date']} (before retry {retry_round})")

        print(
            f"Waiting {PENDING_RETRY_SLEEP_SECONDS // 60} minutes before retry "
            f"({retry_round}/{MAX_PENDING_RETRY_ROUNDS})..."
        )
        time.sleep(PENDING_RETRY_SLEEP_SECONDS)

        print()
        print("=" * 70)
        print(f"Retry round {retry_round}")
        print("=" * 70)

        summary = run_update(on_progress=live_progress, skip_track_ids=not_found_ids, stats_date_override=stats_date_override)
        not_found_ids.update(
            r["track_id"] for r in summary["failed_results"] if r["status"] == "not_found"
        )
        print_summary_block(summary)

    print_remaining_details(summary)

    save_failed_rows(summary["failed_results"])

    # Update per-track not-found streak and auto-delete tracks missing too many days
    all_tracks = load_tracks_from_discography()
    updated_ids: set[str] = {
        r["track_id"] for r in summary.get("results", [])
        if r and r.get("status") == "updated"
    }
    streak = load_not_found_streak()
    update_not_found_streak(streak, not_found_ids, updated_ids)
    deleted = purge_stale_tracks(streak, all_tracks)
    if deleted:
        print(f"Auto-deleted {len(deleted)} stale track(s) not found for {MAX_NOT_FOUND_DAYS}+ days.")
    save_not_found_streak(streak)

    if dry_run_mode:
        print("[DRY-RUN] Scraping terminé — aucune modification appliquée.")
        return

    if summary["all_done"]:
        print("All tracks updated.")
    else:
        print("Full scrape finished, but not all tracks are done.")
        print("Publishing current data anyway.")

    print("Updating streams history CSV...")
    subprocess.run(
        [sys.executable, str(_SCRIPT_DIR / "migrate_streams_to_csv.py")],
        check=False,
    )
    print("Streams history CSV done.")

    if debug_mode:
        print("[DEBUG] Skip : Twitter, forecast, images, Billboard, notify.")
    else:
        print("Posting streams image to Twitter...")
        subprocess.run(
            [sys.executable, str(_SCRIPT_DIR / "post_streams_twitter.py"), summary["stats_date"]],
            check=False,
        )
        print("Twitter post done.")

    print("Re-exporting web data...")
    export_for_web.export_for_web()
    print("Web export done.")

    print("Updating artist metadata...")
    artist_thread.join(timeout=60)
    update_artist_metadata(pre_scraped=_artist_result[0])

    print("Re-exporting web data (with artist metadata)...")
    export_for_web.export_for_web()
    print("Web export done.")

    if not debug_mode:
        print("Rebuilding expected milestones forecast...")
        subprocess.run(
            [sys.executable, str(_SCRIPT_DIR / "forecast_milestones.py")],
            check=True,
        )
        print("Expected milestones forecast done.")

        print("Refreshing image URLs + track_covers.json...")
        subprocess.run(
            [sys.executable, str(_REPO_ROOT / "scripts" / "fill_images.py")],
            check=True,
        )
        print("Image URLs done.")

        print("Fetching missing track cover images from Spotify...")
        subprocess.run(
            [sys.executable, str(_SCRIPT_DIR / "fill_track_images.py")],
            check=False,
        )
        print("Track cover images done.")


    print("Git commit and push...")
    git_commit_and_push(f"daily final export {summary['stats_date']}")

    elapsed = time.perf_counter() - START_TIME
    print()
    print(f"Finished in {int(elapsed // 60)}m {int(elapsed % 60)}s")
    print(f"Done: {summary['done_tracks']}/{summary['total_tracks']}")
    print(f"Remaining: {summary['remaining_tracks']}")

    if not debug_mode:
        notify(
            NTFY_TOPIC,
            f"{summary['done_tracks']}/{summary['total_tracks']} tracks mis à jour ({summary['stats_date']})\n"
            f"Durée : {int(elapsed // 60)}m {int(elapsed % 60)}s",
            title="Taylor Swift - Streams mis à jour",
            tags="white_check_mark,chart_increasing",
        )
    

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped by user.")