import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const Notifications = class Notifications {
    constructor(settings, isPopupOpen, inlineToast) {
        this._settings = settings;
        this._isPopupOpen = isPopupOpen || (() => false);
        this._inlineToast = inlineToast || (() => {});
    }

    notifyInfo(title, body = '', key = null) {
        this._notify(title, body, key);
    }

    notifySuccess(title, body = '', key = null) {
        this._notify(title, body, key);
    }

    notifyError(title, body = '', key = 'notify-errors') {
        this._notify(title, body, key);
    }

    showInlineToast(message) {
        try {
            this._inlineToast(message);
        } catch (e) {
            log(`[vox2ai] inline notification error: ${e}`);
        }
    }

    _notify(title, body, key) {
        if (!this._enabled(key))
            return;
        try {
            if (this._isPopupOpen()) {
                this._inlineToast(body ? `${title}: ${body}` : title);
                return;
            }
            Main.notify(title, body || '');
        } catch (e) {
            log(`[vox2ai] notification error: ${e}`);
        }
    }

    _enabled(key) {
        try {
            if (!this._settings.get_boolean('notifications-enabled'))
                return false;
            if (key)
                return this._settings.get_boolean(key);
            return true;
        } catch (e) {
            return false;
        }
    }
};
