from pathlib import Path

import pytest
from click.testing import CliRunner

from vox2ai.agent import parse_agent_decision
from vox2ai.commands import CommandsConfig, is_blocked, requires_approval, run_command
from vox2ai.timing import Timer
from vox2ai.transcript import (
    TranscriptCandidate,
    build_initial_prompt,
    normalize_transcript,
)
from vox2ai.vocabulary import VocabularyContext, _filter_terms, build_vocabulary_context


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


def _set_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))


def test_cli_init_creates_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    from vox2ai.cli import cli

    _set_xdg(tmp_path, monkeypatch)
    result = runner.invoke(cli, ["init"])
    assert result.exit_code == 0
    assert (tmp_path / "vox2ai" / "config.toml").exists()


def test_cli_config_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    from vox2ai.cli import cli

    _set_xdg(tmp_path, monkeypatch)
    result = runner.invoke(cli, ["config-path"])
    assert result.exit_code == 0
    expected = str(tmp_path / "vox2ai" / "config.toml")
    assert expected in result.output


def test_cli_ask_fails_without_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    from vox2ai.cli import cli

    _set_xdg(tmp_path, monkeypatch)
    result = runner.invoke(cli, ["ask"])
    assert result.exit_code == 1


def test_cli_dict_fails_without_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runner: CliRunner
) -> None:
    from vox2ai.cli import cli

    _set_xdg(tmp_path, monkeypatch)
    result = runner.invoke(cli, ["dict"])
    assert result.exit_code == 1


# -- Agent decision parsing tests --


def test_parse_answer() -> None:
    raw = '{"type": "answer", "message": "Hello", "command": null, "reason": null}'
    d = parse_agent_decision(raw)
    assert d.type == "answer"
    assert d.message == "Hello"


def test_parse_clarification() -> None:
    raw = '{"type": "clarification", "message": "Please specify", "command": null, "reason": null}'
    d = parse_agent_decision(raw)
    assert d.type == "clarification"


def test_parse_command() -> None:
    raw = (
        '{"type": "command", "message": "Running", "command": "git status", "reason": "Check repo"}'  # noqa: E501
    )
    d = parse_agent_decision(raw)
    assert d.type == "command"
    assert d.command == "git status"


def test_parse_non_json_fallback_to_answer() -> None:
    raw = "plain text"
    d = parse_agent_decision(raw)
    assert d.type == "answer"
    assert d.message == raw


def test_parse_strips_markdown_fence() -> None:
    raw = '```json\n{"type": "answer", "message": "ok", "command": null, "reason": null}\n```'
    d = parse_agent_decision(raw)
    assert d.type == "answer"
    assert d.message == "ok"


# -- Command permission tests --


def test_is_blocked_detects_pattern() -> None:
    cfg = CommandsConfig(blocked_patterns=["rm ", "sudo "])
    assert is_blocked("rm -rf /tmp", cfg) is True
    assert is_blocked("sudo apt update", cfg) is True
    assert is_blocked("git status", cfg) is False


def test_blocked_still_blocked_in_allow_all() -> None:
    cfg = CommandsConfig(mode="allow-all", blocked_patterns=["rm "])
    assert is_blocked("rm file.txt", cfg) is True


def test_requires_approval_ask_before_run() -> None:
    cfg = CommandsConfig(mode="ask-before-run")
    assert requires_approval("git status", cfg) is True


def test_requires_approval_allow_all() -> None:
    cfg = CommandsConfig(mode="allow-all")
    assert requires_approval("git status", cfg) is False


# -- Command execution tests --


def test_run_command_success() -> None:
    result = run_command("echo hello", Path("."), 10, 1000)
    assert result.exit_code == 0
    assert "hello" in result.stdout


def test_run_command_failure() -> None:
    result = run_command("false", Path("."), 10, 1000)
    assert result.exit_code != 0


def test_run_command_truncates_output() -> None:
    result = run_command("echo 'hello world'", Path("."), 10, 5)
    assert len(result.stdout) <= 5 + len("\n... [truncated]")


def test_run_command_timeout() -> None:
    result = run_command("sleep 10", Path("."), 1, 1000)
    assert result.timed_out


def test_run_command_bad_working_directory() -> None:
    from vox2ai.errors import CommandExecutionError

    with pytest.raises(CommandExecutionError, match="Working directory not found"):
        run_command("echo hi", Path("/nonexistent/path"), 10, 1000)


# -- Vocabulary tests --


def test_filter_terms_deduplicates() -> None:
    result = _filter_terms(["Foo", "foo", "Bar", "bar"], 10)
    assert result == ["Foo", "Bar"]


