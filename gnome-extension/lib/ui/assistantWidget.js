// vox2ai assistant popover widget

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {State} from '../state.js';

export const AssistantWidget = class AssistantWidget extends PopupMenu.PopupBaseMenuItem {
    constructor(controller, onClose) {
        super({reactive: false, can_focus: false});
        this._controller = controller;
        this._onClose = onClose;

        this._mainBox = new St.BoxLayout({
            vertical: true,
            style_class: 'vox2ai-assistant',
        });
        this.add_child(this._mainBox);

        // Header
        this._header = new St.Label({
            text: 'vox2ai',
            style_class: 'vox2ai-header',
        });
        this._mainBox.add_child(this._header);

        // Status bar
        this._statusBar = new St.BoxLayout({
            style_class: 'vox2ai-status-bar',
        });
        this._statusLabel = new St.Label({text: ''});
        this._statusBar.add_child(this._statusLabel);
        this._mainBox.add_child(this._statusBar);

        // Body
        this._body = new St.BoxLayout({
            vertical: true,
            style_class: 'vox2ai-body',
        });
        this._mainBox.add_child(this._body);

        // Content areas (hidden by default)
        this._stateMessage = new St.Label({style_class: 'vox2ai-state-message'});
        this._body.add_child(this._stateMessage);

        this._waveformBox = new St.BoxLayout({style_class: 'vox2ai-waveform'});
        this._body.add_child(this._waveformBox);

        this._partialLabel = new St.Label({style_class: 'vox2ai-partial-transcript'});
        this._body.add_child(this._partialLabel);

        // Message area for transcript + answer
        this._messageArea = new St.BoxLayout({vertical: true});
        this._messageLabel = new St.Label({style_class: 'vox2ai-message-label', text: 'You'});
        this._messageContent = new St.Label({
            style_class: 'vox2ai-message-content',
            reactive: true,
            track_hover: true,
            selectable: true,
        });
        this._messageArea.add_child(this._messageLabel);
        this._messageArea.add_child(this._messageContent);

        this._answerLabel = new St.Label({style_class: 'vox2ai-message-label', text: 'vox2ai'});
        this._answerContent = new St.Label({
            style_class: 'vox2ai-answer',
            reactive: true,
            track_hover: true,
            selectable: true,
        });
        this._messageArea.add_child(this._answerLabel);
        this._messageArea.add_child(this._answerContent);
        this._body.add_child(this._messageArea);

        // Command approval area
        this._approvalBox = new St.BoxLayout({vertical: true, style_class: 'vox2ai-command-approval'});
        this._approvalCommand = new St.Label({style_class: 'vox2ai-command-block', selectable: true});
        this._approvalRisk = new St.Label({style_class: 'vox2ai-risk-indicator'});
        this._approvalReason = new St.Label({style_class: 'vox2ai-approval-detail'});
        this._approvalDetail = new St.Label({style_class: 'vox2ai-approval-detail'});
        this._approvalBox.add_child(this._approvalCommand);
        this._approvalBox.add_child(this._approvalRisk);
        this._approvalBox.add_child(this._approvalReason);
        this._approvalBox.add_child(this._approvalDetail);

        this._approvalBtnBox = new St.BoxLayout({style_class: 'vox2ai-btn-row'});
        this._runBtn = this._makeBtn('Run', 'vox2ai-btn-primary', () => this._controller.approveCommand());
        this._denyBtn = this._makeBtn('Deny', 'vox2ai-btn-danger', () => this._controller.denyCommand());
        this._copyCmdBtn = this._makeBtn('Copy command', '', () => {
            if (this._controller.commandApproval)
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._controller.commandApproval.command);
        });
        this._approvalBtnBox.add_child(this._runBtn);
        this._approvalBtnBox.add_child(this._copyCmdBtn);
        this._approvalBtnBox.add_child(this._denyBtn);
        this._approvalBox.add_child(this._approvalBtnBox);
        this._body.add_child(this._approvalBox);

        // Cancel button (for listening/transcribing/thinking)
        this._cancelBtn = this._makeBtn('Cancel', 'vox2ai-btn-cancel', () => this._controller.cancel());
        this._body.add_child(this._cancelBtn);

        // Copy answer button
        this._copyAnswerBtn = this._makeBtn('Copy answer', '', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._controller.answerText);
        });
        this._body.add_child(this._copyAnswerBtn);

        controller.onUpdate(() => this._render());
        this._render();
    }

    _makeBtn(text, styleClass, cb) {
        const btn = new St.Button({
            label: text,
            style_class: `vox2ai-btn ${styleClass}`.trim(),
            can_focus: true,
        });
        btn.connect('clicked', cb);
        return btn;
    }

    _render() {
        const c = this._controller;
        const s = c.state;

        // Status
        this._statusLabel.text = this._statusText(s);
        this._statusBar.style_class = `vox2ai-status-bar ${s === 'error' ? 'vox2ai-state-error' : ''}`;

        // Hide all by default
        this._stateMessage.visible = false;
        this._waveformBox.visible = false;
        this._partialLabel.visible = false;
        this._messageArea.visible = false;
        this._approvalBox.visible = false;
        this._cancelBtn.visible = false;
        this._copyAnswerBtn.visible = false;

        switch (s) {
            case State.DISCONNECTED:
                this._stateMessage.text = 'Backend is not running.';
                this._stateMessage.visible = true;
                break;

            case State.BACKEND_STARTING:
                this._stateMessage.text = 'Starting backend...';
                this._stateMessage.visible = true;
                break;

            case State.IDLE:
                this._stateMessage.text = 'Ready. Press Ctrl+Space to speak.';
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
                this._renderTranscript(c.transcript);
                this._messageArea.visible = true;
                this._messageContent.text = c.transcript;
                this._stateMessage.text = 'Thinking...';
                this._stateMessage.visible = true;
                this._cancelBtn.visible = true;
                break;

            case State.ANSWERING:
                if (c.transcript) {
                    this._messageContent.text = c.transcript;
                    this._answerLabel.visible = true;
                } else {
                    this._messageLabel.text = 'You';
                    this._messageContent.text = c.transcript;
                }
                this._answerContent.text = c.answerText + (c.answerCursor ? '▊' : '');
                this._messageArea.visible = true;
                if (c.answerText && !c.answerCursor)
                    this._copyAnswerBtn.visible = true;
                break;

            case State.COMMAND_APPROVAL:
                if (c.commandApproval) {
                    const ca = c.commandApproval;
                    this._approvalCommand.text = ca.command;
                    const riskClass = ca.risk === 'high' ? 'vox2ai-risk-high' :
                        ca.risk === 'medium' ? 'vox2ai-risk-medium' : 'vox2ai-risk-low';
                    this._approvalRisk.text = `Risk: ${ca.risk.charAt(0).toUpperCase() + ca.risk.slice(1)}`;
                    this._approvalRisk.style_class = `vox2ai-risk-indicator ${riskClass}`;
                    this._approvalReason.text = ca.reason ? `Reason: ${ca.reason}` : '';
                    this._approvalDetail.text = `Working directory: ${ca.workingDirectory}`;
                }
                this._approvalBox.visible = true;
                break;

            case State.COMMAND_RUNNING:
                this._stateMessage.text = 'Running command...';
                this._stateMessage.visible = true;
                break;

            case State.ERROR:
                this._stateMessage.text = c.errorMessage || 'Error';
                this._stateMessage.visible = true;
                break;
        }
    }

    _renderWaveform(levels) {
        this._waveformBox.destroy_all_children();
        if (!levels || levels.length === 0) {
            for (let i = 0; i < 21; i++) {
                const bar = new St.Widget({style_class: 'vox2ai-waveform-bar'});
                bar.set_height(3);
                this._waveformBox.add_child(bar);
            }
            return;
        }
        for (const rms of levels) {
            const h = Math.max(3, Math.min(36, rms * 80));
            const bar = new St.Widget({style_class: 'vox2ai-waveform-bar'});
            bar.set_height(h);
            this._waveformBox.add_child(bar);
        }
    }

    _renderTranscript(t) {
        if (!t) {
            this._messageLabel.text = '';
            this._messageContent.text = '';
            this._messageArea.visible = false;
        }
    }

    _statusText(s) {
        switch (s) {
            case State.DISCONNECTED: return 'Disconnected';
            case State.BACKEND_STARTING: return 'Connecting...';
            case State.IDLE: return 'Ready';
            case State.LISTENING: return 'Listening';
            case State.TRANSCRIBING: return 'Transcribing';
            case State.THINKING: return 'Thinking...';
            case State.ANSWERING: return 'Answering';
            case State.COMMAND_APPROVAL: return 'Approval required';
            case State.COMMAND_RUNNING: return 'Running command';
            case State.ERROR: return 'Error';
            default: return '';
        }
    }
};
