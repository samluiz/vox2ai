from pathlib import Path

import pytest
from click.testing import CliRunner

from vox2ai.cli import cli


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


def _set_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))


def test_cli_init_creates_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    _set_xdg(tmp_path, monkeypatch)
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0
    assert (tmp_path / "vox2ai" / "config.toml").exists()


def test_cli_init_force(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner) -> None:
    _set_xdg(tmp_path, monkeypatch)
    runner.invoke(cli, ["init"])
    cfg = tmp_path / "vox2ai" / "config.toml"
    cfg.write_text("# modified")
    result = runner.invoke(cli, ["init", "--force"])
    assert result.exit_code == 0
    content = cfg.read_text()
    assert "openai-compatible" in content


def test_cli_config_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    _set_xdg(tmp_path, monkeypatch)
    result = runner.invoke(cli, ["config-path"])
    assert result.exit_code == 0
    expected = str(tmp_path / "vox2ai" / "config.toml")
    assert expected in result.output


def test_cli_doctor_without_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    _set_xdg(tmp_path, monkeypatch)
    result = runner.invoke(cli, ["doctor"])
    assert result.exit_code == 0
    assert "Not found" in result.output


def test_cli_doctor_with_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    _set_xdg(tmp_path, monkeypatch)
    from vox2ai.config import ensure_config

    ensure_config()
    result = runner.invoke(cli, ["doctor"])
    assert result.exit_code == 0
    assert "parsed successfully" in result.output or "Valid TOML" in result.output


def test_cli_ask_fails_without_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    _set_xdg(tmp_path, monkeypatch)
    result = runner.invoke(cli, ["ask"])
    assert result.exit_code == 1


def test_cli_dict_fails_without_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    _set_xdg(tmp_path, monkeypatch)
    result = runner.invoke(cli, ["dict"])
    assert result.exit_code == 1
