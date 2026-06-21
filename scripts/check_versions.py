#!/usr/bin/env python3
"""Validate vox2ai release versions across Python, Node, Tauri, and Cargo metadata."""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _toml(path: Path) -> dict[str, object]:
    return tomllib.loads(path.read_text())


def read_versions() -> dict[str, str]:
    pyproject = _toml(ROOT / "pyproject.toml")
    tauri_conf = json.loads((ROOT / "desktop" / "src-tauri" / "tauri.conf.json").read_text())
    package_json = json.loads((ROOT / "desktop" / "package.json").read_text())
    cargo = _toml(ROOT / "desktop" / "src-tauri" / "Cargo.toml")

    project = pyproject["project"]
    cargo_package = cargo["package"]
    return {
        "pyproject.toml": str(project["version"]),
        "desktop/package.json": str(package_json["version"]),
        "desktop/src-tauri/tauri.conf.json": str(tauri_conf["version"]),
        "desktop/src-tauri/Cargo.toml": str(cargo_package["version"]),
    }


def main() -> None:
    versions = read_versions()
    unique = set(versions.values())
    if len(unique) == 1:
        version = next(iter(unique))
        print(f"[vox2ai] version check passed: {version}")
        return

    print("[vox2ai] version mismatch:", file=sys.stderr)
    for source, version in versions.items():
        print(f"  {source}: {version}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
