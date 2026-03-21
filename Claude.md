# Taylor Swift Museum — Project Context

## Purpose

Tracks Taylor Swift's Spotify performance across two dimensions:
- **Streaming stats** (daily plays, milestone forecasting, history)
- **Chart positions** (France regional daily + Global daily)

Data is collected automatically each day, committed to the repo, and the website is regenerated.

---

## Architecture

```
repo/
├── collectors/          # Data collection scripts
│   ├── spotify/
│   │   ├── core/        # Shared utilities (twitter.py, notify.py, fmt.py, history.py, logger.py)
│   │   ├── charts/
│   │   │   ├── fr/      # France charts daily pipeline
│   │   │   └── global/  # Global charts daily pipeline
│   │   └── streams/     # Streaming stats pipeline
│   └── billboard/       # Billboard chart scraper
├── db/
│   ├── discography/     # Source of truth: songs.json, albums.json, covers.json, artist.json
│   ├── charts_history_fr.csv
│   ├── charts_history_global.csv
│   ├── streams_history.csv
│   └── billboard_history.csv
├── scripts/             # Root-level convenience scripts (run from repo root)
│   ├── export_for_web.py   → regenerate website/site/data/ from db/
│   ├── fill_images.py      → fill image_url in db/discography/ + track_covers.json
│   └── fix_song_images.py  → Playwright scraper to get song images via og:image
├── website/
│   └── site/            # Static site files (HTML, JS, CSS, data/)
└── Claude.md
```

---

## Daily Workflows

### Streams (manual trigger or cron)
```bash
python collectors/spotify/streams/update_streams.py
python scripts/export_for_web.py
```

### Charts FR
```bash
python collectors/spotify/charts/fr/daily.py          # full run + Twitter post
python collectors/spotify/charts/fr/daily_no_post.py  # regenerate only, no post
```

### Charts Global
```bash
python collectors/spotify/charts/global/daily.py
python collectors/spotify/charts/global/daily_no_post.py
```

---

## Directory Structure for Charts

Both FR and Global follow the same layout under their respective root:

```
collectors/spotify/charts/<fr|global>/
├── daily.py                  # Main orchestrator (wait → filter → image → tweet → git)
├── daily_no_post.py          # Same but skip Twitter and posted.lock
├── history/                  # Daily output data
│   └── YYYY/MM/YYYY-MM-DD/
│       ├── ts_all_songs.csv
│       ├── ts_chart_YYYY-MM-DD.json
│       ├── tweet.txt
│       ├── chart_image.png
│       └── posted.lock       # created after successful Twitter post
└── tools/
    ├── json/                 # Credentials and persistent state
    │   ├── spotify_session.json    (Playwright session — DO NOT COMMIT if refreshed)
    │   ├── twitter_session.json    (Playwright session)
    │   ├── ts_history.json         (track → date → {rank, streams, ...})
    │   ├── ts_pop_history.json     (FR only — pop ranking history)
    │   ├── songs_db.json           (Last.fm / MusicBrainz cache)
    │   └── total_days.json         (days on chart per track)
    ├── headers/              # Header images for chart PNG (860×80px)
    ├── scripts/  (FR)        # Helper modules called by daily.py
    │   ├── filter.py               → scrape page, extract TS songs, write CSVs + tweet.txt
    │   ├── generate_chart_image.py → render chart PNG via Playwright + PIL
    │   ├── git_ops.py              → git commit/push helpers
    │   └── config.py               → LASTFM_API_KEY, NTFY_TOPIC
    └── script/  (Global)     # Same as above for global
        ├── filter.py
        ├── generate_chart_image.py
        ├── git_ops.py
        ├── migrate_charts_to_csv.py
        └── config.py
```

---

## Path Conventions

| Variable | Resolves to |
|----------|-------------|
| `ROOT` | `charts/<fr\|global>/` |
| `ROOT / "history"` | Daily output directory root |
| `ROOT / "tools/json/<file>"` | Sessions and persistent JSON |
| `ROOT / "tools/scripts/"` (FR) or `ROOT / "tools/script/"` (Global) | Helper scripts |
| `Path(__file__).parents[4]` (from tools/scripts/) | `collectors/spotify/` (for core imports) |
| `Path(__file__).parents[6]` (from tools/scripts/) | Repo root (for db/ access) |

---

## Image Pipeline

1. **`scripts/fix_song_images.py`** — Playwright scraper, reads og:image meta tag from each Spotify track URL, writes `image_url` into `db/discography/songs.json`
2. **`scripts/fill_images.py`** — fills `image_url` in all `db/discography/*.json` files using: songs.json track-ID lookup → covers.json album fallback → oEmbed API. Also generates `website/spotify-charts/track_covers.json` for the chart tracker.
3. **`scripts/export_for_web.py`** — regenerates `website/site/data/` (songs.json, albums.json, etc.) from `db/discography/`.

Run order when images are missing:
```bash
python scripts/fix_song_images.py          # fill db/discography/songs.json
python scripts/fill_images.py              # propagate to all edition JSONs
python scripts/export_for_web.py           # rebuild website data
```

---

## Database (db/discography/)

- **songs.json** — flat list of all tracks with fields: `title`, `url`, `album`, `image_url`, `type`, `edition`, `song_family`, `version_tag`, etc.
- **albums.json** — list of sections, each with `album`, `section`, `tracks[]`
- **covers.json** — map of album name → `{title, cover_url}`
- **artist.json** — basic artist metadata

---

## Dependencies

- `playwright` (Chromium) — chart scraping + image extraction
- `pandas` — CSV handling
- `requests` — Last.fm / MusicBrainz APIs
- `Pillow` (optional) — dominant color extraction for chart images
- `ntfy` — push notifications (topic in `tools/json/config.py`)

---

## Notes

- Sessions (`spotify_session.json`, `twitter_session.json`) are stored in `tools/json/` and must be refreshed manually when expired via the Playwright browser.
- The `posted.lock` file prevents re-posting the same day.
- FR charts use a `ts_pop_history.json` for pop-ranking tracking (not in global).
- `charts_history_fr.csv` and `charts_history_global.csv` in `db/` are the long-term archive CSVs — the filter scripts append to them directly.
