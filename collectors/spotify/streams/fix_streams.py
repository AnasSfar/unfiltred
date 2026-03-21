#!/usr/bin/env python3
"""
fix_streams.py — Scrape le total actuel de toutes les chansons (8 fenêtres
Chrome en parallèle) et corrige la dernière ligne du CSV.

Le daily_streams n'est PAS touché : il sera recalculé à la prochaine update.

Usage:
  python fix_streams.py             # corrige tout
  python fix_streams.py --dry-run  # affiche sans écrire
"""
from __future__ import annotations

import csv
import json
import re
import sys
import threading
import unicodedata
from pathlib import Path
from queue import Empty, Queue

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

_SCRIPT_DIR  = Path(__file__).resolve().parent
_REPO_ROOT   = _SCRIPT_DIR.parents[2]
_DB_ROOT     = _REPO_ROOT / "db"

HISTORY_PATH = _DB_ROOT / "streams_history.csv"
ALBUMS_JSON  = _DB_ROOT / "discography" / "albums.json"
SONGS_JSON   = _DB_ROOT / "discography" / "songs.json"
SESSION_PATH = _SCRIPT_DIR / "tools" / "json" / "spotify_session.json"

PAGE_GOTO_TIMEOUT_MS = 20_000
HEADLESS             = False
NUM_WORKERS          = 8
RATE_LIMIT_WAIT      = 60   # secondes d'attente si 429

# ---------------------------------------------------------------------------
# Scraping helpers
# ---------------------------------------------------------------------------

def parse_int_from_text(value: str | None) -> int | None:
    if not value:
        return None
    digits = re.sub(r"[^\d]", "", value)
    return int(digits) if digits else None


def extract_track_id(url: str | None) -> str | None:
    if not url:
        return None
    m = re.search(r"track/([A-Za-z0-9]+)", url)
    return m.group(1) if m else None


def normalize_spotify_track_url(url: str) -> str:
    tid = extract_track_id(url)
    return f"https://open.spotify.com/track/{tid}" if tid else url.strip()


def is_duration_line(text: str) -> bool:
    return bool(re.fullmatch(r"\d{1,2}:\d{2}", text.strip()))


def is_large_number_line(text: str) -> bool:
    cleaned = text.strip().replace("\u202f", " ").replace("\xa0", " ")
    if not re.fullmatch(r"[\d\s,.\']+", cleaned):
        return False
    v = parse_int_from_text(cleaned)
    return v is not None and v >= 1000


