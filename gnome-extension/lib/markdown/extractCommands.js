import { escapeMarkup } from "./parseMarkdown.js";

const COMMAND_PREFIXES = [
    "sudo",
    "systemctl",
    "journalctl",
    "dmesg",
    "cat",
    "grep",
    "rg",
    "find",
    "ls",
    "cd",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "chmod",
    "chown",
    "dnf",
    "apt",
    "flatpak",
    "gsettings",
    "gnome-extensions",
    "glib-compile-schemas",
    "python",
    "python3",
    "pip",
    "uv",
    "cargo",
    "git",
    "docker",
    "podman",
    "kubectl",
    "psql",
    "make",
    "npm",
    "pnpm",
    "yarn",
    "curl",
    "wget",
    "tar",
    "gzip",
    "unzip",
    "ssh",
    "scp",
    "rsync",
    "ping",
    "traceroute",
    "ip",
    "nmcli",
    "ps",
    "kill",
    "top",
    "htop",
    "df",
    "du",
    "mount",
    "umount",
    "ln",
    "touch",
    "head",
    "tail",
    "less",
    "sort",
    "uniq",
    "wc",
    "tr",
    "cut",
    "awk",
    "sed",
    "tee",
    "env",
    "export",
    "source",
    "which",
    "whereis",
];

const SHELL_PATTERNS = /[|&;><]/;

const INTRO_PHRASES = [
    "run:",
    "Run:",
    "execute:",
    "Execute:",
    "try:",
    "Try:",
    "command:",
    "Command:",
    "use:",
    "Use:",
    "run ",
    "Run ",
];

export { COMMAND_PREFIXES };

export function looksLikeCommand(text) {
    const clean = String(text || "").trim();
    if (!clean || clean.length > 160) return false;

    if (SHELL_PATTERNS.test(clean)) return true;

    const lower = clean.toLowerCase();
    for (const prefix of COMMAND_PREFIXES) {
        if (lower.startsWith(prefix + " ")) return true;
        if (lower === prefix) return true;
    }

    if (/^(sudo|dnf|apt|npm|pnpm|yarn|python|python3|pip|uv|cargo|git|systemctl|journalctl|docker|podman|kubectl|make)\s+/.test(clean))
        return true;

    return false;
}

export function looksLikeIntroCommand(text) {
    const clean = String(text || "").trim();
    if (!clean) return false;

    for (const phrase of INTRO_PHRASES) {
        const idx = clean.indexOf(phrase);
        if (idx === -1) continue;

        const after = clean.slice(idx + phrase.length).trimStart();
        const firstWord = after.split(/\s+/)[0].toLowerCase();
        if (COMMAND_PREFIXES.includes(firstWord)) return true;
    }

    return false;
}

export function extractInlineCommands(text) {
    const source = String(text || "");
    const commands = [];
    let i = 0;

    while (i < source.length) {
        const open = source.indexOf("`", i);
        if (open === -1) break;

        const close = source.indexOf("`", open + 1);
        if (close === -1) break;

        const code = source.slice(open + 1, close).trim();
        if (code && looksLikeCommand(code)) {
            commands.push(code);
        }
        i = close + 1;
    }

    return commands;
}

export function extractParagraphCommands(text) {
    const inline = extractInlineCommands(text);
    if (inline.length > 0) return inline;

    if (looksLikeIntroCommand(text)) {
        for (const phrase of INTRO_PHRASES) {
            const idx = text.indexOf(phrase);
            if (idx === -1) continue;
            const after = text.slice(idx + phrase.length).trimStart();
            const firstWord = after.split(/\s+/)[0].toLowerCase();
            if (COMMAND_PREFIXES.includes(firstWord)) {
                const cmd = after.split(/\n/)[0].trim();
                if (cmd && looksLikeCommand(cmd)) return [cmd];
            }
        }
    }

    return [];
}
