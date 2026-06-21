import subprocess
from dataclasses import dataclass
from pathlib import Path

from vox2ai.config import CommandsConfig
from vox2ai.errors import CommandExecutionError


@dataclass(frozen=True)
class ProposedCommand:
    command: str
    reason: str | None = None


@dataclass(frozen=True)
class CommandResult:
    command: str
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool


def is_blocked(command: str, config: CommandsConfig) -> bool:
    """Check if a command matches any blocked pattern."""
    cmd_lower = command.lower()
    return any(pattern.lower() in cmd_lower for pattern in config.blocked_patterns)


def requires_approval(_command: str, config: CommandsConfig) -> bool:
    """Check if a command requires user approval before running."""
    if config.mode == "disabled":
        return False
    return config.mode != "allow-all"


def run_command(
    command: str,
    working_directory: Path,
    timeout_seconds: int,
    max_output_chars: int,
) -> CommandResult:
    """Execute a shell command and return the result.

    ``shell=True`` is acceptable for MVP because the exact command
    string is user-approved (or user-configured as allow-all).
    """
    try:
        proc = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            cwd=working_directory,
        )
        timed_out = False
        exit_code = proc.returncode
        stdout = str(proc.stdout or "")
        stderr = str(proc.stderr or "")
    except subprocess.TimeoutExpired as e:
        timed_out = True
        exit_code = -1
        stdout = str(e.stdout or "")
        stderr = str(e.stderr or "")
    except FileNotFoundError as e:
        raise CommandExecutionError(f"Working directory not found: {working_directory}") from e
    except OSError as e:
        raise CommandExecutionError(f"Failed to execute command: {e}") from e

    if len(stdout) > max_output_chars:
        stdout = stdout[:max_output_chars] + "\n... [truncated]"
    if len(stderr) > max_output_chars:
        stderr = stderr[:max_output_chars] + "\n... [truncated]"

    return CommandResult(
        command=command,
        exit_code=exit_code,
        stdout=stdout,
        stderr=stderr,
        timed_out=timed_out,
    )
