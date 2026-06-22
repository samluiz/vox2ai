// vox2ai GNOME Shell extension - main entry point

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Controller} from './lib/controller.js';
import {PanelIndicator} from './lib/ui/panelIndicator.js';

export default class Vox2aiExtension extends Extension {
    constructor(...args) {
        super(...args);
        this._settings = null;
        this._controller = null;
        this._indicator = null;
        this._keybindingId = null;
        this._keybindingName = null;
    }

    enable() {
        try {
            this._enableSafe();
        } catch (e) {
            log(`[vox2ai] enable error: ${e}`);
        }
    }

    _enableSafe() {
        // 1. Settings
        this._settings = this.getSettings();
        if (!this._settings) {
            log('[vox2ai] no settings available');
            return;
        }

        // 2. Controller
        this._controller = new Controller(this._settings);

        // 3. Panel indicator (best-effort)
        try {
            if (this._settings.get_boolean('show-panel-indicator')) {
                this._indicator = new PanelIndicator(
                    this._controller,
                    () => this._toggleWidget(),
                );
                Main.panel.addToStatusArea('vox2ai', this._indicator, 1, 'right');
            }
        } catch (e) {
            log(`[vox2ai] indicator error: ${e}`);
        }

        // 4. Backend connection (best-effort)
        try {
            if (this._settings.get_boolean('auto-start-backend'))
                this._controller.connect();
        } catch (e) {
            log(`[vox2ai] backend connect error: ${e}`);
        }

        // 5. Keybinding
        try {
            this._registerKeybinding();
        } catch (e) {
            log(`[vox2ai] keybinding error: ${e}`);
        }
    }

    disable() {
        this._unregisterKeybinding();

        if (this._indicator) {
            try { this._indicator.destroy(); } catch (e) { log(`[vox2ai] destroy indicator error: ${e}`); }
            this._indicator = null;
        }

        if (this._controller) {
            try { this._controller.disconnect(); } catch (e) { log(`[vox2ai] controller disconnect error: ${e}`); }
            this._controller = null;
        }

        this._settings = null;
    }

    _registerKeybinding() {
        if (this._keybindingId)
            return;

        const schemaId = 'org.gnome.shell.extensions.vox2ai';
        const keyName = 'vox2ai-activate';

        // Verify the key exists by trying to access it
        try {
            const val = this._settings.get_strv(keyName);
        } catch (e) {
            log(`[vox2ai] schema key '${keyName}' not found: ${e}`);
            return;
        }

        this._keybindingName = keyName;
        this._keybindingId = Main.wm.addKeybinding(
            keyName,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._activate(),
        );

        if (!this._keybindingId) {
            log('[vox2ai] keybinding registration returned no id');
        }
    }

    _unregisterKeybinding() {
        if (this._keybindingId) {
            try {
                Main.wm.removeKeybinding(this._keybindingName);
            } catch (e) {
                log(`[vox2ai] remove keybinding error: ${e}`);
            }
            this._keybindingId = null;
            this._keybindingName = null;
        }
    }

    _toggleWidget() {
        if (!this._controller)
            return;
        if (this._indicator)
            this._indicator.menu.open();
    }

    _activate() {
        if (!this._controller)
            return;

        // Open the panel menu to show state
        if (this._indicator)
            this._indicator.menu.open();

        const behavior = this._settings.get_string('shortcut-behavior') || 'show-and-record';

        if (behavior === 'toggle-widget') {
            this._toggleWidget();
            return;
        }

        if (behavior === 'show-widget' || behavior === 'show-and-focus-input') {
            this._toggleWidget();
            return;
        }

        // show-and-record (default)
        this._controller.startRecording();
    }
}
