from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from queue import Empty, Queue

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT  = _SCRIPT_DIR.parents[2]
ROOT        = _REPO_ROOT / "website"
DB_PATH     = _REPO_ROOT / "db" / "songs.db"

HEADLESS = True
MAX_PARALLEL_PAGES = 4
START_TIME = None


def block_unneeded(route):
    request = route.request
    url = request.url.lower()
    resource_type = request.resource_type

    blocked_resource_types = {
        "image",
        "media",
        "font",
    }

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


def load_tracks_missing_images() -> list[dict]:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT track_id, title, spotify_url, image_url
            FROM songs
            WHERE image_url IS NULL OR TRIM(image_url) = ''
            ORDER BY title COLLATE NOCASE
            """
        ).fetchall()

    return [dict(row) for row in rows]


def update_image_in_db(track_id: str, image_url: str) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            UPDATE songs
            SET image_url = ?
            WHERE track_id = ?
            """,
            (image_url, track_id),
        )
        conn.commit()


def scrape_track_image(page, url: str) -> str | None:
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=20000)
        page.wait_for_timeout(1000)

        og = page.locator('meta[property="og:image"]')
        if og.count() > 0:
            content = og.first.get_attribute("content")
            if content and content.strip():
                return content.strip()

        twitter = page.locator('meta[name="twitter:image"]')
        if twitter.count() > 0:
            content = twitter.first.get_attribute("content")
            if content and content.strip():
                return content.strip()

        return None

    except PlaywrightTimeoutError:
        return None
    except Exception:
        return None


def live_progress(i, total, title, result):
    elapsed = time.perf_counter() - START_TIME if START_TIME else 0

    if result is None:
        done = max(i - 1, 0)
    else:
        done = i

    if done > 0:
        avg = elapsed / done
        remaining = max(total - done, 0) * avg
    else:
        remaining = 0

    eta = f"{int(remaining // 60)}m {int(remaining % 60)}s"
    prefix = f"[{i}/{total}] {title}"

    if result is None:
        print(f"{prefix} ... fetching image | ETA {eta}")
        return

    status = result.get("status", "unknown")

    if status == "updated":
        print(f"{prefix} OK | image saved | ETA {eta}")
    elif status == "not_found":
        print(f"{prefix} NOT FOUND | ETA {eta}")
    else:
        print(f"{prefix} {status.upper()} | ETA {eta}")


def _worker(queue, results, lock, on_progress, total_tracks):
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

            if on_progress:
                on_progress(i, total_tracks, title, None)

            image_url = scrape_track_image(page, url)

            if image_url:
                update_image_in_db(track_id, image_url)
                result = {
                    "track_id": track_id,
                    "title": title,
                    "status": "updated",
                    "image_url": image_url,
                }
            else:
                result = {
                    "track_id": track_id,
                    "title": title,
                    "status": "not_found",
                }

            with lock:
                results[i - 1] = result

            if on_progress:
                on_progress(i, total_tracks, title, result)

            queue.task_done()

    finally:
        browser.close()
        p.stop()


def run_fill_images(on_progress=None):
    tracks = load_tracks_missing_images()
    total_tracks = len(tracks)
    results = [None] * total_tracks

    if total_tracks == 0:
        return []

    queue = Queue()
    for i, track in enumerate(tracks, 1):
        queue.put((i, track))

    lock = threading.Lock()
    worker_count = min(MAX_PARALLEL_PAGES, total_tracks)

    workers = [
        threading.Thread(
            target=_worker,
            args=(queue, results, lock, on_progress, total_tracks),
            daemon=True,
        )
        for _ in range(worker_count)
    ]

    for w in workers:
        w.start()

    for w in workers:
        w.join()

    return [r for r in results if r is not None]


def main():
    global START_TIME
    START_TIME = time.perf_counter()

    results = run_fill_images(on_progress=live_progress)

    elapsed = time.perf_counter() - START_TIME
    updated = sum(1 for r in results if r["status"] == "updated")
    not_found = sum(1 for r in results if r["status"] == "not_found")

    print()
    print(f"Finished in {int(elapsed // 60)}m {int(elapsed % 60)}s")
    print(f"Images updated: {updated}")
    print(f"Images not found: {not_found}")


if __name__ == "__main__":
    main()