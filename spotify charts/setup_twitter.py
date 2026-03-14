#!/usr/bin/env python3
"""
setup_twitter.py
Lance Chrome sur le compte voulu, tu te connectes manuellement.
A relancer seulement si la session expire.

Usage :
    python setup_twitter.py fr
    python setup_twitter.py global
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from core.twitter import setup_session

ACCOUNTS = {
    "fr":     Path(__file__).parent / "Fr"     / "twitter_session.json",
    "global": Path(__file__).parent / "Global" / "twitter_session.json",
}

if len(sys.argv) != 2 or sys.argv[1].lower() not in ACCOUNTS:
    print("Usage : python setup_twitter.py fr|global")
    sys.exit(1)

account = sys.argv[1].lower()
session_file = ACCOUNTS[account]

print(f"\nSetup Twitter — compte '{account}'")
print(f"Session : {session_file}\n")

# Desactive l'auto-login pour forcer la connexion manuelle
import json
data = json.loads(session_file.read_text(encoding="utf-8"))
if "username" in data:
    print(f"  Compte : @{data['username']}")

print("\nChrome va s'ouvrir. Connecte-toi manuellement au bon compte.")
print("Appuie sur ENTREE ici une fois connecte et sur l'accueil X.\n")

from playwright.sync_api import sync_playwright

profile_dir = session_file.parent / "chrome_profile"
profile_dir.mkdir(parents=True, exist_ok=True)

args = ["--disable-blink-features=AutomationControlled"]
with sync_playwright() as p:
    try:
        context = p.chromium.launch_persistent_context(
            str(profile_dir), headless=False, channel="chrome", args=args
        )
    except Exception:
        context = p.chromium.launch_persistent_context(
            str(profile_dir), headless=False, args=args
        )
    page = context.new_page()
    page.goto("https://x.com/login", wait_until="domcontentloaded")
    input("-> ENTREE une fois connecte : ")
    print(f"  URL finale : {page.url}")
    context.close()

print(f"\nOK Session sauvegardee dans : {profile_dir}")
print("Le daily.py utilisera cette session automatiquement.")
