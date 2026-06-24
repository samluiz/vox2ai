#!/usr/bin/env python3
"""Test XDG Desktop Portal screenshot capture outside the app."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, "src")

from vox2ai.screen_capture_portal import capture_screenshot_via_portal


async def main() -> int:
    print("Method: xdg-desktop-portal")
    result = await capture_screenshot_via_portal(timeout_seconds=30.0)
    if result.ok:
        path = Path(result.path)
        print("Response code: 0")
        print(f"URI: {result.uri}")
        print(f"Local path: {result.path}")
        print(f"File size: {path.stat().st_size}")
        return 0
    print(f"Response: {result.error}")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
