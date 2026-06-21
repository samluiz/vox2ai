#!/usr/bin/env python3
"""Build the vox2ai-server sidecar executable using PyInstaller."""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "packaging" / "pyinstaller" / "vox2ai-server.spec"
DIST_DIR = ROOT / "dist"


def main() -> None:
    if not SPEC.is_file():
        print(f"Error: spec file not found at {SPEC}", file=sys.stderr)
        sys.exit(1)

    print(f"[vox2ai] Building sidecar from {SPEC}")

    DIST_DIR.mkdir(parents=True, exist_ok=True)

    env = {**os.environ, "VOX2AI_PROJECT_ROOT": str(ROOT)}
    result = subprocess.run(
        [sys.executable, "-m", "PyInstaller", str(SPEC), "--distpath", str(DIST_DIR), "--clean"],
        cwd=str(ROOT),
        env=env,
    )

    if result.returncode != 0:
        print(f"[vox2ai] PyInstaller failed with exit code {result.returncode}", file=sys.stderr)
        sys.exit(result.returncode)

    # Verify the artifact exists.
    binary = DIST_DIR / "vox2ai-server"
    if not binary.is_file() and not (DIST_DIR / "vox2ai-server.exe").is_file():
        print("[vox2ai] Warning: expected binary not found in dist/", file=sys.stderr)
    else:
        print(f"[vox2ai] Sidecar built at {binary}")


if __name__ == "__main__":
    main()
