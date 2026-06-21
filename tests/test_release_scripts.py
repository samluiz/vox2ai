from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_script(name: str):
    path = ROOT / "scripts" / name
    spec = importlib.util.spec_from_file_location(name.removesuffix(".py"), path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_version_metadata_is_consistent() -> None:
    check_versions = _load_script("check_versions.py")
    versions = check_versions.read_versions()
    assert len(set(versions.values())) == 1
    assert versions["pyproject.toml"] == "0.1.0"


def test_sidecar_destination_name_linux() -> None:
    copy_sidecar = _load_script("copy_sidecar.py")
    assert (
        copy_sidecar.sidecar_destination_name(system="Linux", machine="x86_64")
        == "vox2ai-server-x86_64-unknown-linux-gnu"
    )


def test_sidecar_destination_name_windows() -> None:
    copy_sidecar = _load_script("copy_sidecar.py")
    assert (
        copy_sidecar.sidecar_destination_name(system="Windows", machine="AMD64", windows=True)
        == "vox2ai-server-x86_64-pc-windows-msvc.exe"
    )
