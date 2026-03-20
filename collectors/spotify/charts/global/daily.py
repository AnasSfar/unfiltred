#!/usr/bin/env python3
"""
daily.py - Global
Scrape la page Spotify Charts, filtre TS, met à jour ts_history, et poste le tweet.

Usage :
    python daily.py [YYYY-MM-DD]

Logique :
- cherche toutes les dates non postées des 7 derniers jours
- attend que la page la plus récente soit disponible
- lance filter.py pour chaque date manquante
- si plusieurs dates : génère une image combinée
- poste sur Twitter
"""

from __future__ import annotations

import re
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from core.notify import send as notify
from core.twitter import post_thread, post_with_image, split_tweets

ROOT = Path(__file__).parent
_REPO_ROOT = ROOT.parents[3]

CHART_ID = "regional-global-daily"
TWITTER_SESSION = ROOT / "twitter_session.json"
SPOTIFY_SESSION = ROOT / "spotify_session.json"
FILTER_SCRIPT = ROOT / "filter.py"
GENERATE_IMAGE_SCRIPT = ROOT / "generate_chart_image.py"

try:
    from config import NTFY_TOPIC
except Exception:
    NTFY_TOPIC = ""

RETRY_SECONDS = 60
CUTOFF_HOUR = 15
LOOKBACK_DAYS = 7
PAGE_TIMEOUT_MS = 120_000
POST_GOTO_WAIT_MS = 6000

_SCRIPT_START = datetime.now()


def log(level: str, message: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] [{level}] {message}", flush=True)


def lock_path(d: date) -> Path:
    return ROOT / str(d.year) / f"{d.month:02d}" / str(d) / "posted.lock"


def tweet_path(d: date) -> Path:
    return ROOT / str(d.year) / f"{d.month:02d}" / str(d) / "tweet.txt"


def chart_csv_path(d: date) -> Path:
    return ROOT / str(d.year) / f"{d.month:02d}" / str(d) / "ts_all_songs.csv"


def no_ts_lock_path(d: date) -> Path:
    return ROOT / str(d.year) / f"{d.month:02d}" / str(d) / "no_ts.lock"


def already_posted(d: date) -> bool:
    exists = lock_path(d).exists()
    log("DEBUG", f"posted.lock pour {d}: {'oui' if exists else 'non'}")
    return exists


def mark_posted(d: date) -> None:
    p = lock_path(d)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()
    log("INFO", f"posted.lock créé: {p}")


def chart_already_processed(d: date) -> bool:
    processed = chart_csv_path(d).exists() or no_ts_lock_path(d).exists()
    log("DEBUG", f"chart déjà traité pour {d}: {'oui' if processed else 'non'}")
    return processed


def get_unposted_dates() -> list[date]:
    today = date.today()
    unposted = [
        today - timedelta(days=i)
        for i in range(1, LOOKBACK_DAYS + 1)
        if not already_posted(today - timedelta(days=i))
    ]
    unposted.sort()
    return unposted


def past_cutoff() -> bool:
    now = datetime.now()
    return now.date() > _SCRIPT_START.date() and now.hour >= CUTOFF_HOUR


def extract_date_from_url(url: str) -> date | None:
    match = re.search(r"/(\d{4}-\d{2}-\d{2})(?:[/?#]|$)", url or "")
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1), "%Y-%m-%d").date()
    except ValueError:
        return None


def try_extract_chart_date_from_page(page) -> date | None:
    try:
        body_text = (page.locator("body").inner_text(timeout=5000) or "").strip()
    except Exception:
        body_text = ""

    patterns = [
        r"\b\d{4}-\d{2}-\d{2}\b",
        r"\b[A-Z][a-z]+ \d{1,2}, \d{4}\b",
    ]

    for pattern in patterns:
        match = re.search(pattern, body_text)
        if not match:
            continue
        value = match.group(0)

        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            try:
                return datetime.strptime(value, "%Y-%m-%d").date()
            except ValueError:
                pass

        try:
            return datetime.strptime(value, "%B %d, %Y").date()
        except ValueError:
            pass

    return extract_date_from_url(page.url)


def page_has_exploitable_chart(body_text: str) -> bool:
    body_text_lower = body_text.lower()

    has_streams = bool(re.search(r"\b\d{1,3}(?:[,.\s]\d{3}){2,}\b", body_text))
    has_chart_header = "track" in body_text_lower and "streams" in body_text_lower
    has_rank_line = bool(re.search(r"(?m)^\s*1\s*$", body_text))

    log("CHECK", f"has_streams={has_streams}")
    log("CHECK", f"has_chart_header={has_chart_header}")
    log("CHECK", f"has_rank_line={has_rank_line}")

    return has_streams and has_chart_header and has_rank_line


