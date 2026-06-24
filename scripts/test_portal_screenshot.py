#!/usr/bin/env python3
"""Test XDG Desktop Portal screenshot capture outside the app."""

from __future__ import annotations

import asyncio
import sys

sys.path.insert(0, "src")

from vox2ai.screen_capture_portal import capture_screenshot_via_portal


async def main() -> int:
    print("Calling XDG Desktop Portal Screenshot...")
    result = await capture_screenshot_via_portal(timeout_seconds=30.0)
    if result.ok:
        print(f"Success: {result.path}")
        print(f"URI: {result.uri}")
        return 0
    print(f"Failed: {result.error}")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
