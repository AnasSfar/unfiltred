#!/usr/bin/env python3
"""
Télécharge les CSV Spotify France.
Usage : python download.py 2025-10-03 [2025-12-31]
"""
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from core.download import download_charts, parse_date_arg

ROOT          = Path(__file__).parent
CHART_ID      = "regional-fr-daily"
SESSION_FILE  = ROOT / "spotify_session.json"
FILTER_SCRIPT = ROOT / "filter.py"
REBUILD_SCRIPT = ROOT / "rebuild.py"


def main():
    if len(sys.argv) < 2:
        print("Usage : python download.py DATE_DEBUT [DATE_FIN]")
        sys.exit(1)
    start = parse_date_arg(sys.argv[1])
    end   = parse_date_arg(sys.argv[2]) if len(sys.argv) > 2 else date.today() - timedelta(days=1)
    if start > end:
        print(f"Erreur : {start} > {end}")
        sys.exit(1)
    download_charts(ROOT, CHART_ID, SESSION_FILE, FILTER_SCRIPT, REBUILD_SCRIPT, start, end)


if __name__ == "__main__":
    main()
