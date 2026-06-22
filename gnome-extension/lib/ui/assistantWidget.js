// vox2ai assistant popover widget — state-driven GNOME Shell UI

import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {State} from '../state.js';

export const AssistantWidget = class AssistantWidget extends PopupMenu.PopupBaseMenuItem {
    static { GObject.registerClass(this); }

    _init(controller) {
        super._init({reactive: false, can_focus: false});
        this._controller = controller;

        this._main = new St.BoxLayout({vertical: true, style_class: 'vox2ai-widget'});
        this.add_child(this._main);

        // ── Header ────────────────────────────────────────
        this._headerBox = new St.BoxLayout({style_class: 'vox2ai-header'});
        this._title = new St.Label({text: 'vox2ai', style_class: 'vox2ai-title'});
        this._statusLabel = new St.Label({text: '', style_class: 'vox2ai-status'});
        this._headerBox.add_child(this._title);
        this._headerBox.add_child(this._statusLabel);
        this._main.add_child(this._headerBox);

        // ── Body ───────────────────────────────────────────
        this._body = new St.BoxLayout({vertical: true, style_class: 'vox2ai-body'});
        this._main.add_child(this._body);

        // State message (disconnected, idle, starting, transcribing, thinking, error)
        this._stateMsg = new St.Label({style_class: 'vox2ai-state-message'});
        this._body.add_child(this._stateMsg);

        // Waveform area
        this._waveformBox = new St.BoxLayout({style_class: 'vox2ai-waveform'});
        this._body.add_child(this._waveformBox);

        // Partial transcript
        this._partialLabel = new St.Label({style_class: 'vox2ai-partial'});
        this._body.add_child(this._partialLabel);

        // Message row: user transcript
        this._userRow = new St.BoxLayout({vertical: true, style_class: 'vox2ai-message-row'});
        this._userLabel = new St.Label({text: 'You', style_class: 'vox2ai-label'});
        this._userText = new St.Label({style_class: 'vox2ai-message', reactive: true});
        this._userRow.add_child(this._userLabel);
        this._userRow.add_child(this._userText);
        this._body.add_child(this._userRow);

        // Message row: assistant answer
        this._answerRow = new St.BoxLayout({vertical: true, style_class: 'vox2ai-message-row'});
        this._answerLabel = new St.Label({text: 'vox2ai', style_class: 'vox2ai-label'});
        this._answerText = new St.Label({style_class: 'vox2ai-answer', reactive: true});
        this._answerRow.add_child(this._answerLabel);
        this._answerRow.add_child(this._answerText);
        this._body.add_child(this._answerRow);

        // Command approval UI
        this._approvalBox = new St.BoxLayout({vertical: true, style_class: 'vox2ai-approval'});
        this._cmdBlock = new St.Label({style_class: 'vox2ai-cmd-block', reactive: true});
        this._cmdRisk = new St.Label({style_class: 'vox2ai-risk'});
        this._cmdReason = new St.Label({style_class: 'vox2ai-detail'});
        this._cmdDir = new St.Label({style_class: 'vox2ai-detail'});
        this._approvalBox.add_child(this._cmdBlock);
        this._approvalBox.add_child(this._cmdRisk);
        this._approvalBox.add_child(this._cmdReason);
        this._approvalBox.add_child(this._cmdDir);
        this._body.add_child(this._approvalBox);

        // ── Button rows ───────────────────────────────────
        this._btnRow = new St.BoxLayout({style_class: 'vox2ai-btn-row'});
        this._main.add_child(this._btnRow);

        // Create all buttons
        this._startBtn = this._mkBtn('Start Recording', 'vox2ai-btn-primary', () => controller.startRecording());
        this._cancelBtn = this._mkBtn('Cancel', 'vox2ai-btn-plain', () => controller.cancel());
        this._runBtn = this._mkBtn('Run', 'vox2ai-btn-primary', () => controller.approveCommand());
        this._denyBtn = this._mkBtn('Deny', 'vox2ai-btn-plain', () => controller.denyCommand());
        this._copyBtn = this._mkBtn('Copy', 'vox2ai-btn-plain', () => this._copyCurrent());

        this._btnRow.add_child(this._startBtn);
        this._btnRow.add_child(this._cancelBtn);
        this._btnRow.add_child(this._runBtn);
        this._btnRow.add_child(this._denyBtn);
        this._btnRow.add_child(this._copyBtn);

        controller.onUpdate(() => this._render());
        this._render();
    }

    _mkBtn(text, cls, cb) {
        const b = new St.Button({label: text, style_class: `vox2ai-btn ${cls}`.trim(), can_focus: true});
        b.connect('clicked', cb);
        return b;
    }

    _render() {
        const c = this._controller;
        const s = c.state;

        // Status
        const statusMap = {
            disconnected: 'Disconnected',
            'backend-starting': 'Connecting…',
            idle: 'Ready',
            listening: 'Listening',
            transcribing: 'Processing…',
            thinking: 'Thinking…',
            answering: 'Answering',
            'command-approval': 'Approval',
            'command-running': 'Running…',
            error: 'Error',
        };
        this._statusLabel.text = statusMap[s] || '';
        this._statusLabel.style_class = `vox2ai-status ${s === 'error' ? 'vox2ai-status-error' : ''}`;

        // Hide everything first
        this._stateMsg.visible = false;
        this._waveformBox.visible = false;
        this._partialLabel.visible = false;
        this._userRow.visible = false;
        this._answerRow.visible = false;
        this._approvalBox.visible = false;
        this._startBtn.visible = false;
        this._cancelBtn.visible = false;
        this._runBtn.visible = false;
        this._denyBtn.visible = false;
        this._copyBtn.visible = false;

        switch (s) {
            case State.DISCONNECTED:
                this._stateMsg.text = 'Backend is not running.';
                this._stateMsg.visible = true;
                this._startBtn.set_label('Start Backend');
                this._startBtn.visible = true;
                break;

            case State.BACKEND_STARTING:
                this._stateMsg.text = 'Connecting to backend…';
                this._stateMsg.visible = true;
                break;

            case State.IDLE:
                this._stateMsg.text = 'Ask with voice or type a message.';
                this._stateMsg.visible = true;
                this._startBtn.set_label('Start Recording');
                this._startBtn.visible = true;
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
                this._stateMsg.text = 'Processing speech…';
                this._stateMsg.visible = true;
                this._cancelBtn.visible = true;
                break;

            case State.THINKING:
                this._userText.text = c.transcript;
                this._userRow.visible = true;
                this._stateMsg.text = 'Thinking…';
                this._stateMsg.visible = true;
                this._cancelBtn.visible = true;
                break;

            case State.ANSWERING:
                if (c.transcript) {
                    this._userText.text = c.transcript;
                    this._userRow.visible = true;
                }
                const cursor = c.answerCursor ? '▊' : '';
                this._answerText.text = c.answerText + cursor;
                this._answerRow.visible = true;
                if (c.answerText && !c.answerCursor) {
                    this._copyBtn.set_label('Copy answer');
                    this._copyBtn.visible = true;
                }
                break;

            case State.COMMAND_APPROVAL: {
                const ca = c.commandApproval;
                if (ca) {
                    this._cmdBlock.text = ca.command;
                    const cls = ca.risk === 'high' ? 'vox2ai-risk-high' :
                                ca.risk === 'medium' ? 'vox2ai-risk-med' : 'vox2ai-risk-low';
                    this._cmdRisk.text = `Risk: ${ca.risk.charAt(0).toUpperCase() + ca.risk.slice(1)}`;
                    this._cmdRisk.style_class = `vox2ai-risk ${cls}`;
                    this._cmdReason.text = ca.reason ? `Reason: ${ca.reason}` : '';
                    this._cmdDir.text = ca.workingDirectory ? `Directory: ${ca.workingDirectory}` : '';
                }
                this._approvalBox.visible = true;
                this._runBtn.visible = true;
                this._denyBtn.visible = true;
                this._copyBtn.set_label('Copy command');
                this._copyBtn.visible = true;
                break;
            }

            case State.COMMAND_RUNNING:
                this._stateMsg.text = 'Running command…';
                this._stateMsg.visible = true;
                break;

            case State.ERROR:
                this._stateMsg.text = c.errorMessage || 'Error';
                this._stateMsg.visible = true;
                this._startBtn.set_label('Retry');
                this._startBtn.visible = true;
                this._copyBtn.set_label('Copy error');
                this._copyBtn.visible = true;
                break;
        }
    }

    _renderWaveform(levels) {
        this._waveformBox.destroy_all_children();
        const n = levels && levels.length > 0 ? levels.length : 21;
        for (let i = 0; i < n; i++) {
            const h = levels && levels[i] ? Math.max(3, Math.min(36, levels[i] * 80)) : 3;
            const bar = new St.Widget({style_class: 'vox2ai-bar'});
            bar.set_height(h);
            this._waveformBox.add_child(bar);
        }
    }

    _copyCurrent() {
        const c = this._controller;
        const s = c.state;
        let text = '';
        if (s === State.ANSWERING)
            text = c.answerText;
        else if (s === State.COMMAND_APPROVAL && c.commandApproval)
            text = c.commandApproval.command;
        else if (s === State.ERROR)
            text = c.errorMessage || '';
        if (text)
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
    }
};
