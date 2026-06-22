// vox2ai GNOME Shell extension - main entry point

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Controller} from './lib/controller.js';
import {PanelIndicator} from './lib/ui/panelIndicator.js';
import {AssistantWidget} from './lib/ui/assistantWidget.js';

const SchemaId = 'org.gnome.shell.extensions.vox2ai';

let _indicator = null;
let _controller = null;
let _settings = null;
let _shortcutHandler = null;

export default class Vox2aiExtension {
    constructor(metadata) {
        this._metadata = metadata;
    }

    enable() {
        _settings = new Gio.Settings({schema_id: SchemaId});

        _controller = new Controller(_settings);

        // Panel indicator
        if (_settings.get_boolean('show-panel-indicator')) {
            _indicator = new PanelIndicator(
                _controller,
                () => this._toggleWidget(),
                () => this._openPreferences(),
                () => this._openDiagnostics(),
            );
            Main.panel.addToStatusArea('vox2ai', _indicator, 1, 'right');
        }

        // Connect to backend
        if (_settings.get_boolean('auto-start-backend'))
            _controller.connect();

        // Register global shortcut
        this._registerShortcut();
    }

    disable() {
        this._unregisterShortcut();

        if (_indicator) {
            _indicator.destroy();
            _indicator = null;
        }
        if (_controller) {
            _controller.disconnect();
            _controller = null;
        }
        _settings = null;
    }

    _toggleWidget() {
        if (!_controller)
            return;

        // Close existing widget if open
        const existing = global.ui?.panelManager?.getMenu?.();
        if (existing) {
            existing.close();
            return;
        }

        // Open assistant popup from indicator
        if (_indicator) {
            _indicator.menu.close(); // close secondary menu
        }

        // Show a simple notification-based UI for now
        // (GNOME Shell popover menus from panel buttons require more complex integration)
        const s = _controller.state;
        if (s === 'disconnected' || s === 'backend-starting') {
            if (_settings.get_boolean('auto-start-backend'))
                _controller.connect();
            else
                _controller.connect();
        }
    }

    _registerShortcut() {
        if (_shortcutHandler)
            return;

        const shortcuts = _settings.get_strv('activation-shortcut');
        if (!shortcuts || shortcuts.length === 0)
            return;

        // Use GNOME Shell's built-in keybinding handler
        try {
            _shortcutHandler = global.display?.accelerator_activate?.();

            // Alternative: use grab accelerator approach
            this._actionName = 'vox2ai-activate';
            this._action = global.display?.add_keybinding?.(
                this._actionName,
                _settings,
                Gio.SettingsBindFlags.DEFAULT,
                () => this._activate(),
            );
        } catch (e) {
            log(`[vox2ai] shortcut registration failed: ${e}`);
        }
    }

    _unregisterShortcut() {
        if (this._action) {
            this._action.destroy();
            this._action = null;
        }
        _shortcutHandler = null;
    }

    _activate() {
        if (!_controller)
            return;

        const behavior = _settings.get_string('shortcut-behavior') || 'show-and-record';

        if (behavior === 'toggle-widget') {
            this._toggleWidget();
            return;
        }

        if (behavior === 'show-widget') {
            this._toggleWidget();
            return;
        }

        if (behavior === 'show-and-focus-input') {
            this._toggleWidget();
            return;
        }

        // show-and-record (default)
        _controller.startRecording();
        // Show the widget state through the indicator
    }

    _openPreferences() {
        try {
            const AppSystem = (await import('resource:///org/gnome/shell/extensions/extension.js')).default;
            const ext = AppSystem.lookup('vox2ai@samluiz.com');
            if (ext)
                ext.openPreferences();
        } catch (e) {
            GLib.spawn_command_line_async(
                'gnome-extensions prefs vox2ai@samluiz.com'
            );
        }
    }

    _openDiagnostics() {
        // Show diagnostics in the widget or open prefs to diagnostics section
    }
}
