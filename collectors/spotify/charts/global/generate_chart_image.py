#!/usr/bin/env python3
"""
generate_chart_image.py — génère le PNG du chart Taylor Swift Global.
Design adapté depuis unfiltered-charts (light glassmorphism).

Lit  : {date_dir}/ts_chart_{date}.json  +  ts_history.json
       + unfiltered-charts/discography/albums/covers.json  (couvertures albums)
Ecrit: {date_dir}/chart_image.png

Usage: python generate_chart_image.py YYYY-MM-DD
"""
import colorsys
import json
import random
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

try:
    from PIL import Image
    _PIL = True
except ImportError:
    _PIL = False

ROOT             = Path(__file__).parent
TS_HISTORY_PATH  = ROOT / "ts_history.json"
DISCOGRAPHY_ROOT = ROOT.parent.parent.parent.parent / "website" / "discography"
COVERS_PATH      = DISCOGRAPHY_ROOT / "albums" / "covers.json"
HEADERS_DIR      = ROOT / "headers"
HANDLE           = "@swiftiescharts"


# ---------------------------------------------------------------------------
# Header image + dominant colour
# ---------------------------------------------------------------------------

def pick_header_image() -> Path | None:
    """Returns a random image from the headers folder (should be 860×80px)."""
    if not HEADERS_DIR.exists():
        return None
    imgs = [p for p in HEADERS_DIR.iterdir()
            if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]
    return random.choice(imgs) if imgs else None


def get_dominant_color(img_path: Path) -> str:
    """Returns a vibrant hex colour extracted from the image."""
    if not _PIL:
        return "#1db954"
    try:
        img = Image.open(img_path).convert("RGB").resize((60, 60), Image.LANCZOS)
        pixels = list(img.getdata())
        # Ignore near-white and near-black
        filtered = [
            (r, g, b) for r, g, b in pixels
            if not (r > 210 and g > 210 and b > 210)
            and not (r < 40  and g < 40  and b < 40)
        ]
        if not filtered:
            filtered = pixels
        r = sum(p[0] for p in filtered) // len(filtered)
        g = sum(p[1] for p in filtered) // len(filtered)
        b = sum(p[2] for p in filtered) // len(filtered)
        # Boost saturation so the handle pops
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        s = min(1.0, s * 1.8)
        v = min(1.0, max(0.55, v))
        r2, g2, b2 = colorsys.hsv_to_rgb(h, s, v)
        return f"#{int(r2*255):02x}{int(g2*255):02x}{int(b2*255):02x}"
    except Exception:
        return "#1db954"


# ---------------------------------------------------------------------------
# Album cover lookup from discography
# ---------------------------------------------------------------------------

def _norm(s: str) -> str:
    """Normalize album/track name to a simple key for matching."""
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_")


def build_cover_map() -> dict:
    """Returns {normalized_album_title → cover_url} from covers.json."""
    if not COVERS_PATH.exists():
        return {}
    covers = json.loads(COVERS_PATH.read_text(encoding="utf-8"))
    result = {}
    for v in covers.values():
        key = _norm(v.get("title", ""))
        if key and "cover_url" in v:
            result[key] = v["cover_url"]
    return result


def build_track_album_map() -> dict:
    """Scans all discography album JSONs → {normalized_track_title → album_title}."""
    albums_dir = DISCOGRAPHY_ROOT / "albums"
    result = {}
    if not albums_dir.exists():
        return result
    for json_file in albums_dir.rglob("*.json"):
        if json_file.name == "covers.json":
            continue
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
            album_name = data.get("album", "")
            for track in data.get("tracks", []):
                title = track.get("title", "")
                if title:
                    result[_norm(title)] = album_name
        except Exception:
            pass
    return result


def get_album_cover(
    track_name: str,
    track_album_map: dict,
    cover_map: dict,
    fallback_url: str = "",
) -> str:
    """
    Returns cover URL for a track.
    Priority: discography covers.json > scraped Spotify CDN URL.
    """
    album_name = track_album_map.get(_norm(track_name), "")
    if album_name:
        cover = cover_map.get(_norm(album_name), "")
        if cover:
            return cover
    return fallback_url or ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def fmt_streams(n) -> str:
    if n is None:
        return "—"
    return f"{int(n):,}".replace(",", "\u202f")   # narrow no-break space


def fmt_pct(pct) -> str:
    if pct is None:
        return "—"
    sign = "+" if pct >= 0 else ""
    return f"{sign}{pct:.1f}%"


