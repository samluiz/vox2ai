import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from vox2ai.config import CommandsConfig
from vox2ai.errors import CommandExecutionError

CommandRisk = Literal["low", "medium", "high"]


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


def classify_command_risk(command: str) -> CommandRisk:
    """Classify shell command risk for approval UI."""
    cmd = command.strip().lower()
    high_markers = [
        "rm -rf",
        "rm -r",
        "mkfs",
        "dd ",
        "shutdown",
        "reboot",
        "docker compose down -v",
        "docker system prune",
        "chmod -r",
        "chown -r",
        "drop database",
        "truncate table",
    ]
    if any(marker in cmd for marker in high_markers):
        return "high"

    medium_markers = [
        "sudo ",
        "dnf install",
        "dnf upgrade",
        "apt install",
        "apt upgrade",
        "pacman -s",
        "npm install",
        "pip install",
        "git ",
        "mv ",
        "cp ",
        "chmod ",
        "chown ",
        "sed -i",
        ">",
    ]
    if any(marker in cmd for marker in medium_markers):
        return "medium"

    return "low"


def is_safe_command(command: str) -> bool:
    cmd_lower = command.lower()
    safe_patterns = [
        "ls ",
        "cat ",
        "find ",
        "grep ",
        "journalctl",
        "systemctl status",
        "uname ",
        "uname",
        "free ",
        "free",
        "lspci",
        "lsusb",
        "gsettings get",
        "which ",
        "whereis ",
        "stat ",
        "file ",
        "df ",
        "df",
        "du ",
        "echo ",
        "date",
        "whoami",
        "id ",
        "id",
        "hostname",
        "printenv",
        "pwd",
        "pwd",
        "groups",
        "nproc",
        "uptime",
        "ps ",
        "pgrep ",
        "pidof ",
        "head ",
        "tail ",
        "wc ",
        "sort ",
        "uniq ",
        "cut ",
        "tr ",
        "diff ",
        "comm ",
        "sed -n",
        "sed ",
        "awk ",
        "xargs ",
        "tee ",
        "basename",
        "dirname",
        "realpath",
        "type ",
        "command -v",
        "dmesg",
        "ip ",
    ]
    return any(cmd_lower.startswith(pattern) for pattern in safe_patterns)


def describe_command_effect(command: str) -> str:
    """Return a concise expected-effect description for command approval."""
    cmd = command.strip()
    lower = cmd.lower()
    if lower.startswith("ls"):
        return "Lists files or directories."
    if lower == "pwd" or lower.startswith("pwd "):
        return "Prints the current working directory."
    if lower.startswith("cat "):
        return "Prints file contents."
    if "dnf upgrade" in lower or "apt upgrade" in lower:
        return "Updates installed system packages."
    if "dnf install" in lower or "apt install" in lower or "pacman -s" in lower:
        return "Installs packages on the system."
    if lower.startswith("git "):
        return "Runs a Git operation in the working directory."
    if lower.startswith("docker compose down -v"):
        return "Stops containers and deletes associated volumes."
    if "rm " in lower:
        return "Deletes files or directories."
    return "Runs the proposed shell command in the configured working directory."


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