def normalize_title(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", value.lower().strip())


def maybe_accept_cookies(page) -> None:
    for pattern in (r"Accept", r"Accept all", r"Accepter", r"Autoriser"):
        try:
            page.get_by_role("button", name=re.compile(pattern, re.I)).click(timeout=1500)
            page.wait_for_timeout(800)
            return
        except Exception:
            pass


def extract_main_track_playcount_from_lines(lines: list[str]) -> int | None:
    start_idx = None
    for i, line in enumerate(lines):
        if line.strip().lower() in ("titre", "title"):
            start_idx = i
            break
    if start_idx is None:
        return None

    end_markers = {
        "connectez-vous", "se connecter", "artiste", "recommandes", "recommandés",
        "basees sur ce titre", "basées sur ce titre",
        "titres populaires par", "sorties populaires par taylor swift",
    }
    block: list[str] = []
    for line in lines[start_idx + 1:]:
        if normalize_title(line.strip()) in end_markers:
            break
        block.append(line.strip())

    if not block:
        return None

    for i, line in enumerate(block):
        if is_duration_line(line):
            for j in range(i + 1, min(i + 6, len(block))):
                c = block[j].strip()
                if c in {"•", "-", ""}:
                    continue
                if is_large_number_line(c):
                    return parse_int_from_text(c)

    numerics = [parse_int_from_text(l) for l in block if is_large_number_line(l.strip())]
    numerics = [v for v in numerics if v is not None]
    return numerics[0] if len(numerics) == 1 else None


def extract_playcount_via_js(page) -> int | None:
    try:
        result = page.evaluate("""() => {
            const candidates = [];
            document.querySelectorAll('[data-testid]').forEach(el => {
                const txt = (el.innerText || '').trim();
                if (txt && /^[\\d\u202f\u00a0\\s,.']+$/.test(txt)) {
                    const n = parseInt(txt.replace(/[^\\d]/g, ''));
                    if (!isNaN(n) && n >= 10000) candidates.push(n);
                }
            });
            return candidates.length === 1 ? candidates[0] : null;
        }""")
        if result is not None:
            return int(result)
    except Exception:
        pass
    return None


def scrape_total(page, title: str, url: str) -> int | None:
    clean_url = normalize_spotify_track_url(url)
    for attempt in range(3):
        try:
            response = page.goto(clean_url, wait_until="commit", timeout=PAGE_GOTO_TIMEOUT_MS)

            if response and response.status == 429:
                print(f"  429 {title} — attente {RATE_LIMIT_WAIT}s...")
                page.wait_for_timeout(RATE_LIMIT_WAIT * 1000)
                continue

            page.wait_for_timeout(1000)
            maybe_accept_cookies(page)

            for wait_ms in (500, 1500, 3000, 5000):
                try:
                    body = page.locator("body").inner_text(timeout=5000)
                except Exception:
                    body = ""

                if body:
                    if "429" in body[:500] and "too many" in body[:500].lower():
                        print(f"  429 body {title} — attente {RATE_LIMIT_WAIT}s...")
                        page.wait_for_timeout(RATE_LIMIT_WAIT * 1000)
                        break

                    lines = [
                        l.replace("\u202f", " ").replace("\xa0", " ").strip()
                        for l in body.splitlines() if l.strip()
                    ]
                    total = extract_main_track_playcount_from_lines(lines)
                    if total is not None:
                        return total
                    total = extract_playcount_via_js(page)
                    if total is not None:
                        return total

                page.wait_for_timeout(wait_ms)
            else:
                return None

        except PlaywrightTimeoutError:
            print(f"  TIMEOUT {title} (attempt {attempt + 1}/3)")
            try:
                page.wait_for_timeout(1500)
            except Exception:
                pass
        except Exception as e:
            print(f"  ERROR {title}: {e} (attempt {attempt + 1}/3)")
            try:
                page.wait_for_timeout(1000)
            except Exception:
                pass

    return None


# ---------------------------------------------------------------------------
# CSV helpers
# ---------------------------------------------------------------------------

def load_tracks_from_discography() -> list[dict]:
    seen: dict[str, dict] = {}
    for db_file in (ALBUMS_JSON, SONGS_JSON):
        if not db_file.exists():
            continue
        try:
            sections = json.loads(db_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        for section in sections:
            for track in section.get("tracks", []):
                url = (track.get("url") or track.get("spotify_url") or "").strip()
                tid = extract_track_id(url)
                if not tid or tid in seen:
                    continue
                title = (track.get("title") or "").strip()
                if not title:
                    continue
                seen[tid] = {
                    "track_id": tid,
                    "title": title,
                    "url": f"https://open.spotify.com/track/{tid}",
                }
    return sorted(seen.values(), key=lambda t: t["title"].casefold())


def load_csv_rows() -> tuple[list[str], list[dict]]:
    if not HISTORY_PATH.exists():
        return [], []
    with HISTORY_PATH.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)
    return fieldnames, rows


def save_csv_rows(fieldnames: list[str], rows: list[dict]) -> None:
    with HISTORY_PATH.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def find_last_row_index(rows: list[dict], track_id: str) -> int | None:
    last_idx = None
    for i, r in enumerate(rows):
        if (r.get("track_id") or "").strip() == track_id:
            last_idx = i
    return last_idx


def parse_streams(row: dict) -> int | None:
    raw = (row.get("streams") or "").strip()
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Worker (un sync_playwright par thread, comme update_streams.py)
# ---------------------------------------------------------------------------

def _worker(
    task_queue: Queue,
    results: list[dict],
    print_lock: threading.Lock,
    total_tasks: int,
) -> None:
    p = sync_playwright().start()
    browser = p.chromium.launch(
        headless=HEADLESS,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
        ],
    )

    ctx_kwargs: dict = {}
    if SESSION_PATH.exists():
        ctx_kwargs["storage_state"] = str(SESSION_PATH)

    context = browser.new_context(**ctx_kwargs)

    def block_unneeded(route):
        blocked_types = {"media", "font"}
        blocked_kw    = ("doubleclick", "googletagmanager", "google-analytics",
                         "analytics", "facebook", ".mp4", ".webm", ".mp3",
                         ".woff", ".woff2", ".ttf")
        if (route.request.resource_type in blocked_types
                or any(x in route.request.url.lower() for x in blocked_kw)):
            route.abort()
        else:
            route.continue_()

    context.route("**/*", block_unneeded)
    page = context.new_page()

    try:
        while True:
            try:
                item = task_queue.get_nowait()
            except Empty:
                break

            i            = item["index"]
            track        = item["track"]
            last_idx     = item["last_idx"]
            stored_total = item["stored_total"]
            stored_date  = item["stored_date"]
            title        = track["title"]

            scraped = scrape_total(page, title, track["url"])

            with print_lock:
                prefix = f"[{i:3}/{total_tasks}] {title:<50}"
                if scraped is None:
                    print(f"{prefix} NOT FOUND")
                    results.append({"status": "not_found", "title": title})
                elif scraped == stored_total:
                    print(f"{prefix} = {scraped:>15,}  (inchangé)")
                    results.append({"status": "unchanged", "title": title})
                else:
                    delta = scraped - (stored_total or 0)
                    sign  = "+" if delta >= 0 else ""
                    print(f"{prefix} FIX {scraped:>15,}  (was {stored_total:,}  {sign}{delta:,})  [{stored_date}]")
                    results.append({
                        "status":      "fixed",
                        "title":       title,
                        "date":        stored_date,
                        "old_total":   stored_total,
                        "new_total":   scraped,
                        "delta_total": delta,
                        "last_idx":    last_idx,
                    })

            task_queue.task_done()
    finally:
        context.close()
        browser.close()
        p.stop()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    dry_run = "--dry-run" in sys.argv
    print(f"fix_streams.py — dry_run={dry_run}, workers={NUM_WORKERS}")
    print()

    tracks           = load_tracks_from_discography()
    fieldnames, rows = load_csv_rows()
    print(f"  {len(tracks)} tracks discography | {len(rows)} lignes CSV")
    print()

    if not fieldnames:
        fieldnames = ["date", "track_id", "streams", "daily_streams"]

    task_queue: Queue     = Queue()
    skipped_no_history    = 0

    for i, track in enumerate(tracks, 1):
        last_idx = find_last_row_index(rows, track["track_id"])
        if last_idx is None:
            skipped_no_history += 1
            continue
        task_queue.put({
            "index":        i,
            "track":        track,
            "last_idx":     last_idx,
            "stored_total": parse_streams(rows[last_idx]),
            "stored_date":  rows[last_idx].get("date", "?"),
        })

    total_tasks = task_queue.qsize()
    print(f"  {total_tasks} tracks à scraper | {skipped_no_history} sans historique")
    print()

    results: list[dict] = []
    print_lock          = threading.Lock()

    n_workers = min(NUM_WORKERS, total_tasks)
    threads = [
        threading.Thread(
            target=_worker,
            args=(task_queue, results, print_lock, total_tasks),
            daemon=True,
        )
        for _ in range(n_workers)
    ]

    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Appliquer les corrections
    fixed_results = [r for r in results if r["status"] == "fixed"]
    if not dry_run and fixed_results:
        for r in fixed_results:
            rows[r["last_idx"]]["streams"] = str(r["new_total"])
        save_csv_rows(fieldnames, rows)
        print(f"\nCSV mis à jour ({len(fixed_results)} correction(s)).")
    elif dry_run:
        print("\n[DRY-RUN] Aucune écriture.")
    else:
        print("\nAucune correction nécessaire.")

    counts = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1

    print()
    print("=" * 60)
    print(f"  Corrigés   : {counts.get('fixed', 0)}")
    print(f"  Inchangés  : {counts.get('unchanged', 0)}")
    print(f"  NOT FOUND  : {counts.get('not_found', 0)}")
    print(f"  Sans histo : {skipped_no_history}")
    print("=" * 60)

    if fixed_results:
        print()
        print("Détail des corrections :")
        for r in fixed_results:
            sign = "+" if r["delta_total"] >= 0 else ""
            print(
                f"  {r['title']:<45} [{r['date']}]  "
                f"{r['old_total']:>13,} -> {r['new_total']:>13,}  ({sign}{r['delta_total']:,})"
            )


if __name__ == "__main__":
    main()