def pct_cls(pct) -> str:
    if pct is None:
        return "neutral"
    return "pos" if pct >= 0 else "neg"


def get_pct(today, ref):
    if not today or not ref or ref == 0:
        return None
    return (today - ref) / ref * 100


def rank_change(rank, previous_rank):
    if previous_rank is None:
        return "NEW", "chg-new"
    delta = int(previous_rank) - int(rank)
    if delta > 0:
        return f"▲{delta}", "chg-up"
    elif delta < 0:
        return f"▼{abs(delta)}", "chg-dn"
    return "—", "chg-eq"


def nan_to_none(v):
    try:
        import math
        if isinstance(v, float) and math.isnan(v):
            return None
    except Exception:
        pass
    return v



# ---------------------------------------------------------------------------
# HTML / CSS
# ---------------------------------------------------------------------------

CSS = """
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:Inter,-apple-system,'Helvetica Neue',Arial,sans-serif;
  background:
    radial-gradient(circle at 12% 18%, rgba(29,185,84,.13), transparent 30%),
    radial-gradient(circle at 84% 16%, rgba(126,87,255,.10), transparent 32%),
    linear-gradient(180deg,#f4f7f8 0%,#edf3f4 100%);
  width:800px;
  padding:16px;
  color:#101828;
}
.container{
  border-radius:18px;
  overflow:hidden;
  box-shadow:0 14px 40px rgba(16,24,40,.10),0 2px 8px rgba(16,24,40,.06);
}
/* Header */
.hdr{
  padding:49px 22px;
  display:flex;align-items:center;gap:16px;
}
.hdr-logo{width:52px;height:52px;flex-shrink:0}
.hdr-title{color:#fff;font-size:22px;font-weight:800;letter-spacing:-.3px}
.hdr-sub{color:rgba(255,255,255,.85);font-size:13px;margin-top:4px}
/* Column headers */
.col-heads{
  display:grid;
  grid-template-columns:52px 60px minmax(180px,1fr) 112px 74px 74px 50px 60px;
  column-gap:8px;
  padding:7px 14px;
  background:rgba(241,245,246,.95);
  border-bottom:1px solid rgba(16,24,40,.07);
}
.col-heads span{
  font-size:10px;font-weight:700;text-transform:uppercase;
  letter-spacing:.07em;color:#667085;
  display:flex;align-items:center;
}
.col-heads .right{justify-content:flex-end}
/* Song cards */
.song-card{
  display:grid;
  grid-template-columns:52px 60px minmax(180px,1fr) 112px 74px 74px 50px 60px;
  column-gap:8px;
  align-items:center;
  padding:9px 14px;
  background:rgba(255,255,255,.82);
  border-bottom:1px solid rgba(16,24,40,.05);
}
.song-card.row-odd{background:rgba(248,250,251,.88)}
.song-card.row-gold{
  background:linear-gradient(90deg,#fff7d6 0%,#fffdf5 40%,rgba(255,255,255,.92) 100%);
  border-left:3px solid #ebc44c;
}
/* Rank */
.col-rank{
  font-size:17px;font-weight:900;color:#0b1f44;
  letter-spacing:-.04em;
  display:flex;align-items:center;justify-content:center;
}
/* Change */
.col-chg{
  font-size:11px;font-weight:700;
  display:flex;align-items:center;justify-content:center;
}
.chg-up{color:#067647}
.chg-dn{color:#b42318}
.chg-eq{color:#9ca3af}
.chg-new{color:#1db954;font-size:10px;font-weight:800}
/* Song */
.col-song{display:flex;align-items:center;gap:10px;min-width:0}
.art{
  width:42px;height:42px;border-radius:6px;
  flex-shrink:0;object-fit:cover;
  box-shadow:0 2px 8px rgba(0,0,0,.12);
}
.art-ph{
  width:42px;height:42px;border-radius:6px;
  background:#dde3ea;flex-shrink:0;
}
.song-info{min-width:0}
.song-title{
  font-size:13px;font-weight:700;color:#101828;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.song-artist{font-size:11px;color:#667085;margin-top:2px}
/* Numeric columns */
.col-num{
  font-size:12px;color:#344054;font-weight:500;
  display:flex;align-items:center;justify-content:flex-end;
}
.pos{color:#067647;font-weight:600}
.neg{color:#b42318;font-weight:600}
.neutral{color:#667085}
/* Footer */
.ftr{
  background:rgba(241,245,246,.96);
  padding:8px 16px;
  display:flex;justify-content:space-between;align-items:center;
  border-top:1px solid rgba(16,24,40,.07);
}
.ftr-handle{font-size:11px;color:#1db954;font-weight:700}
.ftr-date{font-size:11px;color:#667085;font-weight:500}
"""

