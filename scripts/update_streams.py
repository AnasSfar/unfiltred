from __future__ import annotations

import csv
import json
import re
import sqlite3
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from queue import Empty, Queue

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

import export_for_web


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "songs.db"
HISTORY_PATH = DATA_DIR / "history.csv"
FAILED_PATH = DATA_DIR / "not_found_today.csv"
DISCOGRAPHY_DIR = ROOT / "discography"
ARTIST_PATH = DATA_DIR / "artist.json"
ARTIST_URL = "https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02"

HEADLESS = True
MAX_PARALLEL_PAGES = 8
SLEEP_SECONDS = 10 * 60

START_TIME = None

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


def extract_artist_image(page) -> str | None:
    selectors = [
        'img[alt="Taylor Swift"]',
        'img[src*="i.scdn.co"]',
        'img',
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
    browser = p.chromium.launch(headless=HEADLESS)
    context = browser.new_context()
    page = context.new_page()
    page.route("**/*", block_unneeded)

    try:
        page.goto(ARTIST_URL, wait_until="domcontentloaded", timeout=30000)

        for wait_ms in (800, 1500, 2500, 4000):
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


def update_artist_metadata() -> dict:
    existing = load_existing_artist_metadata()
    scraped = scrape_artist_metadata()

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

def get_scrape_date_str() -> str:
    return date.today().isoformat()


def get_stats_date_str() -> str:
    return (date.today() - timedelta(days=1)).isoformat()


def format_int(value: int | None) -> str:
    if value is None:
        return "N/A"
    return f"{value:,}".replace(",", " ")


def extract_track_id(url: str | None) -> str | None:
    if not url:
        return None
    match = re.search(r"track/([A-Za-z0-9]+)", url)
    return match.group(1) if match else None


def load_active_track_ids_from_discography() -> set[str]:
    active_track_ids = set()

    if not DISCOGRAPHY_DIR.exists():
        return active_track_ids

    for path in DISCOGRAPHY_DIR.rglob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue

        for track in data.get("tracks", []):
            url = (track.get("url") or track.get("spotify_url") or "").strip()
            track_id = extract_track_id(url)
            if track_id:
                active_track_ids.add(track_id)

    return active_track_ids


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


def ensure_history_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if not HISTORY_PATH.exists():
        with HISTORY_PATH.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["date", "track_id", "streams", "daily_streams"])


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

            try:
                if daily_raw != "" and int(daily_raw) > 0:
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


def has_real_update(previous_streams: int | None, new_streams: int) -> bool:
    if previous_streams is None:
        return True
    return new_streams > previous_streams


def load_tracks_from_db(active_track_ids: set[str] | None = None) -> list[dict]:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row

        if active_track_ids is None:
            rows = conn.execute(
                """
                SELECT track_id, title, spotify_url, streams, daily_streams, last_updated
                FROM songs
                ORDER BY title COLLATE NOCASE
                """
            ).fetchall()
        else:
            if not active_track_ids:
                return []

            placeholders = ",".join("?" for _ in active_track_ids)
            rows = conn.execute(
                f"""
                SELECT track_id, title, spotify_url, streams, daily_streams, last_updated
                FROM songs
                WHERE track_id IN ({placeholders})
                ORDER BY title COLLATE NOCASE
                """,
                tuple(sorted(active_track_ids)),
            ).fetchall()

    return [dict(row) for row in rows]


def append_history_rows(rows: list[list]) -> None:
    if not rows:
        return

    with HISTORY_PATH.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerows(rows)


def save_not_found_rows(rows: list[dict]) -> None:
    if not rows:
        if FAILED_PATH.exists():
            FAILED_PATH.unlink()
        return

    with FAILED_PATH.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["title", "track_id", "spotify_url"])
        for row in rows:
            writer.writerow([row["title"], row["track_id"], row.get("spotify_url", "")])


def parse_streams_text(value: str) -> int | None:
    if not value:
        return None

    digits = re.sub(r"[^\d]", "", value)
    if not digits:
        return None

    try:
        return int(digits)
    except ValueError:
        return None


def extract_streams_from_page(page) -> tuple[int | None, str | None]:
    candidates = [
        '[data-testid="playcount"]',
        'span:has-text("streams")',
        'span:has-text("écoutes")',
        'span:has-text("lectures")',
        'div:has-text("streams")',
        'div:has-text("écoutes")',
        'div:has-text("lectures")',
    ]

    for selector in candidates:
        try:
            loc = page.locator(selector)
            count = min(loc.count(), 8)
        except Exception:
            continue

        for i in range(count):
            try:
                text = loc.nth(i).inner_text().strip()
            except Exception:
                continue

            total = parse_streams_text(text)
            if total is not None:
                return total, text

    try:
        body_text = page.locator("body").inner_text(timeout=5000)
    except Exception:
        return None, None

    patterns = [
        r"([\d\s.,]+)\s+(streams|écoutes|lectures)",
        r"(streams|écoutes|lectures)\s+([\d\s.,]+)",
    ]

    for pattern in patterns:
        match = re.search(pattern, body_text, re.IGNORECASE)
        if not match:
            continue

        raw = match.group(1) if re.match(r"^[\d\s.,]+$", match.group(1)) else match.group(2)
        total = parse_streams_text(raw)
        if total is not None:
            return total, raw

    return None, None


def scrape_track_total(page, title: str, url: str) -> tuple[int | None, str | None]:
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=20000)

        for wait_ms in (400, 900, 1500):
            page.wait_for_timeout(wait_ms)
            total, raw = extract_streams_from_page(page)
            if total is not None:
                return total, raw

        return None, None

    except PlaywrightTimeoutError:
        return None, None
    except Exception:
        return None, None


