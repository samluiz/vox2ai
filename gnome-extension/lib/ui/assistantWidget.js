// vox2ai assistant popover widget

import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {State} from '../state.js';

export const AssistantWidget = class AssistantWidget extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    _init(controller, onClose) {
        super._init({reactive: false, can_focus: false});
        this._controller = controller;
        this._onClose = onClose;

        this._mainBox = new St.BoxLayout({vertical: true, style_class: 'vox2ai-assistant'});
        this.add_child(this._mainBox);

        this._header = new St.Label({text: 'vox2ai', style_class: 'vox2ai-header'});
        this._mainBox.add_child(this._header);

        this._statusBar = new St.BoxLayout({style_class: 'vox2ai-status-bar'});
        this._statusLabel = new St.Label({text: ''});
        this._statusBar.add_child(this._statusLabel);
        this._mainBox.add_child(this._statusBar);

        this._body = new St.BoxLayout({vertical: true, style_class: 'vox2ai-body'});
        this._mainBox.add_child(this._body);

        this._stateMessage = new St.Label({style_class: 'vox2ai-state-message'});
        this._body.add_child(this._stateMessage);

        this._waveformBox = new St.BoxLayout({style_class: 'vox2ai-waveform'});
        this._body.add_child(this._waveformBox);

        this._partialLabel = new St.Label({style_class: 'vox2ai-partial-transcript'});
        this._body.add_child(this._partialLabel);

        this._messageContent = new St.Label({
            style_class: 'vox2ai-message-content',
            reactive: true, track_hover: true, selectable: true,
        });
        this._answerContent = new St.Label({
            style_class: 'vox2ai-answer',
            reactive: true, track_hover: true, selectable: true,
        });
        this._body.add_child(this._messageContent);
        this._body.add_child(this._answerContent);

        this._cancelBtn = this._makeBtn('Cancel', 'vox2ai-btn-cancel', () => this._controller.cancel());
        this._body.add_child(this._cancelBtn);

        this._copyAnswerBtn = this._makeBtn('Copy answer', '', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._controller.answerText);
        });
        this._body.add_child(this._copyAnswerBtn);

        controller.onUpdate(() => this._render());
        this._render();
    }

    _makeBtn(text, styleClass, cb) {
        const btn = new St.Button({label: text, style_class: `vox2ai-btn ${styleClass}`.trim(), can_focus: true});
        btn.connect('clicked', cb);
        return btn;
    }

    _render() {
        const c = this._controller;
        const s = c.state;

        this._statusLabel.text = this._statusText(s);
        this._statusBar.style_class = `vox2ai-status-bar ${s === 'error' ? 'vox2ai-state-error' : ''}`;

        this._stateMessage.visible = false;
        this._waveformBox.visible = false;
        this._partialLabel.visible = false;
        this._messageContent.visible = false;
        this._answerContent.visible = false;
        this._cancelBtn.visible = false;
        this._copyAnswerBtn.visible = false;

        switch (s) {
            case State.DISCONNECTED:
                this._stateMessage.text = 'Backend is not running.';
                this._stateMessage.visible = true;
                break;
            case State.BACKEND_STARTING:
                this._stateMessage.text = 'Connecting...';
                this._stateMessage.visible = true;
                break;
            case State.IDLE:
                this._stateMessage.text = 'Press Ctrl+Space to speak.';
                this._stateMessage.visible = true;
                break;
            case State.LISTENING:
                this._renderWaveform(c.levels);
                this._waveformBox.visible = true;
                if (c.partialTranscript) {
                    this._partialLabel.text = c.partialTranscript;
                    this._partialLabel.visible = true;
                }
                this._cancelBtn.visible = true;
                break;
            case State.TRANSCRIBING:
                this._stateMessage.text = 'Processing speech...';
                this._stateMessage.visible = true;
                this._cancelBtn.visible = true;
                break;
            case State.THINKING:
                this._messageContent.text = c.transcript;
                this._messageContent.visible = true;
                this._stateMessage.text = 'Thinking...';
                this._stateMessage.visible = true;
                this._cancelBtn.visible = true;
                break;
            case State.ANSWERING:
                this._messageContent.text = c.transcript;
                this._messageContent.visible = true;
                this._answerContent.text = c.answerText + (c.answerCursor ? '▊' : '');
                this._answerContent.visible = true;
                if (c.answerText && !c.answerCursor)
                    this._copyAnswerBtn.visible = true;
                break;
            case State.ERROR:
                this._stateMessage.text = c.errorMessage || 'Error';
                this._stateMessage.visible = true;
                break;
        }
    }

    _renderWaveform(levels) {
        this._waveformBox.destroy_all_children();
        const count = levels && levels.length > 0 ? levels.length : 21;
        for (let i = 0; i < count; i++) {
            const h = levels && levels[i] ? Math.max(3, Math.min(36, levels[i] * 80)) : 3;
            const bar = new St.Widget({style_class: 'vox2ai-waveform-bar'});
            bar.set_height(h);
            this._waveformBox.add_child(bar);
        }
    }

    _statusText(s) {
        return {
            disconnected: 'Disconnected',
            'backend-starting': 'Connecting...',
            idle: 'Ready',
            listening: 'Listening',
            transcribing: 'Transcribing',
            thinking: 'Thinking...',
            answering: 'Answering',
            'command-approval': 'Approval required',
            'command-running': 'Running command',
            error: 'Error',
        }[s] || '';
    }
};
