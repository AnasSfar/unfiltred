#!/usr/bin/env python3
"""Reconstruit ts_history.json pour Fr\. Usage : python rebuild.py"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))
from core.history import rebuild_from_csvs, save

ROOT = Path(__file__).parent

def main():
    print(f"Reconstruction de ts_history.json dans {ROOT}")
    history = rebuild_from_csvs(ROOT, "regional-fr-daily")
    save(history, ROOT / "ts_history.json")
    total = sum(len(v) for v in history.values())
    print(f"\n✓ Terminé — {len(history)} chansons, {total} entrées")

if __name__ == "__main__":
    main()
