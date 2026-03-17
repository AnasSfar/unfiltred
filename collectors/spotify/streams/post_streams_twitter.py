#!/usr/bin/env python3
"""
post_streams_twitter.py — génère et poste l'image des top streams daily sur Twitter.

Usage:
  python post_streams_twitter.py               # stats_date (hier par défaut)
  python post_streams_twitter.py 2026-03-15    # date spécifique
"""
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

SCRIPT_DIR      = Path(__file__).resolve().parent
REPO_ROOT       = SCRIPT_DIR.parents[2]
TWITTER_SESSION = SCRIPT_DIR.parent / "charts" / "global" / "twitter_session.json"

sys.path.insert(0, str(SCRIPT_DIR.parent))
from core.twitter import post_with_image

import generate_streams_image


def main():
    target_date = sys.argv[1] if len(sys.argv) > 1 else str(date.today() - timedelta(days=1))

    # Guard against double-posting
    posted_lock = SCRIPT_DIR / f"{target_date}.streams_posted"
    if posted_lock.exists():
        print(f"Already posted for {target_date}, skipping.")
        return

    if not TWITTER_SESSION.exists():
        print(f"ERROR: Twitter session not found at {TWITTER_SESSION}")
        sys.exit(1)

    # Generate image
    print(f"Generating streams image for {target_date}...")
    image_path = generate_streams_image.generate(target_date)

    # Build tweet text
    date_fmt = datetime.strptime(target_date, "%Y-%m-%d").strftime("%B %d, %Y")
    tweet    = f"Taylor Swift's most streamed songs on {date_fmt} :"

    print(f"Tweet: {tweet}")
    print(f"Image: {image_path}")

    success = post_with_image(tweet, image_path, TWITTER_SESSION)

    if success:
        posted_lock.touch()
        print(f"Posted successfully for {target_date}.")
    else:
        print(f"Failed to post for {target_date}.")
        sys.exit(1)


if __name__ == "__main__":
    main()
