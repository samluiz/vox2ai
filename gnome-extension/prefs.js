import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class Vox2aiPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('vox2ai'),
            icon_name: 'applications-system-symbolic',
        });

        const generalGroup = new Adw.PreferencesGroup({
            title: _('General'),
            description: _('Basic vox2ai extension settings'),
        });

        const showIndicatorRow = new Adw.SwitchRow({
            title: _('Show panel indicator'),
            subtitle: _('Show vox2ai in the GNOME top panel'),
        });

        settings.bind(
            'show-panel-indicator',
            showIndicatorRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        generalGroup.add(showIndicatorRow);

        const activationGroup = new Adw.PreferencesGroup({
            title: _('Activation'),
            description: _('Configure how vox2ai opens'),
        });

        const shortcutBehaviorRow = new Adw.ComboRow({
            title: _('Shortcut behavior'),
            subtitle: _('What happens when the activation shortcut is pressed'),
        });

        activationGroup.add(shortcutBehaviorRow);

        const backendGroup = new Adw.PreferencesGroup({
            title: _('Backend'),
            description: _('Local backend service connection'),
        });

        const backendHostRow = new Adw.EntryRow({
            title: _('Backend host'),
        });

        settings.bind(
            'backend-host',
            backendHostRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        backendGroup.add(backendHostRow);

        page.add(generalGroup);
        page.add(activationGroup);
        page.add(backendGroup);

        window.add(page);
    }
}