SPOTIFY_SVG = """<svg class="hdr-logo" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
</svg>"""


def build_rows_html(
    rows,
    history,
    chart_date: str,
    track_album_map: dict,
    cover_map: dict,
) -> str:
    date_obj  = datetime.strptime(chart_date, "%Y-%m-%d").date()
    yesterday = str(date_obj - timedelta(days=1))
    week_ago  = str(date_obj - timedelta(days=7))

    html = ""
    for i, row in enumerate(rows):
        track      = str(row.get("track_name") or "")
        artist     = str(row.get("artist_names") or "")
        rank       = nan_to_none(row.get("rank"))
        prev_rank  = nan_to_none(row.get("previous_rank"))
        streams    = nan_to_none(row.get("streams"))
        streak     = nan_to_none(row.get("streak"))
        scraped_img = row.get("image_url") or ""

        if rank is None:
            continue
        rank = int(rank)

        chg_text, chg_css = rank_change(rank, int(prev_rank) if prev_rank else None)

        # Album cover: discography lookup → fallback to scraped CDN URL
        cover_url = get_album_cover(track, track_album_map, cover_map, scraped_img)

        # Daily / weekly % from ts_history
        track_hist   = history.get(track, {})
        prev_streams = (track_hist.get(yesterday) or {}).get("streams")
        week_streams = (track_hist.get(week_ago)  or {}).get("streams")
        streams_int  = int(streams) if streams else None

        daily_pct  = get_pct(streams_int, prev_streams)
        weekly_pct = get_pct(streams_int, week_streams)

        total_days  = nan_to_none(row.get("total_days"))
        streams_fmt = fmt_streams(streams_int)
        daily_txt   = fmt_pct(daily_pct)
        weekly_txt  = fmt_pct(weekly_pct)
        # streak from Spotify row = consecutive days in current run
        consec_txt     = str(int(streak)) + "d" if streak else "—"
        # total_days scraped from Spotify expanded detail
        total_days_txt = str(int(total_days)) + "d" if total_days else "—"

        art_html = (
            f'<img class="art" src="{cover_url}" />'
            if cover_url
            else '<div class="art-ph"></div>'
        )

        card_cls = "song-card"
        if rank == 1:
            card_cls += " row-gold"
        elif i % 2 != 0:
            card_cls += " row-odd"

        html += f"""<div class="{card_cls}">
  <div class="col-rank">#{rank}</div>
  <div class="col-chg {chg_css}">{chg_text}</div>
  <div class="col-song">
    {art_html}
    <div class="song-info">
      <div class="song-title">{track}</div>
      <div class="song-artist">{artist}</div>
    </div>
  </div>
  <div class="col-num">{streams_fmt}</div>
  <div class="col-num {pct_cls(daily_pct)}">{daily_txt}</div>
  <div class="col-num {pct_cls(weekly_pct)}">{weekly_txt}</div>
  <div class="col-num">{consec_txt}</div>
  <div class="col-num">{total_days_txt}</div>
</div>
"""
    return html


def build_html(
    rows,
    history,
    chart_date: str,
    track_album_map: dict,
    cover_map: dict,
    header_img: Path | None = None,
) -> str:
    date_fmt  = datetime.strptime(chart_date, "%Y-%m-%d").strftime("%B %d, %Y")
    rows_html = build_rows_html(rows, history, chart_date, track_album_map, cover_map)

    if header_img is None:
        header_img = pick_header_image()
    handle_color = "#1db954"

    if header_img:
        handle_color = get_dominant_color(header_img)
        img_url      = header_img.as_posix()
        hdr_style    = (
            f'style="background-image: linear-gradient(rgba(0,0,0,.45),rgba(0,0,0,.45)),'
            f'url(\'file:///{img_url}\'); background-size:100% 100%;"'
        )
    else:
        hdr_style = 'style="background:linear-gradient(135deg,#1db954 0%,#17a34a 100%);"'

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>{CSS}</style></head>
<body>
<div class="container">
  <div class="hdr" {hdr_style}>
    {SPOTIFY_SVG}
    <div>
      <div class="hdr-title">Taylor Swift · Global Spotify</div>
      <div class="hdr-sub">Daily Chart · {date_fmt}</div>
    </div>
  </div>
  <div class="col-heads">
    <span>Pos</span>
    <span>Chg</span>
    <span>Track</span>
    <span class="right">Streams</span>
    <span class="right">Daily</span>
    <span class="right">Weekly</span>
    <span class="right">Streak</span>
    <span class="right">Total</span>
  </div>
  {rows_html}
  <div class="ftr">
    <span class="ftr-handle" style="color:{handle_color}">{HANDLE}</span>
    <span class="ftr-date">{date_fmt}</span>
  </div>
