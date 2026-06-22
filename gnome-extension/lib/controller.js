// vox2ai extension controller — orchestrates state, connection, and UI

import GLib from 'gi://GLib';
import {State, StateMachine} from './state.js';
import {Connection} from './connection.js';
import {BackendService} from './backendService.js';

export const Controller = class Controller {
    constructor(settings) {
        this._settings = settings;
        this._stateMachine = new StateMachine();
        this._connection = null;
        this._transcript = '';
        this._partialTranscript = '';
        this._answerText = '';
        this._answerCursor = false;
        this._commandApproval = null;
        this._commandResult = null;
        this._errorMessage = null;
        this._levels = [];

        this._pendingRecordOnReady = false;
        this._listeners = new Set();
    }

    get state() { return this._stateMachine.state; }
    get transcript() { return this._transcript; }
    get partialTranscript() { return this._partialTranscript; }
    get answerText() { return this._answerText; }
    get answerCursor() { return this._answerCursor; }
    get commandApproval() { return this._commandApproval; }
    get commandResult() { return this._commandResult; }
    get errorMessage() { return this._errorMessage; }
    get levels() { return this._levels; }

    onUpdate(fn) { this._listeners.add(fn); }

    _notify() {
        for (const fn of this._listeners)
            fn();
    }

    startBackend() {
        this.ensureBackendRunning();
    }

    connect() {
        const host = this._settings.get_string('backend-host') || '127.0.0.1';
        const port = this._settings.get_int('backend-port') || 8765;

        this._connection = new Connection(host, port);
        this._connection.onEvent((type, data) => {
            if (type === 'state')
                this._onConnectionState(data);
            else if (type === 'event')
                this._onBackendEvent(data);
        });
        this._connection.connect();
        this._stateMachine.setState(State.BACKEND_STARTING);
        this._notify();
    }

    disconnect() {
        if (this._connection) {
            this._connection.disconnect();
            this._connection = null;
        }
        this._stateMachine.setState(State.DISCONNECTED);
        this._notify();
    }

    async reconnect() {
        this.disconnect();
        await BackendService.restart();
        this._stateMachine.setState(State.BACKEND_STARTING);
        this._notify();
        this.connect();
    }

    async ensureBackendRunning() {
        if (this._connection && this._connection.state === 'connected')
            return true;

        this._stateMachine.setState(State.BACKEND_STARTING);
        this._notify();

        // Start the systemd service
        const result = await BackendService.start();
        if (!result.ok) {
            const detail = result.stderr || result.stdout || 'systemctl returned non-zero';
            this._errorMessage = `Failed to start backend: ${detail}`;
            this._stateMachine.setState(State.ERROR);
            this._notify();
            return false;
        }

        // Poll for connection up to timeout
        const timeoutMs = 10000;
        const pollInterval = 400;
        const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;

        this.connect(); // starts non-blocking connection attempt

        while (GLib.get_monotonic_time() < deadline) {
            if (this._connection && this._connection.state === 'connected') {
                this._stateMachine.setState(State.IDLE);
                this._notify();
                return true;
            }
            await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, pollInterval, () => { r(); return GLib.SOURCE_REMOVE; }));
        }

        this._errorMessage = 'Backend service started but connection timed out.';
        this._stateMachine.setState(State.ERROR);
        this._notify();
        return false;
    }

    startRecording() {
        this._pendingRecordOnReady = false;
        if (this._connection && this._connection.state === 'connected') {
            this._connection.send({type: 'start_recording'});
            this._stateMachine.setState(State.LISTENING);
            this._notify();
        } else {
            this._pendingRecordOnReady = true;
            this.ensureBackendRunning().then((ok) => {
                if (ok && this._pendingRecordOnReady) {
                    this._pendingRecordOnReady = false;
                    this._connection?.send({type: 'start_recording'});
                    this._stateMachine.setState(State.LISTENING);
                    this._notify();
                }
            });
        }
    }

    stopRecording() {
        this._connection?.send({type: 'stop_recording'});
    }

    cancel() {
        this._pendingRecordOnReady = false;
        this._connection?.send({type: 'cancel_current_operation'});
        this._clearSession();
    }

    submitText(text) {
        if (!text || !text.trim())
            return;
        this._clearSession();
        this._transcript = text.trim();
        this._stateMachine.setState(State.THINKING);
        this._notify();
        this._connection?.send({type: 'submit_text_prompt', text: this._transcript});
    }

    approveCommand() {
        this._connection?.send({type: 'approve_command'});
        this._stateMachine.setState(State.COMMAND_RUNNING);
        this._notify();
    }

    denyCommand() {
        this._connection?.send({type: 'deny_command'});
        this._commandApproval = null;
        this._stateMachine.setState(State.IDLE);
        this._notify();
    }

    // ---- Backend event handlers ----

    _onConnectionState(s) {
        if (s === 'connected') {
            this._connection.send({type: 'get_settings'});
            if (this._pendingRecordOnReady) {
                this._pendingRecordOnReady = false;
                this._connection.send({type: 'start_recording'});
                this._stateMachine.setState(State.LISTENING);
                this._notify();
            } else {
                this._stateMachine.setState(State.IDLE);
                this._notify();
            }
        } else if (s === 'disconnected') {
            this._stateMachine.setState(State.DISCONNECTED);
            this._notify();
        }
    }

    _onBackendEvent(event) {
        switch (event.type) {
            case 'state':
                this._handleState(event);
                break;
            case 'audio_level':
                this._handleAudioLevel(event);
                break;
            case 'partial_transcript':
                this._partialTranscript = event.text || '';
                this._notify();
                break;
            case 'transcript':
                this._transcript = event.text || '';
                this._partialTranscript = '';
                this._notify();
                break;
            case 'answer_start':
                this._answerText = '';
                this._answerCursor = true;
                this._stateMachine.setState(State.ANSWERING);
                this._notify();
                break;
            case 'answer_delta':
                this._answerText += event.text || '';
                this._notify();
                break;
            case 'answer_done':
                this._answerCursor = false;
                this._notify();
                break;
            case 'command_approval':
                this._commandApproval = {
                    command: event.command || '',
                    reason: event.reason || null,
                    risk: event.risk || 'low',
                    workingDirectory: event.working_directory || '.',
                    expectedEffect: event.expected_effect || '',
                };
                this._stateMachine.setState(State.COMMAND_APPROVAL);
                this._notify();
                break;
            case 'command_running':
                this._stateMachine.setState(State.COMMAND_RUNNING);
                this._notify();
                break;
            case 'command_result':
                this._commandResult = {
                    exitCode: event.exit_code,
                    stdout: event.stdout || '',
                    stderr: event.stderr || '',
                };
                this._notify();
                break;
            case 'operation_cancelled':
                this._clearSession();
                this._stateMachine.setState(State.IDLE);
                this._notify();
                break;
            case 'error':
                this._errorMessage = event.message || 'Unknown error';
                this._stateMachine.setState(State.ERROR);
                this._notify();
                break;
            case 'hello':
                this._connection.send({type: 'get_settings'});
                this._stateMachine.setState(State.IDLE);
                this._notify();
                break;
        }
    }

    _handleState(event) {
        const s = event.state;
        this._errorMessage = null;
        switch (s) {
            case 'listening':
                this._clearSession();
                this._stateMachine.setState(State.LISTENING);
                break;
            case 'transcribing':
                this._stateMachine.setState(State.TRANSCRIBING);
                break;
            case 'thinking':
                this._stateMachine.setState(State.THINKING);
                break;
            case 'streaming_answer':
                this._stateMachine.setState(State.ANSWERING);
                break;
            case 'approval_required':
                // handled by command_approval event
                break;
            case 'error':
                this._errorMessage = event.message || 'Backend error';
                this._stateMachine.setState(State.ERROR);
                break;
            case 'ready':
                this._stateMachine.setState(State.IDLE);
                break;
        }
        this._notify();
    }

    _handleAudioLevel(event) {
        if (this.state !== State.LISTENING)
            return;
        this._levels = [...this._levels.slice(-31), event.rms || 0];
        this._notify();
    }

    _clearSession() {
        this._transcript = '';
        this._partialTranscript = '';
        this._answerText = '';
        this._answerCursor = false;
        this._commandApproval = null;
        this._commandResult = null;
        this._errorMessage = null;
        this._levels = [];
    }
};