def update_song_in_db(track_id: str, streams: int, daily_streams: int | None, scrape_date: str) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            UPDATE songs
            SET streams = ?, daily_streams = ?, last_updated = ?
            WHERE track_id = ?
            """,
            (streams, daily_streams, scrape_date, track_id),
        )
        conn.commit()


def compute_daily(previous_streams: int | None, new_streams: int) -> int | None:
    if previous_streams is None:
        return None

    diff = new_streams - previous_streams
    if diff < 0:
        return None

    return diff


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
            f"unchanged yet | ETA {eta}"
        )
    elif status == "skipped":
        print(f"{prefix} SKIPPED | ETA {eta}")
    elif status == "not_found":
        print(f"{prefix} NOT FOUND | ETA {eta}")
    else:
        print(f"{prefix} {status.upper()} | ETA {eta}")
def _worker(queue, results, lock, on_progress, total_tracks, history_rows):
    p = sync_playwright().start()
    browser = p.chromium.launch(headless=HEADLESS)
    context = browser.new_context()
    page = context.new_page()
    page.route("**/*", block_unneeded)

    try:
        while True:
            try:
                i, track = queue.get_nowait()
            except Empty:
                break

            track_id = track["track_id"]
            title = track["title"]
            url = track["spotify_url"]
            scrape_date = track["scrape_date"]
            stats_date = track["stats_date"]

            if on_progress:
                on_progress(i, total_tracks, title, None)

            total, raw = scrape_track_total(page, title, url)

            if total is None:
                result = {
                    "track_id": track_id,
                    "title": title,
                    "spotify_url": url,
                    "status": "not_found",
                }
            else:
                last_total = get_last_history_total(track_id)
                daily = compute_daily(last_total, total)
                real_update = has_real_update(last_total, total)

                update_song_in_db(track_id, total, daily, scrape_date)

                if real_update or last_total is None:
                    with lock:
                        history_rows.append(
                            [stats_date, track_id, total, daily if daily is not None else ""]
                        )
                    status = "updated"
                else:
                    status = "pending"

                result = {
                    "track_id": track_id,
                    "title": title,
                    "spotify_url": url,
                    "status": status,
                    "streams": total,
                    "daily_streams": daily,
                    "raw": raw,
                }

            with lock:
                results[i - 1] = result

            if on_progress:
                on_progress(i, total_tracks, title, result)

            queue.task_done()

    finally:
        browser.close()
        p.stop()


def run_update(on_progress=None):
    ensure_history_file()

    scrape_date = get_scrape_date_str()
    stats_date = get_stats_date_str()

    active_track_ids = load_active_track_ids_from_discography()
    tracks = load_tracks_from_db(active_track_ids)
    total_tracks = len(tracks)

    already_done_for_stats_date = load_today_history_track_ids(stats_date)

    queue = Queue()
    results = [None] * total_tracks
    history_rows: list[list] = []

    for i, track in enumerate(tracks, 1):
        track["scrape_date"] = scrape_date
        track["stats_date"] = stats_date

        if track["track_id"] in already_done_for_stats_date:
            results[i - 1] = {
                "track_id": track["track_id"],
                "title": track["title"],
                "spotify_url": track["spotify_url"],
                "status": "skipped",
            }
            if on_progress:
                on_progress(i, total_tracks, track["title"], results[i - 1])
            continue

        queue.put((i, track))

    if queue.qsize() > 0:
        lock = threading.Lock()
        worker_count = min(MAX_PARALLEL_PAGES, queue.qsize())

        workers = [
            threading.Thread(
                target=_worker,
                args=(queue, results, lock, on_progress, total_tracks, history_rows),
                daemon=True,
            )
            for _ in range(worker_count)
        ]

        for w in workers:
            w.start()

        for w in workers:
            w.join()

        append_history_rows(history_rows)

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
        "not_found_this_run": sum(1 for r in filtered_results if r["status"] == "not_found"),
        "results": filtered_results,
    }


def run_until_complete(on_progress=None):
    attempt = 0
    last_results = []

    while True:
        attempt += 1
        print()
        print("=" * 70)
        print(f"Run #{attempt}")
        print("=" * 70)

        summary = run_update(on_progress=on_progress)
        last_results = summary["results"]

        print()
        print(
            f"Progress {summary['stats_date']}: "
            f"{summary['done_tracks']}/{summary['total_tracks']} "
            f"| remaining={summary['remaining_tracks']} "
            f"| pending={summary['pending_this_run']}"
        )

        if summary["all_done"]:
            failed_rows = [r for r in last_results if r["status"] == "not_found"]
            save_not_found_rows(failed_rows)

            print("All tracks updated.")

            print("Updating artist metadata...")
            update_artist_metadata()

            print("Re-exporting web data...")
            export_for_web.export_for_web()
            print("Web export done.")
            return summary

        print(f"Waiting {SLEEP_SECONDS // 60} minutes before retry...")
        time.sleep(SLEEP_SECONDS)


def main():
    global START_TIME
    START_TIME = time.perf_counter()

    summary = run_until_complete(on_progress=live_progress)

    elapsed = time.perf_counter() - START_TIME
    print()
    print(f"Finished in {int(elapsed // 60)}m {int(elapsed % 60)}s")
    print(f"Done: {summary['done_tracks']}/{summary['total_tracks']}")
    print(f"Remaining: {summary['remaining_tracks']}")


if __name__ == "__main__":
    main()