#!/usr/bin/env python3
"""
Scrape Spotify France directement depuis la page charts, puis filtre Taylor Swift,
calcule le ranking Pop, appelle Last.fm / MusicBrainz.

Genere :
- ts_all_songs.csv
- ts_pop_songs.csv
- tweet.txt

Usage :
    python filter.py YYYY-MM-DD
    python filter.py --all
    python filter.py --relog
"""
import io
import json
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import pandas as pd
import requests
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from core.fmt import fmt_delta, fmt_streams, fmt_streams_delta
from core.history import load, parse_date, save, update
from core.logger import Logger

from config import LASTFM_API_KEY

LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/"
MUSICBRAINZ_BASE = "https://musicbrainz.org/ws/2/"
MUSICBRAINZ_HEADERS = {
    "User-Agent": "SpotifyFRChartTracker/1.0 (chart-tracker@example.com)",
    "Accept": "application/json",
}

ROOT = Path(__file__).parent
SESSION_FILE = ROOT / "spotify_session.json"
LOCAL_DB_FILE = ROOT / "songs_db.json"

SLEEP_SECONDS = 0.20
TS_NAME = "Taylor Swift"
CHART_ID = "regional-fr-daily"

VIDEO_LINKS = {
    "the fate of ophelia": "https://x.com/4k_taylorr_/status/2025554501789491204/video/1",
    "opalite": "https://x.com/taylornation13/status/2020483269406466203/video/1",
    "elizabeth taylor": "https://x.com/evermorevelyn7/status/1990271086001606677/video/1",
}


def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def get_out_dir(chart_date: str) -> Path:
    return ROOT / chart_date[:4] / chart_date[5:7] / chart_date


def get_songs_present_yesterday(chart_date, ts_history):
    yesterday = str(parse_date(chart_date) - timedelta(days=1))
    return {track for track, entries in ts_history.items() if yesterday in entries}


def clean_int(value):
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.lower() == "nan":
        return None
    s = s.replace(",", "").replace(" ", "")
    if s.isdigit():
        return int(s)
    return None


