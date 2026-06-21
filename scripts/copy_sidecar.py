#!/usr/bin/env python3
"""Copy the built sidecar into the Tauri binaries directory.

Tauri v2 expects sidecar binaries at:

    desktop/src-tauri/binaries/<name>-<target-triple>

where <name> matches the ``externalBin`` entry in tauri.conf.json
(``binaries/vox2ai-server``) and <target-triple> is the current platform.
"""

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "dist"
TAURI_BIN_DIR = ROOT / "desktop" / "src-tauri" / "binaries"

# Map from `uname -m` / platform to Rust target triple.
_TRIPLES: dict[str, dict[str, str]] = {
    "Linux": {
        "x86_64": "x86_64-unknown-linux-gnu",
        "aarch64": "aarch64-unknown-linux-gnu",
    },
    "Darwin": {
        "x86_64": "x86_64-apple-darwin",
        "arm64": "aarch64-apple-darwin",
    },
    "Windows": {
        "AMD64": "x86_64-pc-windows-msvc",
        "ARM64": "aarch64-pc-windows-msvc",
    },
}


def _detect_target_triple() -> str | None:
    import platform

    system = platform.system()
    machine = platform.machine()
    return _TRIPLES.get(system, {}).get(machine)


def sidecar_destination_name(
    *,
    system: str,
    machine: str,
    windows: bool = False,
) -> str:
    triple = _TRIPLES.get(system, {}).get(machine)
    if triple is None:
        raise ValueError(f"unsupported platform: {system} / {machine}")
    suffix = ".exe" if windows else ""
    return f"vox2ai-server-{triple}{suffix}"


def main() -> None:
    triple = _detect_target_triple()
    if triple is None:
        print(
            f"[vox2ai] Unsupported platform: {sys.platform} / {__import__('platform').machine()}",
            file=sys.stderr,
        )
        sys.exit(1)

    # Source binary (with .exe suffix on Windows).
    src_name = "vox2ai-server.exe" if sys.platform == "win32" else "vox2ai-server"
    src = DIST_DIR / src_name

    if not src.is_file():
        print(f"[vox2ai] Sidecar binary not found at {src}", file=sys.stderr)
        print("[vox2ai] Run python scripts/build_sidecar.py first", file=sys.stderr)
        sys.exit(1)

    # Tauri v2 sidecar naming: <name>-<target-triple><.exe>
    import platform

    dest_name = sidecar_destination_name(
        system=platform.system(),
        machine=platform.machine(),
        windows=sys.platform == "win32",
    )
    dest = TAURI_BIN_DIR / dest_name

    TAURI_BIN_DIR.mkdir(parents=True, exist_ok=True)

    shutil.copy2(src, dest)
    dest.chmod(0o755)

    print(f"[vox2ai] Sidecar copied to {dest}")


if __name__ == "__main__":
    main()
