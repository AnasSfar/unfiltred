from __future__ import annotations

import subprocess
import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT  = _SCRIPT_DIR.parents[2]
ROOT        = _REPO_ROOT / "website"
EXPORT_SCRIPT = _SCRIPT_DIR / "export_for_web.py"


def main() -> None:
    print("Rebuilding site data from discography...")

    result = subprocess.run([sys.executable, str(EXPORT_SCRIPT)], cwd=ROOT)
    if result.returncode != 0:
        raise SystemExit("Export failed.")

    print("Done.")


if __name__ == "__main__":
    main()