</div>
</body></html>"""


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def generate(chart_date: str, header_img: Path | None = None) -> Path:
    date_dir  = ROOT / chart_date[:4] / chart_date[5:7] / chart_date
    json_path = date_dir / f"ts_chart_{chart_date}.json"
    out_path  = date_dir / "chart_image.png"

    if not json_path.exists():
        raise FileNotFoundError(f"ts_chart_{chart_date}.json introuvable: {json_path}")

    rows    = load_json(json_path)
    history = load_json(TS_HISTORY_PATH) if TS_HISTORY_PATH.exists() else {}

    if not rows:
        raise ValueError(f"Aucune chanson TS dans {json_path}")

    cover_map       = build_cover_map()
    track_album_map = build_track_album_map()

    html     = build_html(rows, history, chart_date, track_album_map, cover_map, header_img=header_img)
    html_tmp = date_dir / "_chart_tmp.html"
    html_tmp.write_text(html, encoding="utf-8")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page    = browser.new_page(viewport={"width": 800, "height": 200}, device_scale_factor=2)
            page.goto(f"file:///{html_tmp.as_posix()}", wait_until="load")
            page.wait_for_timeout(2000)
            page.locator("body").screenshot(path=str(out_path))
            browser.close()
    finally:
        if html_tmp.exists():
            html_tmp.unlink()

    print(f"OK image: {out_path}")
    return out_path


def generate_all_headers(chart_date: str) -> list[Path]:
    """Génère une image par photo dans headers/, nommée chart_image_<photo>.png."""
    if not HEADERS_DIR.exists():
        print("Dossier headers/ introuvable")
        return []

    imgs = [p for p in sorted(HEADERS_DIR.iterdir())
            if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]
    if not imgs:
        print("Aucune photo dans headers/")
        return []

    date_dir  = ROOT / chart_date[:4] / chart_date[5:7] / chart_date
    json_path = date_dir / f"ts_chart_{chart_date}.json"
    if not json_path.exists():
        raise FileNotFoundError(f"ts_chart_{chart_date}.json introuvable: {json_path}")

    rows    = load_json(json_path)
    history = load_json(TS_HISTORY_PATH) if TS_HISTORY_PATH.exists() else {}
    cover_map       = build_cover_map()
    track_album_map = build_track_album_map()

    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        for img_path in imgs:
            out_path = date_dir / f"chart_image_{img_path.stem}.png"
            html     = build_html(rows, history, chart_date, track_album_map, cover_map, header_img=img_path)
            html_tmp = date_dir / "_chart_tmp.html"
            html_tmp.write_text(html, encoding="utf-8")
            try:
                page = browser.new_page(viewport={"width": 860, "height": 200}, device_scale_factor=2)
                page.goto(f"file:///{html_tmp.as_posix()}", wait_until="load")
                page.wait_for_timeout(2000)
                page.locator("body").screenshot(path=str(out_path))
                page.close()
                print(f"OK: {out_path.name}")
                results.append(out_path)
            finally:
                if html_tmp.exists():
                    html_tmp.unlink()
        browser.close()

    print(f"\n{len(results)} images générées dans {date_dir}/")
    return results


def main():
    args = sys.argv[1:]
    if not args:
        print("Usage:")
        print("  python generate_chart_image.py YYYY-MM-DD")
        print("  python generate_chart_image.py YYYY-MM-DD --all-headers   # une image par photo")
        print("  python generate_chart_image.py YYYY-MM-DD photo.jpg       # photo précise")
        sys.exit(1)

    chart_date = args[0]

    if "--all-headers" in args:
        generate_all_headers(chart_date)
    elif len(args) >= 2 and not args[1].startswith("--"):
        header_path = Path(args[1])
        if not header_path.is_absolute():
            header_path = ROOT / "headers" / header_path
        generate(chart_date, header_img=header_path)
    else:
        generate(chart_date)


if __name__ == "__main__":
    main()
