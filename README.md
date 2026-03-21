# Taylor Swift Museum — Scripts Reference

Tracks Taylor Swift's Spotify performance: daily streaming stats, milestone forecasts, and chart positions (France + Global).

---

## Repository Layout

```
collectors/
  spotify/
    streams/                 # Streaming stats pipeline
    charts/
      fr/                    # France regional charts
      global/                # Global charts
    core/                    # Shared utilities (twitter, notify, fmt, history, logger)
  billboard/                 # Billboard chart scraper
db/
  discography/               # Source of truth (songs.json, albums.json, covers.json, artist.json)
  streams_history.csv
  charts_history_fr.csv
  charts_history_global.csv
  billboard_history.csv
scripts/                     # Root-level convenience wrappers
website/site/                # Static site (HTML/JS/CSS + generated data/)
```

---

## Daily Workflows

### Streams (manual or cron)
```bash
python collectors/spotify/streams/update_streams.py
python scripts/export_for_web.py          # if you want a standalone re-export
```

### Charts — France
```bash
python collectors/spotify/charts/fr/daily.py           # full run + Twitter post
python collectors/spotify/charts/fr/daily_no_post.py   # regenerate only, no post
```

### Charts — Global
```bash
python collectors/spotify/charts/global/daily.py
python collectors/spotify/charts/global/daily_no_post.py
```

---

## Script Reference

### `collectors/spotify/streams/update_streams.py`
Main streams collector. Scrapes every track's Spotify play count, writes history, posts top-15 image to Twitter, forecasts milestones, and pushes to git.

| Invocation | Effect |
|---|---|
| `python update_streams.py` | Normal run for yesterday's stats date |
| `python update_streams.py YYYY-MM-DD` | Normal run for a specific date |
| `python update_streams.py --debug-daily` | Retry unfinished tracks for yesterday — writes to history, **no** Twitter/git/forecast/images/notify |
| `python update_streams.py --debug-daily YYYY-MM-DD` | Same as above for a specific date |
| `python update_streams.py --debug-total YYYY-MM-DD` | Re-scrape totals and replace them for the given date; recomputes daily_streams — **no** Twitter/git/forecast/images/notify |
| `python update_streams.py --dry-run` | Scrape only, no writes anywhere |
| `python update_streams.py --reset-last-date` | Delete all rows for the latest date in history, then run normally |
| `python update_streams.py --reset-date YYYY-MM-DD` | Delete all rows for a specific date, then run normally |
| `python update_streams.py --help` | Print this usage |

**Notes:**
- The top-15 daily image is only generated (and posted to Twitter) once **100 % of `albums.json` tracks** have a row in `streams_history.csv` for that date. Extras from `songs.json` are not required.
- Milestone forecast (`forecast_milestones.py`) is skipped in all `--debug-*` modes.

---

### `collectors/spotify/streams/generate_streams_image.py`
Generates the top-15 daily streams PNG. Output goes to `history/YYYY/MM/YYYY-MM-DD/streams_image_YYYY-MM-DD.png`.

```bash
python generate_streams_image.py                  # uses latest date in CSV
python generate_streams_image.py 2026-03-20       # specific date
```

---

### `collectors/spotify/streams/tools/scripts/post_streams_twitter.py`
Generates the image for a date and posts it to Twitter. Creates a `posted.lock` in the day's history folder to prevent double-posting.

```bash
python post_streams_twitter.py                    # yesterday
python post_streams_twitter.py 2026-03-20         # specific date
```

---

### `collectors/spotify/streams/tools/scripts/forecast_milestones.py`
Reads `website/site/data/songs.json` + `website/site/history/` and writes `website/site/data/expected_milestones.json` with per-track milestone forecasts.

```bash
python forecast_milestones.py
```

---

### `collectors/spotify/streams/tools/scripts/rebuild_site.py`
Full local rebuild: re-export + forecast + image refresh. Useful after manual DB edits.

```bash
python rebuild_site.py
```

---

### `collectors/spotify/charts/fr/daily.py` and `daily_no_post.py`
France charts daily pipeline.

| Flag | Effect |
|---|---|
| *(none)* | Normal run: wait for page → filter → image → tweet → git |
| `--force` | Delete `posted.lock` for today and re-run the full pipeline |

`daily_no_post.py` skips Twitter and never creates `posted.lock`.

---

### `collectors/spotify/charts/global/daily.py` and `daily_no_post.py`
Global charts daily pipeline — same flags as FR above.

| Flag | Effect |
|---|---|
| *(none)* | Normal run |
| `--force` | Re-run even if already posted today |

---

### `scripts/export_for_web.py`
Rebuilds all `website/site/data/` files from `db/discography/` + `db/streams_history.csv`.

```bash
python scripts/export_for_web.py
```

---

### `scripts/fill_images.py`
Propagates `image_url` from `db/discography/songs.json` to all discography JSON files, and regenerates `website/spotify-charts/track_covers.json`.

```bash
python scripts/fill_images.py
```

---

### `scripts/fix_song_images.py`
Playwright scraper: opens each Spotify track URL, reads the `og:image` meta tag, and writes `image_url` into `db/discography/songs.json`.

```bash
python scripts/fix_song_images.py
```

Run order when covers are missing:
```bash
python scripts/fix_song_images.py
python scripts/fill_images.py
python scripts/export_for_web.py
```

---

### `collectors/spotify/streams/extras/fill_track_images.py`
Fetches missing track cover images from Spotify for all tracks that lack an `image_url`. Updates `db/discography/songs.json`.

```bash
python collectors/spotify/streams/extras/fill_track_images.py
```

---

## Key Data Files

| File | Purpose |
|---|---|
| `db/discography/albums.json` | Source of truth — standard + deluxe album tracks |
| `db/discography/songs.json` | Extra tracks (remixes, features, standalone releases) |
| `db/discography/covers.json` | Album cover URLs |
| `db/streams_history.csv` | Full daily stream history (`date, track_id, streams, daily_streams`) |
| `db/charts_history_fr.csv` | France daily chart archive |
| `db/charts_history_global.csv` | Global daily chart archive |
| `website/site/data/songs.json` | Generated — current stats per track |
| `website/site/data/expected_milestones.json` | Generated — milestone forecasts |
| `website/site/history/` | Generated — daily stream snapshots |

---

## Sessions

Playwright sessions must be refreshed manually when they expire:
- **Spotify:** `collectors/spotify/charts/<fr|global>/tools/json/spotify_session.json`
- **Twitter:** `collectors/spotify/streams/tools/json/twitter_session.json`

Open the corresponding Playwright browser, log in, and the session will be saved automatically.
