// Panel indicator for vox2ai — opens assistant popover on click

import GLib from 'gi://GLib';
import St from 'gi://St';
import GObject from 'gi://GObject';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {AssistantWidget} from './assistantWidget.js';
import {State} from '../state.js';

export const PanelIndicator = class PanelIndicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    _init(controller, onOpenPrefs, shortcutBehavior) {
        super._init(0.0, 'vox2ai', false);

        this._controller = controller;
        this._shortcutBehavior = shortcutBehavior || 'show-and-record';

        this._dot = new St.Icon({
            icon_name: 'media-record-symbolic',
            style_class: 'system-status-icon vox2ai-panel-icon vox2ai-panel-icon-idle',
            icon_size: 16,
        });
        this.add_child(this._dot);

        try {
            this._assistantItem = new AssistantWidget(
                controller,
                () => this._openPrefs(),
                () => this.menu.close(),
            );
            this.menu.addMenuItem(this._assistantItem);
        } catch (e) {
            log(`[vox2ai] assistant widget error: ${e}`);
            this._assistantItem = null;
        }

        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._onMenuOpened();
        });

        this._onControllerUpdate = (state) => this._syncDot(state);
        controller.onUpdate(this._onControllerUpdate);
        this._syncDot(controller.state);
    }

    _onMenuOpened() {
        if (this._skipNextFocus) {
            this._skipNextFocus = false;
            return;
        }
        const state = this._controller.state.status;
        if (state === State.IDLE)
            this._assistantItem.focusInput();
    }

    skipNextFocus() {
        this._skipNextFocus = true;
    }

    setShortcutBehavior(behavior) {
        this._shortcutBehavior = behavior;
    }

    _syncDot(state) {
        const s = state.status;
        this._dot.set_icon_size(16);
        this._dot.style_class = 'system-status-icon vox2ai-panel-icon vox2ai-panel-icon-idle';
        if (s === State.LISTENING)
            this._dot.style_class = 'system-status-icon vox2ai-panel-icon vox2ai-panel-icon-recording';
        else if (s === State.ERROR || s === State.DISCONNECTED)
            this._dot.style_class = 'system-status-icon vox2ai-panel-icon vox2ai-panel-icon-error';
        else if (s === State.BACKEND_STARTING)
            this._dot.style_class = 'system-status-icon vox2ai-panel-icon vox2ai-panel-icon-pending';
    }

    _openPrefs() {
        try {
            GLib.spawn_command_line_async('gnome-extensions prefs vox2ai@samluiz.com');
        } catch (e) {
            log(`[vox2ai] prefs error: ${e}`);
        }
    }

    destroy() {
        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }
        if (this._assistantItem) {
            this._assistantItem.destroy();
            this._assistantItem = null;
        }
        if (this._controller && this._onControllerUpdate) {
            this._controller.offUpdate(this._onControllerUpdate);
            this._onControllerUpdate = null;
        }
        super.destroy();
    }
};
