"""Screen capture and OCR helpers for explicit Ask about screen requests."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path

from vox2ai.config import AppConfig
from vox2ai.errors import Vox2AIError
from vox2ai.screen_capture_portal import (
    HAS_DBUS_NEXT,
    capture_screenshot_via_portal,
)


@dataclass(frozen=True)
class CapturedScreen:
    image_path: Path
    mime_type: str
    width: int
    height: int
    method: str


@dataclass(frozen=True)
class OcrResult:
    text: str
    confidence: float
    engine: str
    language: str


def screen_capture_status(config: AppConfig) -> dict[str, object]:
    if not config.context.screen_context_enabled:
        return {
            "available": False,
            "method": "disabled",
            "portal_available": False,
            "gnome_shell_dbus_available": False,
            "gnome_screenshot_available": False,
            "reason": "Ask about screen is disabled in config.",
        }

    # ponytail: only the XDG Desktop Portal is the normal capture path.
    method = config.context.screen_capture_method
    if method == "auto" or method == "portal":
        portal = HAS_DBUS_NEXT
        return {
            "available": portal,
            "method": "xdg-desktop-portal" if portal else "none",
            "portal_available": portal,
            "gnome_shell_dbus_available": False,
            "gnome_screenshot_available": _which("gnome-screenshot"),
            "reason": None if portal else "XDG Desktop Portal screenshot interface is unavailable",
        }

    if method == "gnome-screenshot":
        available = _which("gnome-screenshot")
        return {
            "available": available,
            "method": "gnome-screenshot",
            "portal_available": HAS_DBUS_NEXT,
            "gnome_shell_dbus_available": False,
            "gnome_screenshot_available": available,
            "reason": None if available else "gnome-screenshot is not installed.",
        }

    return {
        "available": False,
        "method": method,
        "portal_available": HAS_DBUS_NEXT,
        "gnome_shell_dbus_available": False,
        "gnome_screenshot_available": _which("gnome-screenshot"),
        "reason": "Unsupported screen capture method.",
    }


def ocr_status() -> dict[str, object]:
    if _which("tesseract"):
        return {"available": True, "engine": "tesseract", "reason": None}
    return {
        "available": False,
        "engine": None,
        "reason": "Install tesseract for OCR fallback.",
    }


async def capture_screen(config: AppConfig) -> CapturedScreen | Vox2AIError:
    """Capture the screen using the configured method.

    ponytail: portal is the normal path; everything else is opt-in/debug.
    """
    status = screen_capture_status(config)
    if not status["available"]:
        return Vox2AIError(str(status["reason"] or "Screen capture is unavailable."))

    method = status["method"]
    if method == "xdg-desktop-portal":
        result = await capture_screenshot_via_portal(timeout_seconds=30.0)
        if not result.ok or result.path is None:
            return Vox2AIError(result.error or "Portal screenshot failed.")
        image_path = Path(result.path)
        width, height = png_dimensions(image_path)
        return CapturedScreen(
            image_path=image_path,
            mime_type="image/png",
            width=width,
            height=height,
            method="xdg-desktop-portal",
        )

    if method == "gnome-screenshot":
        return _capture_with_gnome_screenshot(config)

    return Vox2AIError("Screen capture method is not available.")


def _capture_with_gnome_screenshot(_config: AppConfig) -> CapturedScreen | Vox2AIError:
    cache_dir = Path(tempfile.gettempdir()) / "vox2ai-screen"
    cache_dir.mkdir(parents=True, exist_ok=True)
    image_path = cache_dir / f"screen-{uuid.uuid4().hex}.png"

    try:
        subprocess.run(
            ["gnome-screenshot", "-f", str(image_path)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15,
        )
    except subprocess.CalledProcessError as exc:
        return Vox2AIError((exc.stderr or "Screen capture failed.").strip())
    except subprocess.TimeoutExpired:
        return Vox2AIError("Screen capture timed out.")
    except OSError as exc:
        return Vox2AIError(f"Screen capture failed: {exc}")

    width, height = png_dimensions(image_path)
    return CapturedScreen(
        image_path=image_path,
        mime_type="image/png",
        width=width,
        height=height,
        method="gnome-screenshot",
    )


def ocr_screen(image_path: Path, config: AppConfig) -> OcrResult | Vox2AIError:
    status = ocr_status()
    if not status["available"]:
        return Vox2AIError(str(status["reason"] or "OCR is unavailable."))

    lang = ocr_language(config.voice.primary_language)
    try:
        proc = subprocess.run(
            ["tesseract", str(image_path), "stdout", "-l", lang],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return Vox2AIError("OCR timed out.")
    except OSError as exc:
        return Vox2AIError(f"OCR failed: {exc}")

    if proc.returncode != 0:
        detail = (proc.stderr or "OCR failed.").strip()
        return Vox2AIError(detail)

    return OcrResult(
        text=proc.stdout.strip(),
        confidence=0.0,
        engine="tesseract",
        language=lang,
    )


def ocr_language(primary_language: str) -> str:
    lang = primary_language.lower().strip()
    if lang.startswith("pt"):
        return "por"
    if lang.startswith("es"):
        return "spa"
    return "eng"


def png_dimensions(path: Path) -> tuple[int, int]:
    try:
        data = path.read_bytes()[:24]
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            return 0, 0
        width = int.from_bytes(data[16:20], "big")
        height = int.from_bytes(data[20:24], "big")
        return width, height
    except Exception:
        return 0, 0


def _which(name: str) -> bool:
    return shutil.which(name) is not None
