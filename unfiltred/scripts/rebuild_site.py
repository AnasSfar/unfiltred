from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXPORT_SCRIPT = ROOT / "scripts" / "export_for_web.py"


def main() -> None:
    print("Rebuilding site data from discography...")

    result = subprocess.run([sys.executable, str(EXPORT_SCRIPT)], cwd=ROOT)
    if result.returncode != 0:
        raise SystemExit("Export failed.")

    print("Done.")


if __name__ == "__main__":
    main()