def open_chart_page(page, route_value: str) -> tuple[bool, date | None]:
    url = f"https://charts.spotify.com/charts/view/{CHART_ID}/{route_value}"
    log("CHECK", f"Ouverture {url}")

    page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
    page.wait_for_timeout(POST_GOTO_WAIT_MS)

    current_url = page.url.lower()
    log("CHECK", f"URL finale: {page.url}")

    if "login" in current_url or "accounts.spotify.com" in current_url:
        log("CHECK", "Session Spotify expirée ou non connectée")
        return False, None

    body_text = (page.locator("body").inner_text() or "").strip()
    if "Log in with Spotify" in body_text:
        log("CHECK", "Session Spotify non valide")
        return False, None

    log("CHECK", f"Longueur texte: {len(body_text)}")

    detected_date = try_extract_chart_date_from_page(page)
    log("CHECK", f"Date détectée: {detected_date if detected_date else 'N/A'}")

    available = page_has_exploitable_chart(body_text)
    log("CHECK", f"Page exploitable: {'oui' if available else 'non'}")

    return available, detected_date


def page_available(target_date: date) -> bool:
    if not SPOTIFY_SESSION.exists():
        log("ERROR", f"Session Spotify introuvable: {SPOTIFY_SESSION}")
        return False

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
            page.set_default_navigation_timeout(PAGE_TIMEOUT_MS)
            page.set_default_timeout(PAGE_TIMEOUT_MS)

            try:
                available, detected_date = open_chart_page(page, str(target_date))
                if available:
                    return True
            except PlaywrightTimeoutError as e:
                log("CHECK", f"Timeout route datée: {e}")
            except Exception as e:
                log("CHECK", f"Route datée échouée: {e}")

            log("CHECK", "Fallback vers latest ...")

            try:
                available, detected_date = open_chart_page(page, "latest")
            except PlaywrightTimeoutError as e:
                log("CHECK", f"Timeout latest: {e}")
                return False
            except Exception as e:
                log("CHECK", f"Erreur latest: {e}")
                return False

            if not detected_date:
                log("CHECK", "Impossible de détecter la date du chart latest")
                return False

            if chart_already_processed(detected_date):
                log("CHECK", f"Latest ({detected_date}) déjà traité localement")
                return False

            if detected_date != target_date:
                log("CHECK", f"Latest pointe vers {detected_date}, attendu {target_date}")
                return False

            return available

        except Exception as e:
            log("CHECK", f"Erreur générale: {e}")
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
    log("STEP", f"Lancement de filter.py pour {d}")

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

    tp = tweet_path(d)
    if not tp.exists():
        log("ERROR", f"tweet.txt introuvable après filter.py pour {d}")
        return None

    content = tp.read_text(encoding="utf-8")
    log("INFO", f"tweet.txt chargé ({len(content)} caractères)")
    return content


def build_tweet_content(processed: list[date]) -> str:
    if len(processed) == 1:
        d = processed[0]
        return f"Taylor Swift on Spotify Global Charts yesterday ({d.strftime('%B %d, %Y')}) :"

    parts = [d.strftime("%B %d") for d in processed]
    year = processed[-1].year
    return f"Taylor Swift on Spotify Global Charts ({' / '.join(parts)}, {year}) :"


def generate_image(processed: list[date]) -> Path | None:
    log("STEP", "Génération de l'image du chart")

    if len(processed) == 1:
        d = processed[0]
        image_path = ROOT / str(d.year) / f"{d.month:02d}" / str(d) / "chart_image.png"
        img_args = [sys.executable, str(GENERATE_IMAGE_SCRIPT), str(d)]
    else:
        image_path = ROOT / "chart_image_multi.png"
        img_args = [sys.executable, str(GENERATE_IMAGE_SCRIPT)] + [str(d) for d in processed]

    img_result = subprocess.run(
        img_args,
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )

    if img_result.stdout:
        print(img_result.stdout, flush=True)
    if img_result.stderr:
        print(img_result.stderr, flush=True)

    if img_result.returncode != 0:
        log("WARN", "Génération d'image échouée — publication sans image")
        return None

    if not image_path.exists():
        log("WARN", f"Image attendue introuvable: {image_path}")
        return None

    return image_path


