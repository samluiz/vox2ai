// Panel indicator for vox2ai — opens assistant popover on click

import GLib from 'gi://GLib';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AssistantWidget} from './assistantWidget.js';

export const PanelIndicator = class PanelIndicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    _init(controller) {
        super._init(0.0, 'vox2ai', false);

        this._controller = controller;

        this._dot = new St.Widget({style_class: 'vox2ai-dot'});
        this.add_child(this._dot);

        // Open assistant on click
        this.connect('button-press-event', () => {
            this._openAssistant();
            return Clutter.EVENT_STOP;
        });

        // Build the menu content once
        this._assistantItem = new AssistantWidget(controller);
        this.menu.addMenuItem(this._assistantItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Preferences', () => this._openPrefs());
        this.menu.addAction('Restart Backend', () => controller.reconnect());
        this.menu.addAction('Stop Backend', () => controller.disconnect());

        controller.onUpdate(() => this._syncDot());
        this._syncDot();
    }

    _openAssistant() {
        // Open the menu to show the assistant widget
        this.menu.open();
    }

    _syncDot() {
        const s = this._controller.state;
        this._dot.style_class = 'vox2ai-dot vox2ai-dot-off';
        if (s === 'listening')
            this._dot.style_class = 'vox2ai-dot vox2ai-dot-recording';
        else if (s === 'error')
            this._dot.style_class = 'vox2ai-dot vox2ai-dot-warn';
        else if (s === 'backend-starting')
            this._dot.style_class = 'vox2ai-dot vox2ai-dot-off';
        else if (s !== 'disconnected')
            this._dot.style_class = 'vox2ai-dot vox2ai-dot-on';
    }

    _openPrefs() {
        try {
            GLib.spawn_command_line_async('gnome-extensions prefs vox2ai@samluiz.com');
        } catch (e) {
            log(`[vox2ai] prefs error: ${e}`);
        }
    }
};
