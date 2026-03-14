#!/usr/bin/env python3
"""
Reconstruit ts_history.json depuis tous les ts_all_songs.csv existants.
Lancer depuis Fr\ ou Global\

Usage : python ..\tools\rebuild.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from core.history import rebuild_from_csvs, save

ROOT = Path.cwd()


def main():
    print(f"Reconstruction de ts_history.json dans {ROOT}")
    history = rebuild_from_csvs(ROOT, "")
    save(history, ROOT / "ts_history.json")
    total = sum(len(v) for v in history.values())
    print(f"\n✓ Terminé")
    print(f"  Chansons  : {len(history)}")
    print(f"  Entrées   : {total}")


if __name__ == "__main__":
    main()
