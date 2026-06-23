"""Audio input stream selection helpers."""

from __future__ import annotations

import contextlib
from collections.abc import Callable
from typing import Any

import numpy as np
import sounddevice as sd

from vox2ai.errors import AudioError

InputCallback = Callable[[np.ndarray, int, object, sd.CallbackFlags], None]


def start_input_stream(
    *,
    sample_rate: int,
    channels: int,
    dtype: str,
    callback: InputCallback,
    device: str | None = None,
) -> sd.InputStream:
    """Open and start a microphone stream, falling back from broken defaults."""
    errors: list[str] = []

    for candidate in _input_device_candidates(device):
        stream: sd.InputStream | None = None
        try:
            kwargs: dict[str, Any] = {
                "samplerate": sample_rate,
                "channels": channels,
                "dtype": dtype,
                "callback": callback,
            }
            if candidate is not None:
                kwargs["device"] = candidate
            stream = sd.InputStream(**kwargs)
            stream.start()
            return stream
        except Exception as exc:
            if stream is not None:
                with contextlib.suppress(Exception):
                    stream.close()
            errors.append(f"{_candidate_label(candidate)}: {exc}")

    detail = "; ".join(errors[:4])
    if len(errors) > 4:
        detail += f"; {len(errors) - 4} more device(s) failed"
    if device and str(device).strip():
        raise AudioError(
            f"Could not open selected microphone '{device}'. "
            "Choose another input device in vox2ai Preferences."
            + (f" Details: {detail}" if detail else "")
        )
    raise AudioError(
        "Could not open a microphone input stream. "
        "Check GNOME Settings > Sound > Input and select a microphone, then try again."
        + (f" Details: {detail}" if detail else "")
    )


def list_input_devices() -> list[dict[str, object]]:
    """Return available PortAudio input devices for UI selection."""
    try:
        devices = list(sd.query_devices())
        hostapis = list(sd.query_hostapis())
    except Exception as exc:
        raise AudioError(f"Could not list audio input devices: {exc}") from exc

    default_input = _default_input_index()
    result: list[dict[str, object]] = []
    for idx, device in enumerate(devices):
        try:
            channels = int(device.get("max_input_channels", 0))
        except (AttributeError, TypeError, ValueError):
            continue
        if channels <= 0:
            continue
        hostapi_idx = int(device.get("hostapi", -1))
        hostapi = ""
        if 0 <= hostapi_idx < len(hostapis):
            hostapi = str(hostapis[hostapi_idx].get("name", ""))
        name = str(device.get("name", f"Device {idx}"))
        result.append(
            {
                "id": str(idx),
                "name": name,
                "label": f"{name} ({hostapi})" if hostapi else name,
                "hostapi": hostapi,
                "max_input_channels": channels,
                "default": idx == default_input,
            }
        )
    return sorted(result, key=lambda item: _device_priority(item))


def test_input_device(device: str | None, sample_rate: int, min_rms: float) -> str:
    """Open the requested input briefly and verify it is usable for recording."""
    frames: list[np.ndarray] = []

    def callback(
        indata: np.ndarray,
        _frames_count: int,
        _time_info: object,
        _status: sd.CallbackFlags,
    ) -> None:
        frames.append(indata.copy())

    stream = start_input_stream(
        sample_rate=sample_rate,
        channels=1,
        dtype="float32",
        callback=callback,
        device=device,
    )
    try:
        sd.sleep(1200)
    finally:
        with contextlib.suppress(Exception):
            stream.stop()
        with contextlib.suppress(Exception):
            stream.close()

    if not frames:
        raise AudioError("Microphone opened, but no audio frames were captured.")
    audio = np.concatenate(frames, axis=0)
    rms = float(np.sqrt(np.mean(audio**2)))
    if rms < min_rms:
        raise AudioError(
            f"Microphone input is too quiet (RMS {rms:.5f} < {min_rms}). "
            "Speak during the test, choose another input device, or lower voice.min_rms."
        )
    return f"Microphone test succeeded (RMS {rms:.5f})."


def _input_device_candidates(selected: str | None = None) -> list[int | None]:
    selected_idx = _resolve_selected_device(selected)
    if selected_idx is not None:
        return [selected_idx]

    candidates: list[int | None] = [None]
    seen: set[int] = set()
    default_input = _default_input_index()
    if default_input is not None:
        seen.add(default_input)

    try:
        devices = list(sd.query_devices())
    except Exception:
        return candidates

    input_devices: list[tuple[int, Any]] = []
    for idx, device in enumerate(devices):
        try:
            max_inputs = int(device.get("max_input_channels", 0))
        except (AttributeError, TypeError, ValueError):
            continue
        if max_inputs > 0:
            input_devices.append((idx, device))

    for idx, _device in sorted(input_devices, key=lambda item: _device_priority(item[1])):
        if idx in seen:
            continue
        seen.add(idx)
        candidates.append(idx)
    return candidates


def _resolve_selected_device(selected: str | None) -> int | None:
    raw = (selected or "").strip()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)

    try:
        devices = list(sd.query_devices())
    except Exception:
        return None
    lowered = raw.lower()
    for idx, device in enumerate(devices):
        name = str(device.get("name", "")).strip().lower() if hasattr(device, "get") else ""
        if name == lowered:
            return idx
    return None


def _default_input_index() -> int | None:
    default = getattr(sd.default, "device", None)
    if default is None:
        return None
    try:
        idx = int(default[0]) if isinstance(default, (list, tuple)) else int(default)
    except (TypeError, ValueError, IndexError):
        return None
    return idx if idx >= 0 else None


def _device_priority(device: Any) -> tuple[int, str]:
    name = str(device.get("name", "")).lower() if hasattr(device, "get") else ""
    if "sysdefault" in name:
        return (0, name)
    if "pulse" in name:
        return (1, name)
    if "pipewire" in name:
        return (2, name)
    if "default" in name:
        return (3, name)
    return (4, name)


def _candidate_label(device: int | None) -> str:
    if device is None:
        return "default"
    try:
        info = sd.query_devices(device)
        if isinstance(info, dict):
            name = str(info.get("name", "")).strip()
            if name:
                return f"{device} ({name})"
    except Exception:
        pass
    return str(device)
