import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {State} from './state.js';
import {Connection} from './connection.js';
import {BackendService} from './backendService.js';

function safeGet(settings, method, key, fallback) {
    try {
        if (!settings) return fallback;
        if (!settings.settings_schema) return fallback;
        if (!settings.settings_schema.has_key(key)) return fallback;
        return settings[method](key);
    } catch (e) {
        return fallback;
    }
}

function screenCaptureMethod(settings) {
    const value = safeGet(settings, 'get_string', 'screen-capture-method', 'auto');
    if (['auto', 'gnome-screenshot', 'portal'].includes(value))
        return value;
    try {
        settings.set_string('screen-capture-method', 'auto');
    } catch (e) {
        log(`[vox2ai] could not reset screen capture method: ${e}`);
    }
    return 'auto';
}

export const Controller = class Controller {
    constructor(settings, soundFeedback = null, notifications = null) {
        this._settings = settings;
        this._soundFeedback = soundFeedback;
        this._notifications = notifications;
        this._connection = null;
        this._listeners = new Set();
        this._pendingRecordOnReady = false;
        this._cancelSafetyTimer = null;
        this._copyFeedbackTimer = null;
        this._lastAnswerNotified = '';
        this._lastCommandNotified = '';
        this._screenCaptureSeq = 0;

        this._state = {
            status: State.DISCONNECTED,
            backendConnected: false,
            backendStarting: false,
            inputText: '',
            userText: '',
            transcript: '',
            partialTranscript: '',
            answer: '',
            answerStreaming: false,
            audioLevel: 0,
            audioPeak: 0,
            lastAudioLevelAt: 0,
            audioEventsReceived: false,
            voiceActive: false,
            speechStarted: false,
            silenceMs: 0,
            lastVoiceActivity: 'unknown',
            autoFinishEnabled: safeGet(settings, 'get_boolean', 'auto-finish-recording', true),
            silenceTimeoutMs: safeGet(settings, 'get_int', 'silence-timeout-ms', 2000),
            processingMessage: '',
            recordingStopReason: '',
            commandApproval: null,
            commandResult: null,
            error: null,
            lastBackendError: null,
            settings: null,
            diagnostics: null,
            capabilities: null,
            copyFeedback: '',
            conversationMode: safeGet(settings, 'get_boolean', 'conversation-mode', false),
            conversationTurnCount: 0,
            screenContext: {
                id: null,
                mode: null,
                status: 'idle',
                error: null,
            },
            safeMode: safeGet(settings, 'get_boolean', 'safe-mode', false),
        };
    }

    get state() {
        return this._state;
    }

    onUpdate(fn) {
        this._listeners.add(fn);
    }

    offUpdate(fn) {
        this._listeners.delete(fn);
    }

    _notify() {
        for (const fn of this._listeners) {
            try {
                fn(this._state);
            } catch (e) {
                log(`[vox2ai] listener error: ${e}`);
            }
        }
    }

    _setState(patch = {}) {
        const oldStatus = this._state.status;
        const next = {...patch};
        if (Object.prototype.hasOwnProperty.call(next, 'status')) {
            next.backendStarting = next.status === State.BACKEND_STARTING;
            if (next.status === State.DISCONNECTED)
                next.backendConnected = false;
        }
        Object.assign(this._state, next);
        this._notify();
        if (this._state.status !== oldStatus)
            this._onStatusChanged(oldStatus, this._state.status);
    }

    _setStatus(status) {
        if (this._state.status === status) {
            this._setState({backendStarting: status === State.BACKEND_STARTING});
            return;
        }
        this._setState({status});
    }

    connect() {
        if (this._connection) {
            this._connection.connect();
            this._setState({status: State.BACKEND_STARTING, backendConnected: false});
            return;
        }

        const host = safeGet(this._settings, 'get_string', 'backend-host', '127.0.0.1');
        const port = safeGet(this._settings, 'get_int', 'backend-port', 8765);

        this._connection = new Connection(host, port);
        this._connection.onEvent((type, data) => {
            try {
                if (type === 'state')
                    this._onConnectionState(data);
                else if (type === 'event')
                    this.handleBackendEvent(data);
            } catch (e) {
                log(`[vox2ai] controller event error: ${e}`);
            }
        });
        this._connection.connect();
        this._setState({status: State.BACKEND_STARTING, backendConnected: false});
    }

    syncRuntimeSettings() {
        const runtime = this._readRuntimeSettings();
        this._setState(runtime);
        if (!this._state.backendConnected)
            return;

        this._send({
            type: 'update_settings',
            settings: {
                voice: {
                    auto_finish_enabled: runtime.autoFinishEnabled,
                    silence_timeout_ms: runtime.silenceTimeoutMs,
                    min_recording_ms: runtime.minRecordingMs,
                    max_recording_ms: runtime.maxRecordingMs,
                    voice_activity_threshold: runtime.voiceActivityThreshold,
                },
                conversation: {
                    enabled: safeGet(this._settings, 'get_boolean', 'conversation-mode', false),
                    max_turns: safeGet(this._settings, 'get_int', 'conversation-max-turns', 8),
                    max_messages: safeGet(this._settings, 'get_int', 'conversation-max-turns', 8) * 2,
                },
                context: {
                    screen_context_enabled: safeGet(this._settings, 'get_boolean', 'screen-context-enabled', false),
                    screen_capture_method: screenCaptureMethod(this._settings),
                    screen_capture_save_debug: safeGet(this._settings, 'get_boolean', 'screen-capture-save-debug', false),
                },
            },
        });
    }

    disconnect() {
        this._clearCancelTimer();
        if (this._connection) {
            this._connection.disconnect();
            this._connection = null;
        }
        this._resetState();
        this._setStatus(State.DISCONNECTED);
    }

    async startBackend() {
        return this.ensureBackendRunning();
    }

    async ensureBackendRunning() {
        if (this._connection && this._state.backendConnected)
            return true;

        const installed = await BackendService.isInstalled();
        if (!installed) {
            this._setState({
                status: State.ERROR,
                error: 'Backend service is not installed. Run scripts/install_backend_service.sh',
                lastBackendError: 'Backend service is not installed',
            });
            return false;
        }

        this._setState({status: State.BACKEND_STARTING, error: null});
        const result = await BackendService.start();
        if (!result.ok) {
            const detail = result.stderr || result.stdout || 'systemctl returned non-zero';
            this._setState({
                status: State.ERROR,
                error: `Failed to start backend: ${detail}`,
                lastBackendError: detail,
            });
            return false;
        }

        this.connect();

        const timeoutMs = 10000;
        const pollInterval = 400;
        const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;

        while (GLib.get_monotonic_time() < deadline) {
            if (this._state.backendConnected) {
                this._setStatus(State.IDLE);
                return true;
            }
            await this._sleep(pollInterval);
        }

        this._setState({
            status: State.ERROR,
            error: 'Backend service started but connection timed out.',
            lastBackendError: 'Connection timed out after service start',
        });
        return false;
    }

    async stopBackend() {
        this.disconnect();
        await BackendService.stop();
    }

    async restartBackend() {
        this.disconnect();
        const result = await BackendService.restart();
        if (!result.ok) {
            const detail = result.stderr || result.stdout || 'systemctl returned non-zero';
            this._setState({
                status: State.ERROR,
                error: `Failed to restart backend: ${detail}`,
                lastBackendError: detail,
            });
            return false;
        }
        this.connect();
        return this._waitForConnection(10000);
    }

    async _waitForConnection(timeoutMs) {
        const pollInterval = 400;
        const deadline = GLib.get_monotonic_time() + timeoutMs * 1000;
        while (GLib.get_monotonic_time() < deadline) {
            if (this._state.backendConnected) {
                this._setStatus(State.IDLE);
                return true;
            }
            await this._sleep(pollInterval);
        }
        this._setState({
            status: State.ERROR,
            error: 'Backend connection timed out.',
            lastBackendError: 'Connection timed out',
        });
        return false;
    }

    _sleep(ms) {
        return new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            r();
            return GLib.SOURCE_REMOVE;
        }));
    }

    async startRecording() {
        if (this._state.status === State.BACKEND_STARTING) {
            this._pendingRecordOnReady = true;
            return;
        }

        this._pendingRecordOnReady = false;
        if (![State.IDLE, State.DISCONNECTED, State.ERROR].includes(this._state.status))
            return;

        this._clearSession(false);
        this.syncRuntimeSettings();

        const ok = await this.ensureBackendRunning();
        if (!ok)
            return;

        if (this._send({type: 'start_recording'}))
            this._setStatus(State.LISTENING);
    }

    stopRecording() {
        if (this._state.status !== State.LISTENING)
            return;
        this._send({type: 'stop_recording'});
        this._setState({
            status: State.TRANSCRIBING,
            processingMessage: 'Processing speech...',
            recordingStopReason: 'manual',
        });
    }

    cancel() {
        this._pendingRecordOnReady = false;
        this._send({type: 'cancel_current_operation'});
        this._resetToIdle();

        this._clearCancelTimer();
        this._cancelSafetyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            this._cancelSafetyTimer = null;
            if (this._state.status !== State.IDLE)
                this._resetToIdle();
            return GLib.SOURCE_REMOVE;
        });
    }

    submitText(text) {
        const clean = (text || '').trim();
        if (!clean)
            return;
        if (this._state.status === State.SCREEN_READY) {
            this.submitScreenQuestion(clean);
            return;
        }
        this._submitText(clean);
    }

    async _submitText(clean) {
        this._clearCancelTimer();
        const ok = await this.ensureBackendRunning();
        if (!ok)
            return;

        this._setState({
            userText: clean,
            transcript: clean,
            partialTranscript: '',
            answer: '',
            answerStreaming: false,
            audioLevel: 0,
            audioPeak: 0,
            commandApproval: null,
            commandResult: null,
            error: null,
        });

        if (this._send({
            type: 'submit_text_prompt',
            text: clean,
            conversation_mode: !!this._state.conversationMode,
        }))
            this._setStatus(State.THINKING);
    }

    async askAboutScreen() {
        if (!this.canAskAboutScreen())
            return;

        const ok = await this.ensureBackendRunning();
        if (!ok)
            return;

        this._clearSession(false);
        this._setState({
            status: State.SCREEN_CAPTURING,
            screenContext: {
                id: null,
                mode: null,
                status: 'capturing',
                error: null,
            },
        });
        const captured = await this._captureScreenWithShell();
        if (captured) {
            this._send({
                type: 'capture_screen_context',
                mode: 'auto',
                image_path: captured.path,
                mime_type: 'image/png',
                width: 0,
                height: 0,
                method: 'gnome-shell',
            });
        } else {
            this._send({type: 'capture_screen_context', mode: 'auto'});
        }
    }

    submitScreenQuestion(question) {
        const clean = (question || '').trim();
        const contextId = this._state.screenContext?.id;
        if (!clean || !contextId)
            return;

        this._setState({
            status: State.SCREEN_ANSWERING,
            userText: clean,
            transcript: clean,
            answer: '',
            answerStreaming: true,
        });
        this._send({
            type: 'submit_screen_question',
            context_id: contextId,
            question: clean,
        });
    }

    canAskAboutScreen() {
        if (!safeGet(this._settings, 'get_boolean', 'screen-context-enabled', false))
            return false;
        const caps = this._state.capabilities?.capabilities || {};
        const screen = caps.screen_capture;
        const vision = caps.vision;
        const ocr = caps.ocr;
        return !!(screen?.available && (vision?.available || ocr?.available));
    }

    async _captureScreenWithShell() {
        if (!Shell.Screenshot)
            return null;

        const dir = GLib.build_filenamev([GLib.get_tmp_dir(), 'vox2ai-screen']);
        try {
            GLib.mkdir_with_parents(dir, 0o700);
        } catch (e) {
            log(`[vox2ai] could not create screenshot directory: ${e}`);
            return null;
        }

        this._screenCaptureSeq += 1;
        const path = GLib.build_filenamev([
            dir,
            `screen-${GLib.get_real_time()}-${this._screenCaptureSeq}.png`,
        ]);

        return new Promise(resolve => {
            let done = false;
            const finish = result => {
                if (done)
                    return;
                done = true;
                if (timer)
                    GLib.source_remove(timer);
                resolve(result);
            };

            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4000, () => {
                log('[vox2ai] GNOME Shell screenshot timed out; falling back to backend capture');
                finish(null);
                return GLib.SOURCE_REMOVE;
            });

            try {
                const screenshot = new Shell.Screenshot();
                screenshot.screenshot(false, path, (...args) => {
                    try {
                        let success = false;
                        if (typeof screenshot.screenshot_finish === 'function') {
                            const asyncResult = args.length > 1 ? args[1] : args[0];
                            const finishResult = screenshot.screenshot_finish(asyncResult);
                            if (Array.isArray(finishResult))
                                success = !!finishResult[0];
                            else
                                success = !!finishResult;
                        } else {
                            success = args.some(arg => arg === true);
                        }
                        finish(success ? {path} : null);
                    } catch (e) {
                        log(`[vox2ai] GNOME Shell screenshot finish error: ${e}`);
                        finish(null);
                    }
                });
            } catch (e) {
                log(`[vox2ai] GNOME Shell screenshot error: ${e}`);
                finish(null);
            }
        });
    }

    toggleConversationMode() {
        const enabled = !this._state.conversationMode;
        this._setState({conversationMode: enabled});
        try {
            this._settings.set_boolean('conversation-mode', enabled);
        } catch (e) {
            log(`[vox2ai] conversation setting error: ${e}`);
        }
        this._send({type: 'set_conversation_mode', enabled});
        this.syncRuntimeSettings();
    }

    clearConversation() {
        this._send({type: 'clear_conversation'});
        this._setState({conversationTurnCount: 0});
    }

    requestCommandRun(command) {
        if (!command)
            return;
        this._send({
            type: 'request_command_approval',
            command,
            reason: 'Run command proposed in the answer.',
        });
    }

    explainCommand(command) {
        if (!command)
            return;
        this._send({type: 'explain_command', command});
        this._setStatus(State.THINKING);
    }

    approveCommand() {
        this._send({type: 'approve_command'});
        this._setStatus(State.COMMAND_RUNNING);
    }

    denyCommand() {
        this._send({type: 'deny_command'});
        this._resetToIdle();
    }

    copyAnswer() {
        const text = this._state.answer;
        if (text)
            this._copyText(text, 'Answer copied');
    }

    copyCommand() {
        const cmd = this._state.commandApproval?.command;
        if (cmd)
            this._copyText(cmd, 'Command copied');
    }

    copyError() {
        const err = this._state.error;
        if (err)
            this._copyText(err, 'Error copied');
    }

    copyOutput() {
        const result = this._state.commandResult;
        if (!result)
            return;

        const text = [
            `Command: ${result.command || ''}`,
            `Exit code: ${result.exitCode}`,
            '',
            'stdout',
            result.stdout || '',
            '',
            'stderr',
            result.stderr || '',
        ].join('\n');
        this._copyText(text, 'Output copied');
    }

    copyText(text, feedback = 'Copied', showFeedback = true) {
        if (text)
            this._copyText(text, feedback, showFeedback);
    }

    showToast(message) {
        if (message)
            this._setCopyFeedback(message);
    }

    doneResult() {
        this._resetToIdle();
    }

    _copyText(text, feedback = 'Copied', showFeedback = true) {
        try {
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
            if (showFeedback)
                this._setCopyFeedback(feedback);
            else
                this._playSound('copy');
            if (this._notifications)
                this._notifications.notifyInfo('Copied', '', null);
        } catch (e) {
            log(`[vox2ai] copy error: ${e}`);
        }
    }

    _setCopyFeedback(message) {
        this._playSound('copy');
        this._setState({copyFeedback: message});
        if (this._copyFeedbackTimer)
            GLib.source_remove(this._copyFeedbackTimer);
        this._copyFeedbackTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._copyFeedbackTimer = null;
            if (this._state.copyFeedback === message)
                this._setState({copyFeedback: ''});
            return GLib.SOURCE_REMOVE;
        });
    }

    _send(data) {
        if (!this._connection)
            return false;
        return this._connection.send(data);
    }

    _onConnectionState(s) {
        if (s === 'connected') {
            this._setState({backendConnected: true, backendStarting: false});
            this._send({type: 'get_settings'});
            this._send({type: 'get_capabilities'});
            this._send({type: 'get_conversation_state'});
            this.syncRuntimeSettings();
            if (this._pendingRecordOnReady) {
                this._pendingRecordOnReady = false;
                this._send({type: 'start_recording'});
                this._setStatus(State.LISTENING);
            } else {
                this._setStatus(State.IDLE);
            }
        } else if (s === 'disconnected') {
            if (this._state.status === State.BACKEND_STARTING)
                this._setState({backendConnected: false});
            else
                this._setState({status: State.DISCONNECTED, backendConnected: false});
        }
    }

    handleBackendEvent(event) {
        if (!event || typeof event !== 'object') {
            log('[vox2ai] ignoring malformed backend event');
            return;
        }

        switch (event.type) {
            case 'state':
                this._handleStateEvent(event);
                break;
            case 'audio_level':
                this._handleAudioLevel(event);
                break;
            case 'voice_activity':
                this._handleVoiceActivity(event);
                break;
            case 'recording_auto_stopping':
                this._setState({
                    status: State.TRANSCRIBING,
                    processingMessage: event.reason === 'silence'
                        ? 'Stopped after silence. Transcribing...'
                        : 'Recording limit reached. Transcribing...',
                    recordingStopReason: event.reason || 'auto',
                });
                this._playSound('auto-stop');
                break;
            case 'recording_stopped':
                this._setState({
                    processingMessage: event.reason === 'auto_silence'
                        ? 'Stopped after silence. Transcribing...'
                        : 'Processing speech...',
                    recordingStopReason: event.reason || 'manual',
                });
                if (event.reason !== 'auto_silence')
                    this._playSound('stop');
                break;
            case 'partial_transcript':
                this._setState({partialTranscript: event.text || ''});
                break;
            case 'transcript':
                this._setState({
                    transcript: event.text || '',
                    userText: event.text || this._state.userText,
                    partialTranscript: '',
                    processingMessage: '',
                });
                break;
            case 'answer_start':
                this._setState({
                    status: this._state.screenContext?.status === 'ready'
                        ? State.SCREEN_ANSWERING
                        : State.ANSWERING,
                    answer: '',
                    answerStreaming: true,
                });
                break;
            case 'answer_delta':
                this._setState({
                    status: this._state.status === State.SCREEN_ANSWERING
                        ? State.SCREEN_ANSWERING
                        : State.ANSWERING,
                    answer: this._state.answer + (event.text || ''),
                    answerStreaming: true,
                });
                break;
            case 'answer_done':
                this._setState({
                    status: this._state.status === State.SCREEN_ANSWERING
                        ? State.SCREEN_ANSWERING
                        : State.ANSWERING,
                    answerStreaming: false,
                });
                this._playSound('answer-done');
                break;
            case 'command_approval':
                this._setState({
                    status: State.COMMAND_APPROVAL,
                    commandApproval: {
                        command: event.command || '',
                        reason: event.reason || null,
                        risk: event.risk || 'low',
                        workingDirectory: event.working_directory || '.',
                        expectedEffect: event.expected_effect || '',
                    },
                });
                break;
            case 'command_running':
                this._setStatus(State.COMMAND_RUNNING);
                break;
            case 'command_result':
                {
                    const result = {
                        command: event.command || this._state.commandApproval?.command || '',
                        exitCode: event.exit_code,
                        stdout: event.stdout || '',
                        stderr: event.stderr || '',
                    };
                    this._setState({
                        status: State.RESULT,
                        commandResult: result,
                    });
                    this._notifyCommandDone(event);
                }
                break;
            case 'operation_cancelled':
                this._clearCancelTimer();
                this._playSound('cancel');
                this._resetToIdle();
                break;
            case 'error':
                this._setState({
                    status: State.ERROR,
                    error: event.message || 'Unknown error',
                    lastBackendError: event.message || 'Unknown backend error',
                });
                break;
            case 'hello':
                this._send({type: 'get_settings'});
                this._send({type: 'get_capabilities'});
                this._send({type: 'get_conversation_state'});
                if (!this._state.backendConnected) {
                    this._setState({
                        status: State.IDLE,
                        backendConnected: true,
                        backendStarting: false,
                    });
                }
                break;
            case 'backend_status':
                if (event.status === 'connected')
                    this._setState({backendConnected: true});
                break;
            case 'settings':
            case 'settings_saved':
                this._setState({
                    settings: event.settings || null,
                    conversationMode: !!event.settings?.conversation?.enabled,
                });
                break;
            case 'capabilities':
                this._setState({capabilities: event});
                break;
            case 'conversation_state':
                this._setState({
                    conversationMode: !!event.enabled,
                    conversationTurnCount: event.turn_count || 0,
                });
                break;
            case 'conversation_cleared':
                this._setState({
                    userText: '',
                    transcript: '',
                    answer: '',
                    answerStreaming: false,
                    status: State.IDLE,
                    conversationTurnCount: 0,
                });
                break;
            case 'screen_capture_started':
                this._setState({
                    status: State.SCREEN_CAPTURING,
                    screenContext: {
                        ...this._state.screenContext,
                        status: 'capturing',
                        error: null,
                    },
                });
                break;
            case 'screen_capture_done':
                this._setState({
                    screenContext: {
                        ...this._state.screenContext,
                        id: event.context_id || null,
                        status: 'captured',
                    },
                });
                break;
            case 'screen_context_started':
                this._setState({
                    screenContext: {
                        ...this._state.screenContext,
                        mode: event.mode || null,
                    },
                });
                break;
            case 'screen_ocr_done':
                this._setState({
                    screenContext: {
                        ...this._state.screenContext,
                        mode: 'ocr',
                        ocrEngine: event.engine || 'tesseract',
                        ocrTextLength: event.text_length || 0,
                    },
                });
                break;
            case 'screen_context_ready':
                this._setState({
                    status: State.SCREEN_READY,
                    screenContext: {
                        ...this._state.screenContext,
                        id: event.context_id || this._state.screenContext.id,
                        mode: event.mode || this._state.screenContext.mode,
                        status: 'ready',
                        error: null,
                    },
                });
                break;
            case 'screen_context_error':
                this._setState({
                    status: State.ERROR,
                    error: event.message || 'Ask about screen is unavailable.',
                    lastBackendError: event.message || 'Screen context error',
                    screenContext: {
                        ...this._state.screenContext,
                        status: 'error',
                        error: event.message || 'Screen context error',
                    },
                });
                this._notifyError('Ask about screen', event.message || 'Screen context error');
                break;
            case 'settings_error':
                this._setState({
                    lastBackendError: event.message || 'Settings update failed',
                });
                log(`[vox2ai] settings update failed: ${event.message || 'unknown error'}`);
                break;
            case 'diagnostics':
                this._setState({diagnostics: event.diagnostics || null});
                break;
            case 'audio_input_test_started':
            case 'audio_input_test_level':
            case 'audio_input_test_stopped':
            case 'audio_input_test_error':
                break;
        }
    }

    _handleStateEvent(event) {
        const s = event.state;
        if (s !== 'ready' && s !== 'error')
            this._setState({error: null});
        switch (s) {
            case 'listening':
                this._clearSession(false);
                this._setStatus(State.LISTENING);
                break;
            case 'transcribing':
                this._setState({
                    status: State.TRANSCRIBING,
                    processingMessage: this._state.processingMessage || 'Processing speech...',
                });
                break;
            case 'thinking':
                this._setStatus(State.THINKING);
                break;
            case 'streaming_answer':
                this._setStatus(State.ANSWERING);
                break;
            case 'approval_required':
                break;
            case 'running_command':
                this._setStatus(State.COMMAND_RUNNING);
                break;
            case 'error':
                this._setState({
                    status: State.ERROR,
                    error: event.message || 'Backend error',
                    lastBackendError: event.message || 'Backend error',
                });
                break;
            case 'ready':
                if ([State.ANSWERING, State.SCREEN_ANSWERING].includes(this._state.status) &&
                    this._state.answer)
                    this._setState({answerStreaming: false});
                else if (this._state.status === State.ERROR && this._state.error)
                    this._setState({backendConnected: true, backendStarting: false});
                else if (this._state.status !== State.RESULT)
                    this._setStatus(State.IDLE);
                break;
        }
    }

    _handleAudioLevel(event) {
        if (this._state.status !== State.LISTENING)
            return;
        const level = Number.isFinite(event.level)
            ? event.level
            : Math.max(0, Math.min(1, event.rms || 0));
        const rms = Math.max(0, Math.min(1, level || 0));
        const peak = Math.max(0, Math.min(1, event.peak || 0));
        this._setState({
            audioLevel: rms,
            audioPeak: peak,
            lastAudioLevelAt: GLib.get_monotonic_time(),
            audioEventsReceived: true,
            voiceActive: !!event.speech_detected,
        });
    }

    _handleVoiceActivity(event) {
        if (this._state.status !== State.LISTENING)
            return;

        let lastVoiceActivity = 'waiting';
        if (event.active)
            lastVoiceActivity = 'active';
        else if (event.speech_started)
            lastVoiceActivity = 'silent';

        this._setState({
            voiceActive: !!event.active,
            speechStarted: !!event.speech_started,
            silenceMs: Math.max(0, event.silence_ms || 0),
            lastVoiceActivity,
        });
    }

    _resetToIdle() {
        this._resetState();
        this._setStatus(State.IDLE);
    }

    _resetState() {
        this._setState({
            inputText: '',
            userText: '',
            transcript: '',
            partialTranscript: '',
            answer: '',
            answerStreaming: false,
            audioLevel: 0,
            audioPeak: 0,
            lastAudioLevelAt: 0,
            audioEventsReceived: false,
            voiceActive: false,
            speechStarted: false,
            silenceMs: 0,
            lastVoiceActivity: 'unknown',
            processingMessage: '',
            recordingStopReason: '',
            commandApproval: null,
            commandResult: null,
            error: null,
            copyFeedback: '',
            screenContext: {
                id: null,
                mode: null,
                status: 'idle',
                error: null,
            },
        });
    }

    _clearSession(clearStatus = true) {
        const patch = {
            transcript: '',
            partialTranscript: '',
            answer: '',
            answerStreaming: false,
            audioLevel: 0,
            audioPeak: 0,
            lastAudioLevelAt: 0,
            voiceActive: false,
            speechStarted: false,
            silenceMs: 0,
            lastVoiceActivity: 'unknown',
            processingMessage: '',
            recordingStopReason: '',
            commandApproval: null,
            commandResult: null,
            error: null,
            screenContext: {
                id: null,
                mode: null,
                status: 'idle',
                error: null,
            },
        };
        if (clearStatus)
            patch.userText = '';
        this._setState(patch);
    }

    _clearCancelTimer() {
        if (this._cancelSafetyTimer) {
            GLib.source_remove(this._cancelSafetyTimer);
            this._cancelSafetyTimer = null;
        }
    }

    _readRuntimeSettings() {
        return {
            autoFinishEnabled: safeGet(this._settings, 'get_boolean', 'auto-finish-recording', true),
            silenceTimeoutMs: safeGet(this._settings, 'get_int', 'silence-timeout-ms', 2000),
            minRecordingMs: safeGet(this._settings, 'get_int', 'min-recording-ms', 700),
            maxRecordingMs: safeGet(this._settings, 'get_int', 'max-recording-ms', 60000),
            voiceActivityThreshold: safeGet(this._settings, 'get_double', 'voice-activity-threshold', 0.025),
            safeMode: safeGet(this._settings, 'get_boolean', 'safe-mode', false),
        };
    }

    _onStatusChanged(_oldStatus, newStatus) {
        if (newStatus === State.LISTENING)
            this._playSound('start');
        else if (newStatus === State.ERROR)
            this._playSound('error');
    }

    _playSound(kind) {
        if (!this._soundFeedback)
            return;
        try {
            if (kind === 'start')
                this._soundFeedback.playRecordingStarted();
            else if (kind === 'stop')
                this._soundFeedback.playRecordingStopped();
            else if (kind === 'auto-stop')
                this._soundFeedback.playAutoStopped();
            else if (kind === 'cancel')
                this._soundFeedback.playCancelled();
            else if (kind === 'copy')
                this._soundFeedback.playCopySuccess();
            else if (kind === 'answer-done')
                this._soundFeedback.playAnswerDone();
            else if (kind === 'error')
                this._soundFeedback.playError();
        } catch (e) {
            log(`[vox2ai] sound feedback error: ${e}`);
        }
    }

    _notifyInfo(title, body = '') {
        try {
            if (this._notifications)
                this._notifications.notifyInfo(title, body, null);
        } catch (e) {
            log(`[vox2ai] notification error: ${e}`);
        }
    }

    _notifyError(title, body = '') {
        try {
            if (this._notifications)
                this._notifications.notifyError(title, body);
        } catch (e) {
            log(`[vox2ai] notification error: ${e}`);
        }
    }

    destroy() {
        this._clearCancelTimer();
        if (this._copyFeedbackTimer) {
            GLib.source_remove(this._copyFeedbackTimer);
            this._copyFeedbackTimer = null;
        }
        this.disconnect();
        this._listeners.clear();
    }
};
