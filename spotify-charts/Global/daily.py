#!/usr/bin/env python3
"""
daily.py - Global
Scrape la page Spotify Charts du jour cible, filtre TS, met a jour ts_history, et poste le tweet.
Usage : python daily.py [YYYY-MM-DD]

Logique :
- cible toujours la date d'hier
- fixe la date une seule fois au lancement
- attend que la page de cette date soit disponible
- lance filter.py
- lance rebuild.py
- poste sur Twitter
"""
import re
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from core.twitter import post_thread, split_tweets
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).parent
CHART_ID = "regional-global-daily"
TWITTER_SESSION = ROOT / "twitter_session.json"
SPOTIFY_SESSION = ROOT / "spotify_session.json"
FILTER_SCRIPT = ROOT / "filter.py"
REBUILD_SCRIPT = ROOT / "rebuild.py"

RETRY_SECONDS = 60 


def log(level: str, message: str):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [{level}] {message}", flush=True)


def chart_date() -> date:
    if len(sys.argv) > 1:
        try:
            return datetime.strptime(sys.argv[1], "%Y-%m-%d").date()
        except ValueError:
            log("ERROR", f"Date invalide '{sys.argv[1]}', format attendu : YYYY-MM-DD")
            sys.exit(1)

    now = datetime.now()
    return now.date() - timedelta(days=1)


def lock_path(d: date) -> Path:
    return ROOT / str(d.year) / f"{d.month:02d}" / str(d) / "posted.lock"


def already_posted(d: date) -> bool:
    exists = lock_path(d).exists()
    log("DEBUG", f"posted.lock pour {d}: {'oui' if exists else 'non'}")
    return exists


def mark_posted(d: date):
    p = lock_path(d)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()
    log("INFO", f"posted.lock créé: {p}")


def scraped_csv_path(d: date) -> Path:
    return ROOT / str(d.year) / f"{d.month:02d}" / str(d) / f"{CHART_ID}-{d}.csv"


def scrape_exists(d: date) -> bool:
    p = scraped_csv_path(d)
    exists = p.exists()
    log("DEBUG", f"CSV scrape pour {d}: {'trouvé' if exists else 'absent'} -> {p}")
    return exists


def page_available(d: date) -> bool:
    url = f"https://charts.spotify.com/charts/view/{CHART_ID}/{d}"
    log("CHECK", f"Ouverture {url}")

    with sync_playwright() as p:
        browser = None
        context = None
        try:
            browser = p.chromium.launch(
                headless=False,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    "--no-sandbox",
                ],
            )

            if not SPOTIFY_SESSION.exists():
                log("ERROR", f"Session Spotify introuvable: {SPOTIFY_SESSION}")
                return False

            context = browser.new_context(
                storage_state=str(SPOTIFY_SESSION),
                viewport={"width": 1400, "height": 2000},
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/133.0.0.0 Safari/537.36"
                ),
                locale="en-US",
            )

            page = context.new_page()
            page.set_default_navigation_timeout(60_000)
            page.set_default_timeout(60_000)

            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(6000)

            current_url = page.url.lower()
            log("CHECK", f"URL finale: {page.url}")

            if "login" in current_url or "accounts.spotify.com" in current_url:
                log("CHECK", "Session Spotify expirée ou non connectée")
                return False

            body_text = (page.locator("body").inner_text() or "").strip()
            body_text_lower = body_text.lower()

            log("CHECK", f"Longueur texte: {len(body_text)}")

            # présence d'un vrai nombre de streams
            has_streams = bool(re.search(r"\b\d{1,3},\d{3},\d{3}\b", body_text))

            # présence d'un en-tête de tableau réel
            has_chart_header = ("track" in body_text_lower and "streams" in body_text_lower)

            # présence d'au moins un rang sur ligne seule
            has_rank_line = bool(re.search(r"(?m)^\s*1\s*$", body_text))

            log("CHECK", f"has_streams={has_streams}")
            log("CHECK", f"has_chart_header={has_chart_header}")
            log("CHECK", f"has_rank_line={has_rank_line}")

            available = has_streams and has_chart_header and has_rank_line
            log("CHECK", f"Page exploitable: {'oui' if available else 'non'}")
            return available

        except Exception as e:
            log("CHECK", f"Erreur: {e}")
            return False

        finally:
            try:
                if context:
                    context.close()
            except Exception:
                pass
            try:
                if browser:
                    browser.close()
            except Exception:
                pass


def run_filter(d: date) -> str | None:
    log("STEP", "Lancement de filter.py")
    result = subprocess.run(
        [sys.executable, str(FILTER_SCRIPT), str(d)],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )

    if result.stdout:
        print(result.stdout, flush=True)
    if result.stderr:
        print(result.stderr, flush=True)

    log("STEP", f"filter.py terminé avec code {result.returncode}")

    if result.returncode != 0:
        log("ERROR", f"filter.py a échoué (code {result.returncode})")
        return None

    log("STEP", "Lancement de rebuild.py")
    rebuild = subprocess.run(
        [sys.executable, str(REBUILD_SCRIPT)],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )

    if rebuild.stdout:
        print(rebuild.stdout, flush=True)
    if rebuild.stderr:
        print(rebuild.stderr, flush=True)

    log("STEP", f"rebuild.py terminé avec code {rebuild.returncode}")

    tweet_path = ROOT / str(d.year) / f"{d.month:02d}" / str(d) / "tweet.txt"
    log("DEBUG", f"Recherche de tweet.txt: {tweet_path}")

    if not tweet_path.exists():
        log("ERROR", "tweet.txt introuvable après filter.py")
        return None

    content = tweet_path.read_text(encoding="utf-8")
    log("INFO", f"tweet.txt chargé ({len(content)} caractères)")
    return content


def main():
    d = chart_date()

    log("INFO", f"Heure locale: {datetime.now()}")
    log("INFO", f"Date cible: {d}")
    log("INFO", f"Script: {Path(__file__).name}")
    log("INFO", f"Répertoire: {ROOT}")

    print(f"\n{'=' * 50}\n  daily.py (Global) - charts du {d}\n{'=' * 50}\n", flush=True)

    if already_posted(d):
        log("INFO", f"Déjà posté pour {d}")
        return

    if not scrape_exists(d):
        log("INFO", f"En attente de la page Spotify Charts pour {d}")
        attempt = 1
        while True:
            log("WAIT", f"Vérification tentative #{attempt} pour {d}")
            if page_available(d):
                log("INFO", f"Page de {d} détectée")
                break

            log(
                "WAIT",
                f"Page {d} pas encore exploitable, retry #{attempt} dans {RETRY_SECONDS // 60} min",
            )
            attempt += 1
            time.sleep(RETRY_SECONDS)
    else:
        log("INFO", "Scrape déjà présent, passage direct au traitement")

    tweet_content = run_filter(d)
    if not tweet_content:
        log("ERROR", "Traitement échoué")
        sys.exit(1)

    twitter_post_path = ROOT / "twitter_post.txt"
    twitter_post_path.write_text(tweet_content, encoding="utf-8")
    log("INFO", f"twitter_post.txt mis à jour: {twitter_post_path}")

    print(f"\nPost :\n{tweet_content}\n", flush=True)

    log("STEP", "Publication Twitter")
    posted = post_thread(split_tweets(tweet_content), TWITTER_SESSION)

    if posted:
        mark_posted(d)
        log("INFO", "Terminé avec succès")
    else:
        log("ERROR", "Publication Twitter échouée, posted.lock non créé")
        sys.exit(1)


if __name__ == "__main__":
    main()