def git_commit_and_push() -> None:
    log("STEP", "Git commit et push")
    try:
        subprocess.run(
            ["git", "add", "collectors/spotify/charts/global/", "db/charts_history_global.csv"],
            cwd=str(_REPO_ROOT),
            check=True,
        )
        diff = subprocess.run(
            ["git", "diff", "--cached", "--quiet"],
            cwd=str(_REPO_ROOT),
            check=False,
        )
        if diff.returncode != 0:
            today = date.today().isoformat()
            subprocess.run(
                ["git", "commit", "-m", f"charts global {today}"],
                cwd=str(_REPO_ROOT),
                check=True,
            )
            subprocess.run(["git", "push"], cwd=str(_REPO_ROOT), check=True)
            log("INFO", "Git commit + push done.")
        else:
            log("INFO", "Rien à commit.")
    except subprocess.CalledProcessError as e:
        log("WARN", f"Git commit/push échoué : {e}")


def migrate_archive_csv() -> None:
    migrate_script = ROOT.parent / "migrate_charts_to_csv.py"
    log("STEP", "Mise à jour du CSV charts history")

    migrate_result = subprocess.run(
        [sys.executable, str(migrate_script)],
        capture_output=True,
        text=True,
    )

    if migrate_result.stdout:
        print(migrate_result.stdout, flush=True)
    if migrate_result.stderr:
        print(migrate_result.stderr, flush=True)

    if migrate_result.returncode != 0:
        log("WARN", f"migrate_charts_to_csv.py a échoué (code {migrate_result.returncode})")
    else:
        log("INFO", "CSV charts history mis à jour")


def main() -> None:
    if len(sys.argv) > 1:
        try:
            unposted = [datetime.strptime(sys.argv[1], "%Y-%m-%d").date()]
        except ValueError:
            log("ERROR", f"Date invalide '{sys.argv[1]}', format attendu : YYYY-MM-DD")
            sys.exit(1)
    else:
        unposted = get_unposted_dates()

    log("INFO", f"Heure locale: {datetime.now()}")
    log("INFO", f"Script: {Path(__file__).name}")
    log("INFO", f"Répertoire: {ROOT}")

    print(f"\n{'=' * 50}\n  daily.py (Global)\n{'=' * 50}\n", flush=True)

    if not unposted:
        log("INFO", "Tout est déjà posté")
        return

    log("INFO", f"Dates à poster: {[str(d) for d in unposted]}")
    target = unposted[-1]

    attempt = 1
    while True:
        if past_cutoff():
            log("WARN", f"{CUTOFF_HOUR}h00 atteint — page {target} toujours indisponible, abandon")
            return

        log("WAIT", f"Vérification tentative #{attempt} pour {target}")
        if page_available(target):
            log("INFO", f"Page de {target} détectée")
            break

        log("WAIT", f"Page {target} pas encore exploitable, retry #{attempt} dans {RETRY_SECONDS // 60} min")
        attempt += 1
        time.sleep(RETRY_SECONDS)

    results: dict[date, str] = {}
    for d in unposted:
        content = run_filter(d)
        if content:
            results[d] = content
        else:
            log("WARN", f"filter.py a échoué pour {d}, date ignorée")

    if not results:
        log("ERROR", "Aucun traitement réussi")
        sys.exit(1)

    processed = sorted(results.keys())

    tweet_content = build_tweet_content(processed)
    (ROOT / "twitter_post.txt").write_text(tweet_content, encoding="utf-8")
    log("INFO", "twitter_post.txt mis à jour")
    print(f"\nPost :\n{tweet_content}\n", flush=True)

    image_path = generate_image(processed)

    log("STEP", "Publication Twitter")
    if image_path:
        posted = post_with_image(tweet_content, image_path, TWITTER_SESSION)
    else:
        posted = post_thread(split_tweets(tweet_content), TWITTER_SESSION)

    if posted:
        for d in processed:
            mark_posted(d)

        log("INFO", f"Terminé avec succès ({len(processed)} date(s) postée(s))")

        migrate_archive_csv()
        git_commit_and_push()

        if NTFY_TOPIC:
            notify(
                NTFY_TOPIC,
                tweet_content,
                title="Taylor Swift Global - Posté",
                tags="white_check_mark,earth_globe_europe-africa",
            )
    else:
        log("ERROR", "Publication Twitter échouée, posted.lock non créé")

        if NTFY_TOPIC:
            notify(
                NTFY_TOPIC,
                "La publication Twitter a échoué.",
                title="Taylor Swift Global - Erreur",
                tags="x,warning",
                priority="high",
            )

        sys.exit(1)


if __name__ == "__main__":
    main()