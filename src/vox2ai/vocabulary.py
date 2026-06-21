import subprocess
from dataclasses import dataclass
from pathlib import Path

from vox2ai.config import AppConfig


@dataclass(frozen=True)
class VocabularyContext:
    terms: tuple[str, ...]
    sources: dict[str, tuple[str, ...]]


def _filter_terms(
    terms: list[str],
    max_terms: int,
) -> list[str]:
    """Deduplicate, filter short junk, order by insertion, cap at *max_terms*."""
    seen: set[str] = set()
    result: list[str] = []
    for t in terms:
        t = t.strip()
        if not t or len(t) < 2:
            continue
        lower = t.lower()
        if lower in seen:
            continue
        seen.add(lower)
        result.append(t)
    return result[:max_terms]


def _git_repo_name(cwd: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            timeout=5,
            cwd=cwd,
        )
        if result.returncode == 0:
            return Path(result.stdout.strip()).name
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def _list_project_files(cwd: Path, max_files: int = 20) -> list[str]:
    names: list[str] = []
    try:
        for entry in cwd.iterdir():
            if len(names) >= max_files:
                break
            names.append(entry.name)
    except PermissionError:
        pass
    return names


def _parse_dependency_names(cwd: Path) -> list[str]:
    """Extract package/project names from common dependency manifests."""
    deps: list[str] = []
    try:
        candidates = [
            ("pyproject.toml", _parse_pyproject_toml),
            ("requirements.txt", _parse_requirements_txt),
            ("package.json", _parse_package_json),
            ("go.mod", _parse_go_mod),
            ("Cargo.toml", _parse_cargo_toml),
        ]
        for filename, parser in candidates:
            path = cwd / filename
            if path.is_file():
                try:
                    content = path.read_text(encoding="utf-8", errors="replace")
                    deps.extend(parser(content))
                except (OSError, UnicodeDecodeError):
                    continue
    except PermissionError:
        pass
    return deps


def _parse_pyproject_toml(content: str) -> list[str]:
    import tomllib

    names: list[str] = []
    try:
        data = tomllib.loads(content)
        for key in ("dependencies", "optional-dependencies"):
            raw = data.get("project", {}).get(key, {})
            if isinstance(raw, list):
                for entry in raw:
                    if isinstance(entry, str):
                        pkg = entry.split("[")[0]
                        for sep in (">", "<", "~", "!", "="):
                            pkg = pkg.split(sep)[0]
                        pkg = pkg.strip()
                        if pkg and pkg[0].isalpha():
                            names.append(pkg)
    except Exception:
        pass
    return names


def _parse_requirements_txt(content: str) -> list[str]:
    names: list[str] = []
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("-"):
            continue
        pkg = line.split("[")[0]
        for sep in (">", "<", "~", "=", "!"):
            pkg = pkg.split(sep)[0]
        pkg = pkg.strip()
        if pkg and pkg[0].isalpha():
            names.append(pkg)
    return names


def _parse_package_json(content: str) -> list[str]:
    import json

    names: list[str] = []
    try:
        data = json.loads(content)
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            deps = data.get(section, {})
            if isinstance(deps, dict):
                names.extend(deps.keys())
    except Exception:
        pass
    return names


def _parse_go_mod(content: str) -> list[str]:
    names: list[str] = []
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("require (") or line.startswith("require "):
            continue
        if line.startswith("//") or line == "":
            continue
        parts = line.split()
        if len(parts) >= 1 and "/" in parts[0]:
            name = parts[0].split("/")[-1]
            if name and name[0].isalpha():
                names.append(name)
    return names


def _parse_cargo_toml(content: str) -> list[str]:
    import tomllib

    names: list[str] = []
    try:
        data = tomllib.loads(content)
        deps = data.get("dependencies", {})
        if isinstance(deps, dict):
            names.extend(deps.keys())
    except Exception:
        pass
    return names


def build_vocabulary_context(config: AppConfig, cwd: Path | None = None) -> VocabularyContext:
    """Build a dynamic vocabulary list from the user's current project context."""
    if cwd is None:
        cwd = Path.cwd()

    ctx = config.transcription.context
    sources: dict[str, list[str]] = {}

    # 1. User-configured terms
    sources["custom_vocabulary"] = list(config.transcription.custom_vocabulary)

    # 2. CWD name
    if ctx.include_current_working_directory:
        sources["working_directory"] = [cwd.name]

    # 3. Git repo name
    if ctx.include_git_repository_name:
        repo = _git_repo_name(cwd)
        if repo:
            sources["git_repository"] = [repo]

    # 4. Project files
    if ctx.include_project_files:
        sources["project_files"] = _list_project_files(cwd)

    # 5. Dependency names
    if ctx.include_dependency_names:
        sources["dependencies"] = _parse_dependency_names(cwd)

    # Flatten all terms
    all_terms: list[str] = []
    for key in (
        "custom_vocabulary",
        "working_directory",
        "git_repository",
        "project_files",
        "dependencies",
    ):
        all_terms.extend(sources.get(key, []))

    filtered = _filter_terms(all_terms, ctx.max_terms)

    return VocabularyContext(
        terms=tuple(filtered),
        sources={k: tuple(v) for k, v in sources.items()},
    )
