#!/usr/bin/env python3
"""Build installable vox2ai desktop release artifacts."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE_DIR = ROOT / "desktop" / "src-tauri" / "target" / "release" / "bundle"


def step(label: str, cmd: list[str], cwd: Path = ROOT) -> None:
    print(f"\n==> {label}")
    result = subprocess.run(cmd, cwd=cwd)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def main() -> None:
    step("Validate version metadata", [sys.executable, "scripts/check_versions.py"])
    step("Build Python backend sidecar", [sys.executable, "scripts/build_sidecar.py"])
    step("Copy sidecar into Tauri binaries", [sys.executable, "scripts/copy_sidecar.py"])

    desktop = ROOT / "desktop"
    if not (desktop / "node_modules").is_dir():
        step("Install npm dependencies", ["npm", "install"], cwd=desktop)
    step("Build Tauri release bundle", ["npm", "run", "tauri", "build"], cwd=desktop)

    print("\n==> Release artifacts")
    if not BUNDLE_DIR.is_dir():
        print(f"[vox2ai] bundle directory not found: {BUNDLE_DIR}", file=sys.stderr)
        raise SystemExit(1)

    artifacts = sorted(
        path
        for path in BUNDLE_DIR.rglob("*")
        if path.suffix.lower() in {".appimage", ".deb", ".rpm", ".msi", ".exe", ".dmg"}
    )
    if not artifacts:
        print(f"[vox2ai] no installer artifacts found in {BUNDLE_DIR}", file=sys.stderr)
        raise SystemExit(1)
    for artifact in artifacts:
        print(artifact.relative_to(ROOT))


if __name__ == "__main__":
    main()
