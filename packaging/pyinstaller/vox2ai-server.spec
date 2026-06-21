# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for vox2ai-server sidecar.

Requires environment variable VOX2AI_PROJECT_ROOT set to the project root
directory.  ``build_sidecar.py`` sets this before invoking PyInstaller.
"""

import os
import sys

PROJECT_ROOT = os.environ.get("VOX2AI_PROJECT_ROOT")
if not PROJECT_ROOT:
    raise SystemExit("VOX2AI_PROJECT_ROOT environment variable must be set")
SRC_DIR = os.path.join(PROJECT_ROOT, "src")

# Ensure src/ is on sys.path so vox2ai and its dependencies can be found.
sys.path.insert(0, SRC_DIR)

block_cipher = None

a = Analysis(
    [os.path.join(PROJECT_ROOT, "src", "vox2ai", "sidecar_main.py")],
    pathex=[SRC_DIR],
    binaries=[],
    datas=[],
    hiddenimports=[
        "vox2ai",
        "vox2ai.cli",
        "vox2ai.config",
        "vox2ai.desktop_server",
        "vox2ai.desktop_protocol",
        "vox2ai.doctor",
        "vox2ai.errors",
        "vox2ai.llm",
        "vox2ai.prompts",
        "vox2ai.recorder",
        "vox2ai.runner",
        "vox2ai.sidecar_main",
        "vox2ai.stt",
        "vox2ai.timing",
        "vox2ai.transcript",
        "vox2ai.vocabulary",
        "vox2ai.partial_transcriber",
        "vox2ai.agent",
        "vox2ai.commands",
        "vox2ai.audio",
        "vox2ai.tui",
        # faster-whisper and its dependencies
        "faster_whisper",
        "ctranslate2",
        "tokenizers",
        "huggingface_hub",
        # audio
        "sounddevice",
        "soundfile",
        "numpy",
        # networking
        "websockets",
        "openai",
        # config
        "tomli_w",
        "platformdirs",
        "pydantic",
        # CLI
        "click",
        "rich",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "test",
        "distutils",
        "setuptools",
        "pip",
        "PySide6",
        "PyQt5",
        "PyQt6",
        "notebook",
        "jupyter",
        "ipython",
        "matplotlib",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="vox2ai-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