def test_filter_terms_removes_short() -> None:
    result = _filter_terms(["a", "ab", "c", "xyz"], 10)
    assert result == ["ab", "xyz"]


def test_filter_terms_caps_at_max() -> None:
    result = _filter_terms(["ab", "cd", "ef", "gh", "ij"], 3)
    assert len(result) == 3


def test_vocabulary_from_custom_config() -> None:
    from vox2ai.config import AppConfig

    cfg = AppConfig()
    cfg.transcription.custom_vocabulary = ["Neovim", "Tree-sitter", "tmux"]
    ctx = build_vocabulary_context(cfg, Path("."))
    assert "Neovim" in ctx.terms
    assert "Tree-sitter" in ctx.terms


def test_vocabulary_preserves_symbols() -> None:
    from vox2ai.config import AppConfig

    cfg = AppConfig()
    cfg.transcription.custom_vocabulary = ["Tree-sitter", "Node.js", "C++", "fzf-lua"]
    ctx = build_vocabulary_context(cfg, Path("."))
    assert "Tree-sitter" in ctx.terms
    assert "Node.js" in ctx.terms
    assert "C++" in ctx.terms


# -- Transcript normalization tests --


def test_normalize_replaces_configurable_terms() -> None:
    result = normalize_transcript(
        "in neo vim use t-sitter", {"neo vim": "Neovim", "t-sitter": "Tree-sitter"}
    )  # noqa: E501
    assert "Neovim" in result
    assert "Tree-sitter" in result


def test_normalize_no_replacements() -> None:
    result = normalize_transcript("hello world", {})
    assert result == "hello world"


def test_normalize_does_not_corrupt_normal_text() -> None:
    result = normalize_transcript("I live in a nice village", {"village": "town"})
    assert "town" in result
    assert "village" not in result


def test_replacements_not_hardcoded() -> None:
    """Replacements must come from user config, not app logic."""
    from vox2ai.config import AppConfig

    cfg = AppConfig()
    assert len(cfg.transcription.custom_replacements) == 0


# -- Initial prompt tests --


def test_initial_prompt_includes_vocabulary() -> None:
    from vox2ai.config import AppConfig

    cfg = AppConfig()
    vocab = VocabularyContext(terms=("Neovim", "Tree-sitter"), sources={})
    prompt = build_initial_prompt(vocab, cfg)
    assert prompt is not None
    assert "Neovim" in prompt
    assert "Tree-sitter" in prompt


def test_initial_prompt_does_not_assume_language() -> None:
    from vox2ai.config import AppConfig

    cfg = AppConfig()
    vocab = VocabularyContext(terms=(), sources={})
    prompt = build_initial_prompt(vocab, cfg)
    assert prompt is None or "any natural language" in prompt


def test_initial_prompt_disabled() -> None:
    from vox2ai.config import AppConfig

    cfg = AppConfig()
    cfg.voice.initial_prompt_enabled = False
    vocab = VocabularyContext(terms=("test",), sources={})
    prompt = build_initial_prompt(vocab, cfg)
    assert prompt is None


# -- Transcript refiner fallback tests --


def test_refiner_fallback_returns_normalized_on_invalid_json() -> None:
    """If the refiner returns garbage, caller should use normalized text."""
    candidate = TranscriptCandidate(
        raw_text="in neo vim",
        normalized_text="in Neovim",
        refined_text=None,
    )
    assert candidate.final_text == "in Neovim"


def test_refiner_returns_refined_text_when_available() -> None:
    candidate = TranscriptCandidate(
        raw_text="in neo vim",
        normalized_text="in Neovim",
        refined_text="in Neovim",
    )
    assert candidate.final_text == "in Neovim"


# -- Timing helper tests --


def test_timing_records_named_spans() -> None:
    t = Timer()
    t.start("test")
    t.stop("test")
    assert t.get("test") > 0


def test_timing_summary_contains_spans() -> None:
    t = Timer()
    with t.measure("work"):
        pass
    summary = t.summary()
    assert "work" in summary
    assert "total" in summary


def test_timing_hidden_when_disabled() -> None:
    from vox2ai.config import AppConfig

    cfg = AppConfig()
    assert cfg.debug.show_timings is False


def test_timing_reset() -> None:
    t = Timer()
    t.start("a")
    t.stop("a")
    t.reset()
    assert t.get("a") == 0.0


# -- TranscriptCandidate property tests --


def test_transcript_candidate_final_text() -> None:
    c = TranscriptCandidate(raw_text="raw", normalized_text="norm", refined_text="refined")
    assert c.final_text == "refined"
    c2 = TranscriptCandidate(raw_text="raw", normalized_text="norm", refined_text=None)
    assert c2.final_text == "norm"
