#!/usr/bin/env python3
"""
daily.py - Fr
Telecharge le CSV du jour, filtre, met a jour ts_history, et poste le tweet.
Lance par le Task Scheduler a 00:00.
Usage : python daily.py
"""
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from core.twitter import post_thread, split_tweets
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

ROOT            = Path(__file__).parent
PROJECT_ROOT    = ROOT.parent
CHART_ID        = "regional-fr-daily"
SESSION_FILE    = ROOT / "spotify_session.json"
TWITTER_SESSION = ROOT / "twitter_session.json"
FILTER_SCRIPT   = ROOT / "filter.py"
REBUILD_SCRIPT  = ROOT / "rebuild.py"


def chart_date() -> date:
    if len(sys.argv) > 1:
        try:
            return datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
        except ValueError:
            print(f"  Date invalide '{sys.argv[1]}', format attendu : YYYY-MM-DD")
            sys.exit(1)
    return date.today() - timedelta(days=1)


def lock_path(d) -> Path:
    return ROOT / str(d.year) / f"{d.month:02d}" / str(d) / "posted.lock"


def already_posted(d) -> bool:
    return lock_path(d).exists()


def mark_posted(d):
    p = lock_path(d)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()


def csv_exists(d) -> bool:
    return any(ROOT.rglob(f"{CHART_ID}-{d}.csv"))


def download_csv(d) -> bool:
    url      = f"https://charts.spotify.com/charts/view/{CHART_ID}/{d}"
    dest_dir = ROOT / str(d.year) / f"{d.month:02d}" / str(d)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{CHART_ID}-{d}.csv"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        if not SESSION_FILE.exists():
            print("  Session Spotify manquante. Lance d'abord download.py")
            browser.close()
            return False
        ctx  = browser.new_context(accept_downloads=True, storage_state=str(SESSION_FILE))
        page = ctx.new_page()
        try:
            page.goto(url, timeout=30_000)
            time.sleep(2)
            if "login" in page.url or "accounts.spotify.com" in page.url:
                print("  Session expiree.")
                browser.close()
                return False
            btn = page.locator("button[aria-labelledby='csv_download']").first
            if not btn.is_visible(timeout=8_000):
                print(f"  CSV de {d} pas encore disponible.")
                browser.close()
                return False
            with page.expect_download(timeout=15_000) as dl:
                btn.click(timeout=20_000)
            dl.value.save_as(dest)
            print(f"OK CSV telecharge : {dest.relative_to(ROOT)}")
            browser.close()
            return True
        except PlaywrightTimeout:
            print("  Timeout.")
            browser.close()
            return False
        except Exception as e:
            print(f"  Erreur : {e}")
            browser.close()
            return False


def run_filter(d) -> str | None:
    print("-> filter.py ...", flush=True)
    result = subprocess.run(
        [sys.executable, str(FILTER_SCRIPT), str(d)],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if result.stdout:
        print(result.stdout, flush=True)
    if result.stderr:
        print(result.stderr, flush=True)
    if result.returncode != 0:
        print(f"  Filtre echoue (code {result.returncode})", flush=True)
        return None

    print("-> rebuild.py (mise a jour ts_history) ...", flush=True)
    rebuild = subprocess.run(
        [sys.executable, str(REBUILD_SCRIPT)],
        capture_output=True, text=True, cwd=str(ROOT),
    )
    if rebuild.stdout:
        print(rebuild.stdout, flush=True)
    if rebuild.stderr:
        print(rebuild.stderr, flush=True)

    tweet_path = ROOT / str(d.year) / f"{d.month:02d}" / str(d) / "tweet.txt"
    if not tweet_path.exists():
        print("  tweet.txt introuvable apres filter.py", flush=True)
        return None
    return tweet_path.read_text(encoding="utf-8")


def main():
    d = chart_date()
    print(f"\n{'='*50}\n  daily.py (Fr) - charts du {d}\n{'='*50}\n")

    if already_posted(d):
        print(f"OK Deja poste pour {d}.")
        return

    if not csv_exists(d):
        print(f"En attente du CSV pour {d}...", flush=True)
        attempt = 1
        while not download_csv(d):
            print(f"  -> CSV pas encore dispo, retry #{attempt} dans 1 min...", flush=True)
            attempt += 1
            time.sleep(60)
    else:
        print("CSV deja present.")

    tweet_content = run_filter(d)
    if not tweet_content:
        print("  Traitement echoue.")
        sys.exit(1)

    (ROOT / "twitter_post.txt").write_text(tweet_content, encoding="utf-8")
    print(f"\nPost :\n{tweet_content}\n")

    if post_thread(split_tweets(tweet_content), TWITTER_SESSION):
        mark_posted(d)
        print("\nOK Termine.")
    else:
        print("\nERREUR : Publication echouee, posted.lock non cree.")
        sys.exit(1)


if __name__ == "__main__":
    main()
