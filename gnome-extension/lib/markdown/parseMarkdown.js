// Small safe Markdown subset for GNOME Shell UI. Never renders HTML.

export function escapeMarkup(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function parseMarkdown(markdown) {
    const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
    const blocks = [];
    let paragraph = [];
    let list = null;
    let code = null;

    const flushParagraph = () => {
        if (paragraph.length === 0)
            return;
        blocks.push({type: 'paragraph', text: paragraph.join('\n').trimEnd()});
        paragraph = [];
    };

    const flushList = () => {
        if (!list)
            return;
        blocks.push(list);
        list = null;
    };

    for (const line of lines) {
        const fence = line.match(/^```([\w.+-]*)\s*$/);
        if (fence) {
            if (code) {
                blocks.push({
                    type: 'code_block',
                    language: code.language,
                    code: code.lines.join('\n'),
                });
                code = null;
            } else {
                flushParagraph();
                flushList();
                code = {language: fence[1] || '', lines: []};
            }
            continue;
        }

        if (code) {
            code.lines.push(line);
            continue;
        }

        if (/^\s*$/.test(line)) {
            flushParagraph();
            flushList();
            continue;
        }

        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        if (bullet) {
            flushParagraph();
            if (!list || list.ordered) {
                flushList();
                list = {type: 'list', ordered: false, items: []};
            }
            list.items.push(bullet[1]);
            continue;
        }

        const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
        if (ordered) {
            flushParagraph();
            if (!list || !list.ordered) {
                flushList();
                list = {type: 'list', ordered: true, items: []};
            }
            list.items.push(ordered[1]);
            continue;
        }

        flushList();
        paragraph.push(line);
    }

    if (code) {
        blocks.push({
            type: 'code_block',
            language: code.language,
            code: code.lines.join('\n'),
        });
    }
    flushParagraph();
    flushList();

    return blocks;
}

export function inlineToMarkup(text) {
    const source = String(text ?? '');
    const parts = [];
    let i = 0;

    while (i < source.length) {
        const nextCode = source.indexOf('`', i);
        if (nextCode === -1) {
            parts.push(_formatEmphasis(source.slice(i)));
            break;
        }

        if (nextCode > i)
            parts.push(_formatEmphasis(source.slice(i, nextCode)));

        const endCode = source.indexOf('`', nextCode + 1);
        if (endCode === -1) {
            parts.push(escapeMarkup(source.slice(nextCode)));
            break;
        }

        const code = escapeMarkup(source.slice(nextCode + 1, endCode));
        parts.push(`<span font_family="monospace" background="#2b2d35">${code}</span>`);
        i = endCode + 1;
    }

    return parts.join('');
}

function _formatEmphasis(text) {
    let escaped = escapeMarkup(text);
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    escaped = escaped.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    return escaped;
}

export function isCommandLanguage(language) {
    const lang = String(language || '').toLowerCase();
    return [
        'bash',
        'sh',
        'zsh',
        'fish',
        'console',
        'terminal',
        'cmd',
        'powershell',
        'ps1',
    ].includes(lang);
}

export function looksLikeCommand(text) {
    const clean = String(text || '').trim();
    if (!clean || clean.includes('\n') || clean.length > 160)
        return false;
    return /^(sudo\s+|dnf\s+|apt\s+|npm\s+|pnpm\s+|yarn\s+|python\s+|pip\s+|uv\s+|cargo\s+|git\s+|systemctl\s+|journalctl\s+|docker\s+|podman\s+|kubectl\s+|make\s+)/.test(clean);
}
