import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {
    escapeMarkup,
    inlineToMarkup,
    isCommandLanguage,
    looksLikeCommand,
    parseMarkdown,
} from '../markdown/parseMarkdown.js';

function vbox(spacing = 0, styleClass = '') {
    return new St.Widget({
        layout_manager: new Clutter.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            spacing,
        }),
        style_class: styleClass,
    });
}

function hbox(spacing = 0, styleClass = '') {
    return new St.Widget({
        layout_manager: new Clutter.BoxLayout({spacing}),
        style_class: styleClass,
    });
}

function markupLabel(markup, styleClass) {
    const label = new St.Label({style_class: styleClass});
    label.clutter_text.set_line_wrap(true);
    label.clutter_text.set_markup(markup);
    return label;
}

function plainLabel(text, styleClass) {
    const label = new St.Label({text, style_class: styleClass});
    label.clutter_text.set_line_wrap(true);
    return label;
}

function button(label, cb, flashLabel = 'Copied') {
    const actor = new St.Button({
        label,
        style_class: 'vox2ai-code-copy-button',
        can_focus: true,
        reactive: true,
        track_hover: true,
    });
    actor.connect('clicked', () => {
        try {
            cb();
            const original = actor.label || label;
            actor.label = flashLabel;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                try {
                    actor.label = original;
                } catch (e) {
                    // The answer may have re-rendered while streaming.
                }
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {
            log(`[vox2ai] code copy error: ${e}`);
        }
    });
    return actor;
}

export function renderMarkdown(parent, markdown, options = {}) {
    const onCopy = options.onCopy || (() => {});
    const onExplainCommand = options.onExplainCommand || (() => {});
    const onRunCommand = options.onRunCommand || (() => {});
    const onRunCommandInTerminal = options.onRunCommandInTerminal || (() => {});
    let blocks;
    try {
        blocks = parseMarkdown(markdown);
    } catch (e) {
        log(`[vox2ai] markdown parse error: ${e}`);
        parent.add_child(plainLabel(String(markdown || ''), 'vox2ai-markdown-paragraph'));
        return;
    }

    if (blocks.length === 0) {
        parent.add_child(plainLabel('', 'vox2ai-markdown-paragraph'));
        return;
    }

    for (const block of blocks) {
        try {
            if (block.type === 'code_block') {
                parent.add_child(renderCodeBlock(
                    block.language,
                    block.code,
                    onCopy,
                    onExplainCommand,
                    onRunCommand,
                    onRunCommandInTerminal
                ));
            } else if (block.type === 'list') {
                parent.add_child(renderList(block));
            } else if (block.type === 'paragraph') {
                if (looksLikeCommand(block.text))
                    parent.add_child(renderCodeBlock(
                        'bash',
                        block.text,
                        onCopy,
                        onExplainCommand,
                        onRunCommand,
                        onRunCommandInTerminal
                    ));
                else
                    parent.add_child(markupLabel(inlineToMarkup(block.text), 'vox2ai-markdown-paragraph'));
            }
        } catch (e) {
            log(`[vox2ai] markdown block render error: ${e}`);
            parent.add_child(plainLabel(block.text || block.code || '', 'vox2ai-markdown-paragraph'));
        }
    }
}

export function renderCodeBlock(
    language,
    code,
    onCopy,
    onExplainCommand = () => {},
    onRunCommand = () => {},
    onRunCommandInTerminal = () => {}
) {
    const card = vbox(6, 'vox2ai-code-block');
    const header = hbox(8, 'vox2ai-code-header');
    const lang = String(language || '').trim();
    const copyLabel = isCommandLanguage(lang) ? 'Copy command' : 'Copy code';

    header.add_child(new St.Label({
        text: lang || (copyLabel === 'Copy command' ? 'command' : 'code'),
        style_class: 'vox2ai-code-language',
        y_align: Clutter.ActorAlign.CENTER,
    }));
    header.add_child(new St.Widget({x_expand: true}));
    header.add_child(button(
        copyLabel,
        () => onCopy(String(code || ''), `${copyLabel.replace('Copy ', '')} copied`)
    ));
    card.add_child(header);

    const label = plainLabel(String(code || ''), 'vox2ai-code-text');
    card.add_child(label);
    if (copyLabel === 'Copy command') {
        const actions = hbox(6, 'vox2ai-command-card-actions');
        actions.add_child(button('Explain', () => onExplainCommand(String(code || '')), 'Explaining'));
        actions.add_child(button('Run', () => onRunCommand(String(code || '')), 'Approval'));
        actions.add_child(button('Terminal', () => onRunCommandInTerminal(String(code || '')), 'Copied'));
        card.add_child(actions);
    }
    return card;
}

function renderList(block) {
    const box = vbox(4, 'vox2ai-markdown-list');
    const items = block.items || [];
    for (let i = 0; i < items.length; i++) {
        const row = hbox(6, 'vox2ai-markdown-list-row');
        row.add_child(new St.Label({
            text: block.ordered ? `${i + 1}.` : '•',
            style_class: 'vox2ai-markdown-list-marker',
            y_align: Clutter.ActorAlign.START,
        }));
        row.add_child(markupLabel(inlineToMarkup(items[i]), 'vox2ai-markdown-list-item'));
        box.add_child(row);
    }
    return box;
}

export function escapedPlainMarkup(text) {
    return escapeMarkup(text);
}
