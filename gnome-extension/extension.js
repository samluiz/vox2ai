import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Controller} from './lib/controller.js';
import {Notifications} from './lib/notifications.js';
import {SoundFeedback} from './lib/soundFeedback.js';
import {PanelIndicator} from './lib/ui/panelIndicator.js';
import {State} from './lib/state.js';

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

function connectSetting(settings, key, callback) {
    try {
        if (!settings) return null;
        if (!settings.settings_schema) return null;
        if (!settings.settings_schema.has_key(key)) return null;
        return settings.connect(`changed::${key}`, callback);
    } catch (e) {
        return null;
    }
}

export default class Vox2aiExtension extends Extension {
    constructor(...args) {
        super(...args);
        this._settings = null;
        this._controller = null;
        this._soundFeedback = null;
        this._notifications = null;
        this._indicator = null;
        this._registeredKeybindings = new Set();
        this._settingSignalIds = [];
    }

    enable() {
        try {
            this._enableSafe();
        } catch (e) {
            log(`[vox2ai] enable error: ${e}\n${e.stack || ''}`);
        }
    }

    _enableSafe() {
        this._settings = this.getSettings();
        if (!this._settings) {
            log('[vox2ai] no settings available');
            return;
        }

        const safeMode = safeGet(this._settings, 'get_boolean', 'safe-mode', false);
        if (safeMode)
            log('[vox2ai] SAFE MODE enabled — advanced features disabled');

        this._soundFeedback = new SoundFeedback(this._settings);
        this._notifications = new Notifications(
            this._settings,
            () => !!(this._indicator && this._indicator.menu.isOpen),
            (message) => {
                if (this._controller)
                    this._controller.showToast(message);
            },
        );
        this._controller = new Controller(this._settings, this._soundFeedback, this._notifications);

        // Panel indicator
        try {
            if (safeGet(this._settings, 'get_boolean', 'show-panel-indicator', true)) {
                this._indicator = new PanelIndicator(
                    this._controller,
                    () => this._openPrefs(),
                    safeGet(this._settings, 'get_string', 'shortcut-behavior', 'show-and-record'),
                );
                Main.panel.addToStatusArea('vox2ai', this._indicator, 1, 'right');
            }
        } catch (e) {
            log(`[vox2ai] indicator error: ${e}`);
        }

        // Backend connection
        try {
            if (safeGet(this._settings, 'get_boolean', 'auto-start-backend', true))
                this._controller.startBackend();
            else
                this._controller.connect();
        } catch (e) {
            log(`[vox2ai] backend connect error: ${e}`);
        }

        // Keybinding — only vox2ai-activate
        try {
            this._registerKeybinding('vox2ai-activate', () => this._activate());
        } catch (e) {
            log(`[vox2ai] keybinding error: ${e}`);
        }

        // Settings listeners — guarded by schema key check
        const shortcutId = connectSetting(this._settings, 'shortcut-behavior', () => {
            if (this._indicator)
                this._indicator.setShortcutBehavior(
                    safeGet(this._settings, 'get_string', 'shortcut-behavior', 'show-and-record')
                );
        });
        if (shortcutId !== null)
            this._settingSignalIds.push(shortcutId);

        for (const key of [
            'auto-finish-recording',
            'silence-timeout-ms',
            'min-recording-ms',
            'max-recording-ms',
            'voice-activity-threshold',
        ]) {
            const id = connectSetting(this._settings, key, () => {
                if (this._controller)
                    this._controller.syncRuntimeSettings();
            });
            if (id !== null)
                this._settingSignalIds.push(id);
        }
    }

    disable() {
        this._unregisterKeybindings();

        if (this._settings && this._settingSignalIds.length > 0) {
            for (const id of this._settingSignalIds) {
                try {
                    this._settings.disconnect(id);
                } catch (e) {
                    log(`[vox2ai] settings disconnect error: ${e}`);
                }
            }
            this._settingSignalIds = [];
        }

        if (this._controller) {
            try { this._controller.destroy(); } catch (e) { log(`[vox2ai] controller destroy error: ${e}`); }
            this._controller = null;
        }

        if (this._indicator) {
            try { this._indicator.destroy(); } catch (e) { log(`[vox2ai] destroy indicator error: ${e}`); }
            this._indicator = null;
        }

        this._settings = null;
        this._soundFeedback = null;
        this._notifications = null;
    }

    _registerKeybinding(name, handler) {
        if (this._registeredKeybindings.has(name))
            return;

        try {
            if (!this._settings) {
                log(`[vox2ai] keybinding skipped: ${name} — settings unavailable`);
                return;
            }

            const schema = this._settings.settings_schema;
            if (!schema || !schema.has_key(name)) {
                log(`[vox2ai] keybinding skipped: ${name} — missing schema key`);
                return;
            }

            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                handler,
            );

            this._registeredKeybindings.add(name);
            log(`[vox2ai] keybinding registered: ${name}`);
        } catch (error) {
            logError(error, `[vox2ai] failed to register keybinding ${name}`);
        }
    }

    _unregisterKeybindings() {
        for (const name of this._registeredKeybindings) {
            try {
                Main.wm.removeKeybinding(name);
            } catch (error) {
                logError(error, `[vox2ai] failed to remove keybinding ${name}`);
            }
        }
        this._registeredKeybindings.clear();
    }

    _openPrefs() {
        try {
            GLib.spawn_command_line_async('gnome-extensions prefs vox2ai@samluiz.com');
        } catch (e) {
            log(`[vox2ai] prefs error: ${e}`);
        }
    }

    _openPopup() {
        if (this._indicator)
            this._indicator.menu.open();
    }

    _closePopup() {
        if (this._indicator)
            this._indicator.menu.close();
    }

    _activate() {
        if (!this._controller)
            return;

        const behavior = safeGet(this._settings, 'get_string', 'shortcut-behavior', 'show-and-record');
        const state = this._controller.state.status;

        if (behavior === 'toggle-widget') {
            if (this._indicator && this._indicator.menu.isOpen)
                this._closePopup();
            else
                this._openPopup();
            return;
        }

        if (behavior === 'show-widget' || behavior === 'show-and-focus-input') {
            this._openPopup();
            return;
        }

        const completedResponse =
            (state === State.ANSWERING && !this._controller.state.answerStreaming) ||
            state === State.RESULT;

        if (state === State.LISTENING) {
            this._controller.stopRecording();
        } else if (
            completedResponse ||
            [State.IDLE, State.DISCONNECTED, State.ERROR, State.BACKEND_STARTING].includes(state)
        ) {
            if (completedResponse)
                this._controller.doneResult();
            if (this._indicator)
                this._indicator.skipNextFocus();
            this._openPopup();
            this._controller.startRecording();
        } else {
            this._openPopup();
        }
    }
}
