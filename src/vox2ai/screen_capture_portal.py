"""XDG Desktop Portal screenshot capture.

ponytail: no portal introspection — dbus-next fails on
power-saver-enabled property name in portal introspection XML.
Uses low-level dbus_next.Message for the method call.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse

from vox2ai.errors import Vox2AIError

try:
    from dbus_next import BusType, Message, Variant  # type: ignore[attr-defined]
    from dbus_next import introspection as intr
    from dbus_next.aio import MessageBus  # type: ignore[attr-defined]
    from dbus_next.errors import DBusError

    HAS_DBUS_NEXT = True
except Exception:  # pragma: no cover — optional runtime dependency
    HAS_DBUS_NEXT = False


DESTINATION = "org.freedesktop.portal.Desktop"
OBJECT_PATH = "/org/freedesktop/portal/desktop"
INTERFACE = "org.freedesktop.portal.Screenshot"
REQUEST_INTERFACE = "org.freedesktop.portal.Request"


@dataclass(frozen=True)
class PortalScreenshotResult:
    ok: bool
    path: str | None = None
    uri: str | None = None
    error: str | None = None


def _runtime_temp_dir() -> Path:
    base = Path(os.environ.get("XDG_RUNTIME_DIR") or "/tmp")
    return base / "vox2ai-screen"


def _ensure_temp_dir() -> Path | None:
    try:
        path = _runtime_temp_dir()
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        return path
    except Exception:
        return None


def _uri_to_path(uri: str) -> Path | Vox2AIError:
    if not uri.startswith("file://"):
        return Vox2AIError(f"Portal returned non-file URI: {uri}")
    parsed = urlparse(uri)
    try:
        return Path(unquote(parsed.path)).resolve()
    except Exception as exc:
        return Vox2AIError(f"Invalid portal URI path: {exc}")


def _copy_portal_file(source: Path) -> Path | Vox2AIError:
    temp_dir = _ensure_temp_dir()
    if temp_dir is None:
        return Vox2AIError("Could not create temp directory for screenshot.")

    dest = temp_dir / f"portal-{uuid.uuid4().hex}.png"
    try:
        shutil.copy2(str(source), str(dest))
    except Exception as exc:
        return Vox2AIError(f"Could not copy portal screenshot: {exc}")

    if not dest.exists() or dest.stat().st_size == 0:
        return Vox2AIError("Portal screenshot copy is empty or missing.")
    return dest


def _request_introspection() -> intr.Node:
    # ponytail: static Node for the Request interface only — no remote introspect.
    return intr.Node(
        "",
        [
            intr.Interface(
                REQUEST_INTERFACE,
                methods=[],
                signals=[
                    intr.Signal(
                        "Response",
                        [
                            intr.Arg(signature="u", name="response"),
                            intr.Arg(signature="a{sv}", name="results"),
                        ],
                    )
                ],
                properties=[],
            )
        ],
    )


async def capture_screenshot_via_portal(
    timeout_seconds: float = 30.0,
) -> PortalScreenshotResult:
    """Capture screenshot through XDG Desktop Portal.

    ponytail: uses raw dbus_next.Message + bus.call() to avoid
    introspection. Only the Request interface is introspected statically.
    """
    if not HAS_DBUS_NEXT:
        return PortalScreenshotResult(
            ok=False, error="dbus-next is required for portal screenshots."
        )

    bus = await MessageBus(bus_type=BusType.SESSION).connect()
    try:
        handle_token = f"v2a{uuid.uuid4().hex}"
        options = {
            "interactive": Variant("b", True),
            "modal": Variant("b", True),
            "handle_token": Variant("s", handle_token),
        }

        msg = Message(
            destination=DESTINATION,
            path=OBJECT_PATH,
            interface=INTERFACE,
            member="Screenshot",
            signature="sa{sv}",
            body=["", options],
        )

        try:
            reply = await bus.call(msg)
        except DBusError as e:
            return PortalScreenshotResult(
                ok=False,
                error=f"XDG Desktop Portal Screenshot call failed: {e}",
            )

        assert reply is not None, "bus.call returned None"
        raw_body = reply.body if isinstance(reply.body, list) else [reply.body]
        request_path = str(raw_body[0]) if raw_body else ""
        if not request_path:
            return PortalScreenshotResult(ok=False, error="Portal did not return a request handle.")

        request_node = _request_introspection()
        request_proxy = bus.get_proxy_object(DESTINATION, request_path, request_node)
        request_iface = request_proxy.get_interface(REQUEST_INTERFACE)

        loop = asyncio.get_running_loop()
        future: asyncio.Future[tuple[int, dict[str, Variant]]] = loop.create_future()

        def on_response(response_code: int, results: dict[str, Variant]) -> None:
            if not future.done():
                future.set_result((response_code, results))

        request_iface.on_response(on_response)  # type: ignore[attr-defined]

        try:
            response_code, results = await asyncio.wait_for(future, timeout=timeout_seconds)
        except TimeoutError:
            return PortalScreenshotResult(
                ok=False,
                error=f"XDG Desktop Portal screenshot timed out after {timeout_seconds}s.",
            )

        if response_code == 1:
            return PortalScreenshotResult(ok=False, error="Screen capture was cancelled.")
        if response_code != 0:
            return PortalScreenshotResult(
                ok=False,
                error=f"Portal screenshot request failed with response code {response_code}.",
            )

        uri_variant = results.get("uri")
        if uri_variant is None or not isinstance(uri_variant.value, str):
            return PortalScreenshotResult(
                ok=False, error="Portal response did not contain a file URI."
            )

        uri = uri_variant.value
        source = _uri_to_path(uri)
        if isinstance(source, Vox2AIError):
            return PortalScreenshotResult(ok=False, error=str(source))

        if not source.exists() or source.stat().st_size == 0:
            return PortalScreenshotResult(
                ok=False, error="Portal screenshot file is empty or missing."
            )

        dest = _copy_portal_file(source)
        if isinstance(dest, Vox2AIError):
            return PortalScreenshotResult(ok=False, error=str(dest))

        return PortalScreenshotResult(ok=True, path=str(dest), uri=uri)
    finally:
        bus.disconnect()  # type: ignore[no-untyped-call]
