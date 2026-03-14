#!/usr/bin/env python3
#lancer la tache manuellement :  schtasks /run /tn "SpotifyDaily" 
"""
run_all.py
Lance Fr/daily.py et Global/daily.py en parallele.
Usage : python run_all.py [YYYY-MM-DD]
"""
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).parent
FR_DAILY     = ROOT / "Fr"     / "daily.py"
GLOBAL_DAILY = ROOT / "Global" / "daily.py"

LOG_FILE = ROOT / "run_all.log"
_log_lock = threading.Lock()


def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with _log_lock:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def stream_output(proc, label, results, idx):
    for raw in proc.stdout:
        line = raw.rstrip("\n")
        if line.strip():
            log(f"[{label}] {line}")
    proc.wait()
    results[idx] = proc.returncode


def main():
    date_arg = sys.argv[1] if len(sys.argv) > 1 else None
    cmd_extra = [date_arg] if date_arg else []

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n{'='*50}\n")

    log(f"Lancement Fr + Global en parallele{' pour ' + date_arg if date_arg else ''}...")

    env = {"PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
    import os; env = {**os.environ, **env}

    proc_fr = subprocess.Popen(
        [sys.executable, "-u", str(FR_DAILY)] + cmd_extra,
        cwd=str(ROOT / "Fr"),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    proc_gl = subprocess.Popen(
        [sys.executable, "-u", str(GLOBAL_DAILY)] + cmd_extra,
        cwd=str(ROOT / "Global"),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )

    results = [None, None]

    t_fr = threading.Thread(target=stream_output, args=(proc_fr, "Fr",     results, 0))
    t_gl = threading.Thread(target=stream_output, args=(proc_gl, "Global", results, 1))
    t_fr.start()
    t_gl.start()
    t_fr.join()
    t_gl.join()

    fr_ok = results[0] == 0
    gl_ok = results[1] == 0
    log("=" * 40)
    log(f"Fr     : {'OK' if fr_ok else f'ERREUR (code {results[0]})'}")
    log(f"Global : {'OK' if gl_ok else f'ERREUR (code {results[1]})'}")

    if not fr_ok or not gl_ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
