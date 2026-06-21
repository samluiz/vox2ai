#!/usr/bin/env python3
"""Build the complete standalone vox2ai desktop app.

Runs:
  1. PyInstaller to package the Python backend as a sidecar binary
  2. Copy the sidecar into the Tauri binaries directory
  3. Run `npm run tauri build` to produce the final app

Usage:
  python scripts/build_desktop.py
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Additional paths to search for cargo when it's not in the current PATH.
_CARGO_HINTS = [
    Path.home() / ".cargo" / "bin",
    Path("/usr/local/bin"),
    Path("/usr/bin"),
]


def _build_env() -> dict[str, str]:
    """Return an environment with toolchain paths included."""
    env = {**os.environ}
    cargo_dir = None

    if shutil.which("cargo") is None:
        for hint in _CARGO_HINTS:
            candidate = hint / "cargo"
            if candidate.is_file():
                cargo_dir = hint
                break

    if cargo_dir is not None:
        path = env.get("PATH", "")
        env["PATH"] = f"{cargo_dir}:{path}" if path else str(cargo_dir)
        print(f"[vox2ai] cargo found at {cargo_dir / 'cargo'}")

    return env


def step(
    label: str,
    cmd: list[str],
    cwd: str | Path | None = None,
    env: dict[str, str] | None = None,
) -> None:
    print(f"\n==> {label}")
    sys.stdout.flush()
    result = subprocess.run(cmd, cwd=cwd or str(ROOT), env=env)
    if result.returncode != 0:
        print(f"[vox2ai] FAILED: {label} (exit code {result.returncode})", file=sys.stderr)
        sys.exit(result.returncode)


def main() -> None:
    print("=== vox2ai desktop build ===")

    step("1. Build Python sidecar (PyInstaller)", [sys.executable, "scripts/build_sidecar.py"])

    step(
        "2. Copy sidecar into Tauri binaries directory", [sys.executable, "scripts/copy_sidecar.py"]
    )

    # Ensure node_modules are installed.
    desktop_dir = ROOT / "desktop"
    if not (desktop_dir / "node_modules").is_dir():
        step("  (installing npm dependencies)", ["npm", "install"], cwd=desktop_dir)

    env = _build_env()
    step(
        "3. Build Tauri desktop app",
        ["npm", "run", "tauri", "build"],
        cwd=desktop_dir,
        env=env,
    )

    bundle_dir = desktop_dir / "src-tauri" / "target" / "release" / "bundle"
    print("\n=== Build complete ===")
    if bundle_dir.is_dir():
        print(f"App bundle: {bundle_dir}")
    print("Done.")


if __name__ == "__main__":
    main()
