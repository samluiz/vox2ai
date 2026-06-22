// vox2ai GNOME extension preferences

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

const SchemaId = 'org.gnome.shell.extensions.vox2ai';

const ProviderPresets = {
    openai: {base_url: 'https://api.openai.com/v1', auth_type: 'bearer'},
    openrouter: {base_url: 'https://openrouter.ai/api/v1', auth_type: 'bearer'},
    lmstudio: {base_url: 'http://localhost:1234/v1', auth_type: 'optional'},
    ollama: {base_url: 'http://localhost:11434', auth_type: 'none'},
    custom: {base_url: '', auth_type: 'bearer_or_none'},
};

function createGroup(title) {
    const group = new Adw.PreferencesGroup({title});
    return group;
}

function createRow(title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});
    return row;
}

export default function init() {
    const settings = new Gio.Settings({schema_id: SchemaId});

    const prefs = new Adw.PreferencesPage({title: 'vox2ai'});
    prefs.add(createActivationGroup(settings));
    prefs.add(createProviderGroup(settings));
    prefs.add(createBackendGroup(settings));
    prefs.add(createAboutGroup(settings));

    return prefs;
}

function createActivationGroup(settings) {
    const group = createGroup('Activation');

    // Shortcut
    const shortcutRow = createRow('Activation shortcut', 'Press to record or summon assistant');
    const shortcutEntry = new Gtk.Entry({
        text: settings.get_strv('activation-shortcut').join(', '),
        placeholder_text: '<Control>space',
    });
    shortcutEntry.connect('notify::text', () => {
        settings.set_strv('activation-shortcut', [shortcutEntry.text]);
    });
    shortcutRow.add_suffix(shortcutEntry);
    shortcutRow.set_activatable_widget(shortcutEntry);
    group.add(shortcutRow);

    // Behavior
    const behaviorRow = createRow('Shortcut behavior', 'What happens when shortcut is pressed');
    const behaviorDrop = new Gtk.DropDown({
        model: Gtk.StringList.new([
            'Show and start recording',
            'Show widget',
            'Show and focus input',
            'Toggle widget',
        ]),
    });
    const behaviors = ['show-and-record', 'show-widget', 'show-and-focus-input', 'toggle-widget'];
    const currentBehavior = settings.get_string('shortcut-behavior');
    const idx = behaviors.indexOf(currentBehavior);
    if (idx >= 0)
        behaviorDrop.set_selected(idx);
    behaviorDrop.connect('notify::selected', () => {
        const sel = behaviorDrop.selected;
        if (sel >= 0 && sel < behaviors.length)
            settings.set_string('shortcut-behavior', behaviors[sel]);
    });
    behaviorRow.add_suffix(behaviorDrop);
    behaviorRow.set_activatable_widget(behaviorDrop);
    group.add(behaviorRow);

    // Panel indicator toggle
    const indicatorRow = createRow('Show panel indicator', 'Show vox2ai icon in the top panel');
    const indicatorSwitch = new Gtk.Switch({
        active: settings.get_boolean('show-panel-indicator'),
        valign: Gtk.Align.CENTER,
    });
    settings.bind('show-panel-indicator', indicatorSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
    indicatorRow.add_suffix(indicatorSwitch);
    indicatorRow.set_activatable_widget(indicatorSwitch);
    group.add(indicatorRow);

    // Auto-start backend
    const autoStartRow = createRow('Auto-start backend', 'Start backend service when extension loads');
    const autoStartSwitch = new Gtk.Switch({
        active: settings.get_boolean('auto-start-backend'),
        valign: Gtk.Align.CENTER,
    });
    settings.bind('auto-start-backend', autoStartSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
    autoStartRow.add_suffix(autoStartSwitch);
    autoStartRow.set_activatable_widget(autoStartSwitch);
    group.add(autoStartRow);

    return group;
}

function createProviderGroup(settings) {
    const group = createGroup('Provider');

    // Provider preset
    const presetRow = createRow('Provider preset', 'Choose your AI provider');
    const presetDrop = new Gtk.DropDown({
        model: Gtk.StringList.new(['OpenAI', 'OpenRouter', 'LM Studio', 'Ollama', 'Custom']),
    });
    const presetKeys = ['openai', 'openrouter', 'lmstudio', 'ollama', 'custom'];
    const currentPreset = settings.get_string('provider-id');
    const pIdx = presetKeys.indexOf(currentPreset);
    if (pIdx >= 0)
        presetDrop.set_selected(pIdx);
    presetDrop.connect('notify::selected', () => {
        const sel = presetDrop.selected;
        if (sel >= 0 && sel < presetKeys.length) {
            const key = presetKeys[sel];
            settings.set_string('provider-id', key);
            const preset = ProviderPresets[key];
            if (preset && preset.base_url)
                settings.set_string('base-url', preset.base_url);
        }
    });
    presetRow.add_suffix(presetDrop);
    presetRow.set_activatable_widget(presetDrop);
    group.add(presetRow);

    // Base URL
    const urlRow = createRow('Base URL', 'LLM API endpoint');
    const urlEntry = new Gtk.Entry({
        text: settings.get_string('base-url'),
        placeholder_text: 'https://api.openai.com/v1',
    });
    settings.bind('base-url', urlEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
    urlRow.add_suffix(urlEntry);
    urlRow.set_activatable_widget(urlEntry);
    group.add(urlRow);

    // Model
    const modelRow = createRow('Model', 'Model name for your provider');
    const modelEntry = new Gtk.Entry({
        text: settings.get_string('model'),
        placeholder_text: 'gpt-4.1-mini',
    });
    settings.bind('model', modelEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
    modelRow.add_suffix(modelEntry);
    modelRow.set_activatable_widget(modelEntry);
    group.add(modelRow);

    return group;
}

function createBackendGroup(settings) {
    const group = createGroup('Backend');

    const hostRow = createRow('Host', 'Backend WebSocket host');
    const hostEntry = new Gtk.Entry({
        text: settings.get_string('backend-host'),
        placeholder_text: '127.0.0.1',
    });
    settings.bind('backend-host', hostEntry, 'text', Gio.SettingsBindFlags.DEFAULT);
    hostRow.add_suffix(hostEntry);
    hostRow.set_activatable_widget(hostEntry);
    group.add(hostRow);

    const portRow = createRow('Port', 'Backend WebSocket port');
    const portSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustation({
            lower: 1024,
            upper: 65535,
            step_increment: 1,
            value: settings.get_int('backend-port'),
        }),
    });
    settings.bind('backend-port', portSpin, 'value', Gio.SettingsBindFlags.DEFAULT);
    portRow.add_suffix(portSpin);
    portRow.set_activatable_widget(portSpin);
    group.add(portRow);

    return group;
}

function createAboutGroup(settings) {
    const group = createGroup('About');

    const versionRow = createRow('vox2ai extension', 'Version 1');
    group.add(versionRow);

    const shellRow = createRow('GNOME Shell', 'GNOME');
    try {
        const Meta = imports.gi.Meta;
        shellRow.set_subtitle(Meta.get_package_name?.() || 'GNOME');
    } catch {
        shellRow.set_subtitle('GNOME');
    }
    group.add(shellRow);

    return group;
}