def normalize_track_name(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def load_db():
    if LOCAL_DB_FILE.exists():
        try:
            return json.loads(LOCAL_DB_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_db(db):
    LOCAL_DB_FILE.write_text(
        json.dumps(db, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def lastfm_get(params):
    r = requests.get(LASTFM_BASE, params=params, timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code}")
    data = r.json()
    if "error" in data:
        raise RuntimeError(data.get("message"))
    return data


def get_release_date_from_musicbrainz(artist, track):
    try:
        r = requests.get(
            MUSICBRAINZ_BASE + "recording",
            params={
                "query": f'recording:"{track}" AND artist:"{artist}"',
                "limit": 5,
                "fmt": "json",
            },
            headers=MUSICBRAINZ_HEADERS,
            timeout=15,
        )
        if r.status_code != 200:
            return ""
        dates = []
        for rec in r.json().get("recordings", []):
            frd = rec.get("first-release-date", "")
            if frd and len(frd) == 10:
                dates.append(frd)
            for rel in rec.get("releases", []):
                d = rel.get("date", "")
                if d and len(d) == 10:
                    dates.append(d)
        return sorted(dates)[0] if dates else ""
    except Exception:
        return ""


def get_track_tags_album(artist, track):
    tags, album = [], None
    for method in ("track.getInfo", "track.gettoptags"):
        try:
            data = lastfm_get({
                "method": method,
                "api_key": LASTFM_API_KEY,
                "artist": artist,
                "track": track,
                "format": "json",
                "autocorrect": "1",
            })
            t = data.get("track", data)
            tags = [norm(x["name"]) for x in t.get("toptags", {}).get("tag", []) if isinstance(x, dict)]
            tags = [t for t in tags if t]
            if method == "track.getInfo":
                album = (t.get("album") or {}).get("title") or None
            if tags:
                break
        except Exception:
            pass

    if not tags:
        try:
            data = lastfm_get({
                "method": "artist.gettoptags",
                "api_key": LASTFM_API_KEY,
                "artist": artist,
                "format": "json",
                "autocorrect": "1",
            })
            tags = [norm(x["name"]) for x in data.get("toptags", {}).get("tag", []) if isinstance(x, dict)]
            tags = [t for t in tags if t]
        except Exception:
            pass

    return tags, album


def is_pop(tags):
    if not tags:
        return False
    if any("k-pop" in t or "kpop" in t for t in tags):
        return False
    return any("pop" in t for t in tags[:3])


def get_song_data(db, artist, track, fetch_release_date=True):
    key = f"{norm(artist)}|||{norm(track)}"
    if key in db:
        e = db[key]
        tags = e.get("tags", [])
        return tags, e.get("album"), e.get("release_date", ""), e.get("is_pop", is_pop(tags)), False

    time.sleep(SLEEP_SECONDS)
    tags, album = get_track_tags_album(artist, track)
    pop = is_pop(tags)
    release_date = ""

    if fetch_release_date:
        time.sleep(1.0)
        release_date = get_release_date_from_musicbrainz(artist, track)

    db[key] = {
        "artist": artist,
        "track": track,
        "tags": tags,
        "is_pop": pop,
        "album": album,
        "release_date": release_date,
    }
    return tags, album, release_date, pop, True


def get_pop_for_nonts(db, artist, track):
    key = f"{norm(artist)}|||{norm(track)}"
    if key in db:
        e = db[key]
        tags = e.get("tags", [])
        return e.get("is_pop", is_pop(tags))

    time.sleep(SLEEP_SECONDS)
    try:
        data = lastfm_get({
            "method": "track.gettoptags",
            "api_key": LASTFM_API_KEY,
            "artist": artist,
            "track": track,
            "format": "json",
            "autocorrect": "1",
        })
        tags = [norm(x["name"]) for x in data.get("toptags", {}).get("tag", []) if isinstance(x, dict)]
        tags = [t for t in tags if t]
    except Exception:
        tags = []

    pop = is_pop(tags)
    db[key] = {"artist": artist, "track": track, "tags": tags, "is_pop": pop}
    return pop


def parse_chart_text(body_text: str) -> list[dict]:
    text = body_text.replace("\r\n", "\n").replace("\r", "\n")

    m = re.search(r"(?im)^\s*Streams\s*$", text)
    if m:
        text = text[m.end():]

    pattern = re.compile(
        r"""
        ^\s*(?P<rank>\d{1,3})\s*$\n
        ^\s*(?P<delta>\d{1,3}|[–—-])\s*$\n
        ^\s*(?P<track>.+?)\s*$\n
        ^\s*(?P<artist>.+?)\s*$\n
        ^\s*(?P<peak>\d{1,3})\s+(?P<prev>\d{1,3})\s+(?P<streak>\d{1,4})\s+(?P<streams>\d{1,3}(?:,\d{3})+)\s*$
        """,
        re.MULTILINE | re.VERBOSE,
    )

    rows = []
    for match in pattern.finditer(text):
        rank = int(match.group("rank"))
        if not (1 <= rank <= 200):
            continue

        rows.append(
            {
                "rank": rank,
                "track_name": normalize_track_name(match.group("track")),
                "artist_names": normalize_track_name(match.group("artist")),
                "streams": clean_int(match.group("streams")),
                "previous_rank": clean_int(match.group("prev")),
                "peak_rank": clean_int(match.group("peak")),
            }
        )

    final_rows = []
    seen = set()
    for row in rows:
        key = (row["rank"], row["track_name"].lower(), row["artist_names"].lower())
        if key in seen:
            continue
        seen.add(key)
        final_rows.append(row)

    final_rows.sort(key=lambda x: x["rank"])
    return final_rows


def scrape_chart_rows(chart_date: str) -> list[dict]:
    if not SESSION_FILE.exists():
        raise RuntimeError("spotify_session.json introuvable")

    url = f"https://charts.spotify.com/charts/view/{CHART_ID}/{chart_date}"
    last_error = None

    for attempt in range(1, 4):
        browser = None
        context = None
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(
                    headless=False,
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--disable-dev-shm-usage",
                        "--no-sandbox",
                        "--window-position=-32000,-32000",
                    ],
                )

                context = browser.new_context(
                    storage_state=str(SESSION_FILE),
                    viewport={"width": 1600, "height": 2400},
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/133.0.0.0 Safari/537.36"
                    ),
                    locale="en-US",
                )

                page = context.new_page()
                page.set_default_navigation_timeout(120_000)
                page.set_default_timeout(120_000)

                print(f"  Ouverture {url} (attempt {attempt}/3)...")
                page.goto(url, wait_until="load", timeout=120_000)
                page.wait_for_timeout(6000)

                current_url = page.url.lower()
                if "login" in current_url or "accounts.spotify.com" in current_url:
                    raise RuntimeError("Session Spotify expirée ou non connectée")

                body_text = (page.locator("body").inner_text() or "").strip()
                if "Log in with Spotify" in body_text:
                    raise RuntimeError("Session Spotify non valide")

                for _ in range(18):
                    page.mouse.wheel(0, 2500)
                    page.wait_for_timeout(700)

                body_text = (page.locator("body").inner_text() or "").strip()
                rows = parse_chart_text(body_text)

                print(f"  {len(rows)} lignes parsees")
                if rows:
                    print("  Apercu :", rows[:3])

                if not rows:
                    debug_dir = get_out_dir(chart_date)
                    debug_dir.mkdir(parents=True, exist_ok=True)
                    (debug_dir / "debug_page.html").write_text(page.content(), encoding="utf-8")
                    (debug_dir / "debug_body.txt").write_text(body_text, encoding="utf-8")
                    raise RuntimeError("Aucune ligne détectée")

                return rows

        except Exception as e:
            last_error = e
            print(f"  Erreur attempt {attempt}/3 : {e}")
            time.sleep(5)

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

    raise RuntimeError(f"Echec scrape {chart_date} : {last_error}")


def _fmt_ts_song_line(row, chart_date, ts_history) -> str:
    track = str(row["track_name"])
    dg = fmt_delta(row["rank"], row.get("previous_rank"), row.get("peak_rank"))
    s = fmt_streams(row.get("streams"))
    sd = fmt_streams_delta(track, row.get("streams"), chart_date, ts_history)

    line = f"- #{int(row['rank'])} ({dg}) {track} | {s}"
    if sd:
        line += f" ({sd})"
    return line


def _fmt_ts_pop_line(row) -> str:
    track = str(row["track_name"])
    dp = fmt_delta(row["pop_rank"], row.get("previous_pop_rank"))
    return f"- #{int(row['pop_rank'])} ({dp}) {track}"


def write_log(log, ts_df, ts_pop, chart_date, ts_history):
    log.log(f"Taylor Swift on {chart_date} :")
    log.log("")
    log.log("Spotify France :")

    present_today = set(ts_df["track_name"].astype(str).tolist())
    dropped_out = get_songs_present_yesterday(chart_date, ts_history) - present_today

    for _, row in ts_df.sort_values("rank").iterrows():
        log.log(_fmt_ts_song_line(row, chart_date, ts_history))

    for track in sorted(dropped_out):
        yesterday = str(parse_date(chart_date) - timedelta(days=1))
        entry = ts_history.get(track, {}).get(yesterday, {})
        log.log(f"(OUT) {track} | last position #{entry.get('rank', '?')}")

    log.log("")
    log.log("Spotify France (Pop) :")
    if ts_pop is None or ts_pop.empty:
        log.log("- Aucune chanson TS dans le Top Pop.")
    else:
        for _, row in ts_pop.sort_values("pop_rank").iterrows():
            log.log(_fmt_ts_pop_line(row))


def _fmt_date(chart_date: str) -> str:
    d = datetime.strptime(chart_date, "%Y-%m-%d")
    return d.strftime("%A, %B %d %Y")


def generate_tweet(ts_df, ts_pop, chart_date, ts_history) -> str:
    lines = [f"Taylor Swift on {_fmt_date(chart_date)}", "", "Spotify France :", ""]
    top_track = None

    present_today = set(ts_df["track_name"].astype(str).tolist())
    dropped_out = get_songs_present_yesterday(chart_date, ts_history) - present_today

    for _, row in ts_df.sort_values("rank").iterrows():
        if top_track is None:
            top_track = str(row["track_name"])
        lines.append(_fmt_ts_song_line(row, chart_date, ts_history))

    for track in sorted(dropped_out):
        yesterday = str(parse_date(chart_date) - timedelta(days=1))
        entry = ts_history.get(track, {}).get(yesterday, {})
        lines.append(f"(OUT) {track} | last position #{entry.get('rank', '?')}")

    lines += ["", "Spotify France (Pop) :", ""]
    if ts_pop is None or ts_pop.empty:
        lines.append("- Aucune chanson TS dans le Top Pop.")
    else:
        for _, row in ts_pop.sort_values("pop_rank").iterrows():
            lines.append(_fmt_ts_pop_line(row))

    video = VIDEO_LINKS.get(norm(top_track)) if top_track else None
    if video:
        lines += ["", f"  {video}"]

    return "\n".join(lines)


def process_one(chart_date: str, db, ts_history):
    print(f"Scrape du chart France pour {chart_date} ...")
    rows = scrape_chart_rows(chart_date)
    if not rows:
        raise RuntimeError(f"Aucune ligne scrapee pour {chart_date}")

    df = pd.DataFrame(rows)
    if df.empty:
        raise RuntimeError(f"Aucune donnée exploitable pour {chart_date}")

    if not df["artist_names"].astype(str).str.contains(TS_NAME, case=False, na=False).any():
        out_dir = get_out_dir(chart_date)
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "no_ts.lock").touch()
        print(f"  {chart_date} - aucune chanson TS.")
        return 0

    tags_col, pop_col, album_col, rd_col, days_col = [], [], [], [], []
    new_calls = 0
    cd = parse_date(chart_date)

    for _, row in df.iterrows():
        track = str(row["track_name"])
        artist = str(row["artist_names"]).split(",")[0].strip()
        rank = int(row["rank"])
        is_ts = TS_NAME.lower() in str(row["artist_names"]).lower()

        if is_ts:
            tags, album, release_date, pop, fetched = get_song_data(db, artist, track, fetch_release_date=True)
            update(
                ts_history,
                track,
                chart_date,
                rank,
                row.get("streams"),
                previous_rank=row.get("previous_rank"),
                peak_rank=row.get("peak_rank"),
            )
            if fetched:
                new_calls += 1
                if new_calls % 10 == 0:
                    save_db(db)

            tags_col.append("; ".join(tags))
            album_col.append(album or "")
            rd_col.append(release_date or "")
            rd = parse_date(release_date)
            days_col.append((cd - rd).days if rd and cd else "")
        else:
            pop = get_pop_for_nonts(db, artist, track)
            tags_col.append("")
            album_col.append("")
            rd_col.append("")
            days_col.append("")

        pop_col.append(pop)

    df["lastfm_tags"] = tags_col
    df["pop_flag"] = pop_col
    df["album"] = album_col
    df["release_date"] = rd_col
    df["days_since_release"] = days_col

    pop_df = df[df["pop_flag"]].sort_values("rank").copy()
    pop_df.insert(0, "pop_rank", range(1, len(pop_df) + 1))

    pop_prev = pop_df[
        pop_df["previous_rank"].notna() & (pop_df["previous_rank"] > 0)
    ].sort_values("previous_rank")
    prev_map = {idx: i + 1 for i, idx in enumerate(pop_prev.index)}
    pop_df["previous_pop_rank"] = pop_df.index.map(prev_map)

    out_dir = get_out_dir(chart_date)
    out_dir.mkdir(parents=True, exist_ok=True)

    ts_df = df[df["artist_names"].astype(str).str.contains(TS_NAME, case=False, na=False)].copy()
    ts_pop = pop_df[pop_df["artist_names"].astype(str).str.contains(TS_NAME, case=False, na=False)].copy()

    ts_df.to_csv(out_dir / "ts_all_songs.csv", index=False)
    if not ts_pop.empty:
        ts_pop.to_csv(out_dir / "ts_pop_songs.csv", index=False)

    # JSON pour generate_chart_image.py
    ts_rows_json = [
        {k: (None if (isinstance(v, float) and str(v) == "nan") else v)
         for k, v in r.items()}
        for r in ts_df.to_dict(orient="records")
    ]
    (out_dir / f"ts_chart_{chart_date}.json").write_text(
        json.dumps(ts_rows_json, ensure_ascii=False), encoding="utf-8"
    )

    log = Logger()
    write_log(log, ts_df, ts_pop, chart_date, ts_history)

    tweet = generate_tweet(ts_df, ts_pop, chart_date, ts_history)
    (out_dir / "tweet.txt").write_text(tweet, encoding="utf-8")

    print(f"  OK {chart_date} -> {out_dir}/")
    return new_calls


def rebuild_from_ts_csvs(root: Path) -> dict:
    history = {}
    for csv_file in sorted(root.rglob("ts_all_songs.csv")):
        try:
            chart_date = csv_file.parent.name
            df = pd.read_csv(csv_file)
            for _, row in df.iterrows():
                update(
                    history,
                    str(row["track_name"]),
                    chart_date,
                    int(row["rank"]),
                    row.get("streams"),
                    previous_rank=row.get("previous_rank"),
                    peak_rank=row.get("peak_rank"),
                )
        except Exception as e:
            print(f"Ignore {csv_file}: {e}")
    return history


def discover_dates():
    dates = []
    for year_dir in sorted(ROOT.iterdir()):
        if not year_dir.is_dir() or not re.match(r"^\d{4}$", year_dir.name):
            continue
        for month_dir in sorted(year_dir.iterdir()):
            if not month_dir.is_dir():
                continue
            for day_dir in sorted(month_dir.iterdir()):
                if day_dir.is_dir() and re.match(r"^\d{4}-\d{2}-\d{2}$", day_dir.name):
                    dates.append(day_dir.name)
    return dates


def main():
    args = sys.argv[1:]
    run_all = "--all" in args
    run_relog = "--relog" in args
    target = None if run_all or run_relog else (args[0] if args else None)

    db = load_db()
    h = load(ROOT / "ts_history.json")

    if run_relog:
        for year_dir in sorted(ROOT.iterdir()):
            if not year_dir.is_dir() or not re.match(r"^\d{4}$", year_dir.name):
                continue
            for month_dir in sorted(year_dir.iterdir()):
                if not month_dir.is_dir():
                    continue
                for day_dir in sorted(month_dir.iterdir()):
                    if not (day_dir.is_dir() and re.match(r"^\d{4}-\d{2}-\d{2}$", day_dir.name)):
                        continue
                    if not (day_dir / "ts_all_songs.csv").exists():
                        continue

                    ts_df = pd.read_csv(day_dir / "ts_all_songs.csv")
                    ts_pop = None
                    if (day_dir / "ts_pop_songs.csv").exists():
                        ts_pop = pd.read_csv(day_dir / "ts_pop_songs.csv")

                    log = Logger()
                    write_log(log, ts_df, ts_pop, day_dir.name, h)
                    tweet = generate_tweet(ts_df, ts_pop, day_dir.name, h)
                    (day_dir / "tweet.txt").write_text(tweet, encoding="utf-8")
                    print(f"  OK {day_dir.name} regenere")
        return

    if run_all:
        dates = discover_dates()
        to_process = [
            d for d in sorted(dates)
            if not (get_out_dir(d) / "ts_all_songs.csv").exists()
            and not (get_out_dir(d) / "no_ts.lock").exists()
        ]

        print(f"\n{len(to_process)} jours a traiter\n")
        for d in to_process:
            try:
                process_one(d, db, h)
                save_db(db)
            except Exception as e:
                print(f"  X {d} - {e}")

        history = rebuild_from_ts_csvs(ROOT)
        save(history, ROOT / "ts_history.json")
        print(f"  ts_history rebuilt - {len(history)} chansons")
        return

    if not target:
        raise RuntimeError("Donne une date: python filter.py YYYY-MM-DD")

    process_one(target, db, h)
    save_db(db)
    history = rebuild_from_ts_csvs(ROOT)
    save(history, ROOT / "ts_history.json")
    print(f"  ts_history rebuilt - {len(history)} chansons")


if __name__ == "__main__":
    main()