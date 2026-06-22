// Panel indicator for vox2ai

import GLib from 'gi://GLib';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const PanelIndicator = class PanelIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    _init(controller, onToggle) {
        super._init(0.0, 'vox2ai', false);

        this._controller = controller;
        this._onToggle = onToggle;

        this._dot = new St.Widget({
            style_class: 'vox2ai-status-dot vox2ai-status-dot-off',
        });
        this._label = new St.Label({
            text: 'vox2ai',
            style_class: 'vox2ai-indicator-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator = new St.BoxLayout({
            style_class: 'vox2ai-indicator',
            reactive: true,
            track_hover: true,
            can_focus: true,
        });
        this._indicator.add_child(this._dot);
        this._indicator.add_child(this._label);
        this.add_child(this._indicator);

        this._indicator.connect('button-press-event', () => {
            this._onToggle();
            return Clutter.EVENT_STOP;
        });

        const menu = this.menu;
        menu.addAction('Open Assistant', () => this._onToggle());
        menu.addAction('Start Recording', () => controller.startRecording());
        menu.addAction('Cancel', () => controller.cancel());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Open Preferences', () => this._openPrefs());
        menu.addAction('Restart Backend', () => controller.reconnect());
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Stop Backend', () => controller.disconnect());

        controller.onUpdate(() => this._sync());
        this._sync();
    }

    _sync() {
        const s = this._controller.state;
        this._dot.style_class = 'vox2ai-status-dot vox2ai-status-dot-off';
        if (s === 'listening')
            this._dot.style_class = 'vox2ai-status-dot vox2ai-status-dot-recording';
        else if (s === 'error')
            this._dot.style_class = 'vox2ai-status-dot vox2ai-status-dot-warn';
        else if (s !== 'disconnected' && s !== 'backend-starting')
            this._dot.style_class = 'vox2ai-status-dot vox2ai-status-dot-ok';
    }

    _openPrefs() {
        try {
            GLib.spawn_command_line_async('gnome-extensions prefs vox2ai@samluiz.com');
        } catch (e) {
            log(`[vox2ai] prefs error: ${e}`);
        }
    }
};
