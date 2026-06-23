import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SERVICE_NAME = 'vox2ai.service';
const LOGS_COMMAND = 'journalctl --user -u vox2ai.service -f';

function getConfigPath() {
    const configHome = GLib.getenv('XDG_CONFIG_HOME');
    const baseDir = configHome && configHome.length > 0
        ? configHome
        : GLib.build_filenamev([GLib.get_home_dir(), '.config']);
    return GLib.build_filenamev([baseDir, 'vox2ai', 'config.toml']);
}

const CONFIG_PATH = getConfigPath();

function runCommand(argv) {
    return new Promise((resolve) => {
        try {
            const proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (sub, res) => {
                try {
                    const [, stdout, stderr] = sub.communicate_utf8_finish(res);
                    const exitCode = sub.get_exit_status();
                    resolve({
                        ok: exitCode === 0,
                        stdout: (stdout || '').trim(),
                        stderr: (stderr || '').trim(),
                    });
                } catch (e) {
                    resolve({ok: false, stdout: '', stderr: String(e)});
                }
            });
        } catch (e) {
            resolve({ok: false, stdout: '', stderr: String(e)});
        }
    });
}

function runSystemctl(args) {
    return runCommand(['systemctl', '--user', ...args]);
}

function getVox2aiCommand() {
    const found = GLib.find_program_in_path('vox2ai');
    if (found)
        return found;

    const unitPath = GLib.build_filenamev([
        GLib.get_home_dir(),
        '.config',
        'systemd',
        'user',
        SERVICE_NAME,
    ]);
    try {
        const [ok, bytes] = GLib.file_get_contents(unitPath);
        if (!ok)
            return null;
        const text = new TextDecoder().decode(bytes);
        const line = text.split('\n').find(l => l.startsWith('ExecStart='));
        if (!line)
            return null;
        return line.replace('ExecStart=', '').trim().split(/\s+/)[0] || null;
    } catch (e) {
        return null;
    }
}

function runVox2ai(args) {
    const command = getVox2aiCommand();
    if (!command)
        return Promise.resolve({
            ok: false,
            stdout: '',
            stderr: 'vox2ai command not found. Reinstall the backend service.',
        });
    return runCommand([command, ...args]);
}

async function getBackendStatus() {
    const active = await runSystemctl(['is-active', SERVICE_NAME]);
    if (!active.ok && active.stderr.includes('not loaded'))
        return {installed: false, active: false, status: 'not-installed'};
    if (active.stdout === 'active')
        return {installed: true, active: true, status: 'active'};
    if (active.stdout === 'failed')
        return {installed: true, active: false, status: 'failed'};
    return {installed: true, active: false, status: 'inactive'};
}

function shortcutSummary(settings) {
    const shortcuts = settings.get_strv('vox2ai-activate').join(', ');
    return GLib.markup_escape_text(shortcuts || _('Disabled in GNOME keybindings'), -1);
}

function flashButton(button, label = _('Copied')) {
    if (!button)
        return;
    const original = button.get_label();
    button.set_label(label);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        button.set_label(original);
        return GLib.SOURCE_REMOVE;
    });
}

function copyText(text, button = null) {
    const display = Gdk.Display.get_default();
    if (!display)
        return;
    const clipboard = display.get_clipboard();
    clipboard.set_text(text);
    flashButton(button);
}

function openConfigFile() {
    try {
        const file = Gio.File.new_for_path(CONFIG_PATH);
        Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
    } catch (e) {
        log(`[vox2ai] open config file error: ${e}`);
    }
}

function historyPath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'vox2ai', 'recent.json']);
}

export default class Vox2aiPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        this._settings = settings;

        const page = new Adw.PreferencesPage({
            title: _('vox2ai'),
            icon_name: 'applications-system-symbolic',
        });

        // ── Safe Mode ───────────────────────────────────────────────
        const safeGroup = new Adw.PreferencesGroup({
            title: _('Safe Mode'),
            description: _('Disable all advanced features for stability'),
        });
        const safeModeRow = new Adw.SwitchRow({
            title: _('Safe mode'),
            subtitle: _('Disables screen capture, model profiles, and extra shortcuts.'),
        });
        settings.bind('safe-mode', safeModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        safeGroup.add(safeModeRow);
        page.add(safeGroup);

        // ── Activation ──────────────────────────────────────────────
        const activationGroup = new Adw.PreferencesGroup({
            title: _('Activation'),
            description: _('How the assistant is opened'),
        });

        const askScreenShortcutEnabledRow = new Adw.SwitchRow({
            title: _('Ask about screen shortcut (Ctrl+Shift+Space)'),
            subtitle: _('Enable the ask-about-screen global shortcut. Disabled by default for stability.'),
        });
        settings.bind('ask-screen-shortcut-enabled', askScreenShortcutEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        activationGroup.add(askScreenShortcutEnabledRow);

        const activationShortcutRow = new Adw.ActionRow({
            title: _('Activation shortcut'),
            subtitle: shortcutSummary(settings),
        });
        activationGroup.add(activationShortcutRow);

        const shortcutBehaviorRow = new Adw.ComboRow({
            title: _('Shortcut behavior'),
            subtitle: _('What happens when the activation shortcut is pressed'),
        });

        const behaviorModel = new Gtk.StringList({
            strings: [
                _('Show widget'),
                _('Show widget and focus input'),
                _('Show widget and start recording'),
            ],
        });
        shortcutBehaviorRow.set_model(behaviorModel);

        const behaviors = ['show-widget', 'show-and-focus-input', 'show-and-record'];
        const syncBehaviorFromSettings = () => {
            const idx = behaviors.indexOf(settings.get_string('shortcut-behavior'));
            shortcutBehaviorRow.set_selected(idx >= 0 ? idx : 2);
        };
        settings.connect('changed::shortcut-behavior', syncBehaviorFromSettings);
        shortcutBehaviorRow.connect('notify::selected', () => {
            const idx = shortcutBehaviorRow.get_selected();
            if (idx >= 0 && idx < behaviors.length)
                settings.set_string('shortcut-behavior', behaviors[idx]);
        });
        syncBehaviorFromSettings();

        activationGroup.add(shortcutBehaviorRow);
        page.add(activationGroup);

        // ── Conversation ─────────────────────────────────────────────
        const conversationGroup = new Adw.PreferencesGroup({
            title: _('Conversation'),
            description: _('Optional follow-up context for the current session'),
        });
        const conversationModeRow = new Adw.SwitchRow({
            title: _('Conversation mode default'),
            subtitle: _('Keep recent turns in memory until the app closes.'),
        });
        settings.bind('conversation-mode', conversationModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        conversationGroup.add(conversationModeRow);
        conversationGroup.add(this._mkIntSettingRow(
            settings,
            'conversation-max-turns',
            _('Max turns'),
            _('How many turns are kept as context.'),
            1,
            20,
            1,
            value => `${value}`
        ));
        const clearConversationBtn = this._mkButton(_('Copy hint'), () => {
            copyText(_('Use New conversation in the vox2ai popup footer.'), clearConversationBtn);
        });
        const clearConversationRow = new Adw.ActionRow({
            title: _('New conversation'),
            subtitle: _('Clear backend session context.'),
        });
        clearConversationRow.add_suffix(clearConversationBtn);
        conversationGroup.add(clearConversationRow);
        page.add(conversationGroup);

        // ── Backend ───────────────────────────────────────────────────
        const backendGroup = new Adw.PreferencesGroup({
            title: _('Backend'),
            description: _('Local systemd backend service'),
        });

        const serviceNameRow = new Adw.ActionRow({
            title: _('Service name'),
            subtitle: SERVICE_NAME,
        });
        backendGroup.add(serviceNameRow);

        const endpointRow = new Adw.EntryRow({
            title: _('Backend endpoint'),
            text: `${settings.get_string('backend-host') || '127.0.0.1'}:${settings.get_int('backend-port') || 8765}`,
            editable: false,
        });
        backendGroup.add(endpointRow);

        const configFileRow = new Adw.ActionRow({
            title: _('Config file'),
            subtitle: CONFIG_PATH,
        });
        const openConfigBtn = this._mkButton(_('Open'), openConfigFile);
        const copyConfigBtn = this._mkButton(_('Copy path'), () => copyText(CONFIG_PATH, copyConfigBtn));
        configFileRow.add_suffix(openConfigBtn);
        configFileRow.add_suffix(copyConfigBtn);
        configFileRow.set_activatable_widget(openConfigBtn);
        backendGroup.add(configFileRow);

        const autoStartRow = new Adw.SwitchRow({
            title: _('Auto-start backend when needed'),
        });
        settings.bind('auto-start-backend', autoStartRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        backendGroup.add(autoStartRow);

        const statusRow = new Adw.ActionRow({
            title: _('Service status'),
            subtitle: _('Checking…'),
        });
        backendGroup.add(statusRow);

        const backendButtonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 6,
            margin_bottom: 6,
            halign: Gtk.Align.START,
        });

        const startBtn = this._mkButton(_('Start'), () => this._runSystemctl('start'));
        const restartBtn = this._mkButton(_('Restart'), () => this._runSystemctl('restart'));
        const stopBtn = this._mkButton(_('Stop'), () => this._runSystemctl('stop'));
        backendButtonBox.append(startBtn);
        backendButtonBox.append(restartBtn);
        backendButtonBox.append(stopBtn);
        backendGroup.add(backendButtonBox);

        const logsRow = new Adw.ActionRow({
            title: _('Logs'),
            subtitle: LOGS_COMMAND,
        });
        const copyLogsBtn = this._mkButton(_('Copy command'), () => {
            copyText(LOGS_COMMAND, copyLogsBtn);
        });
        logsRow.add_suffix(copyLogsBtn);
        backendGroup.add(logsRow);

        page.add(backendGroup);

        // ── Provider ──────────────────────────────────────────────────
        const providerGroup = new Adw.PreferencesGroup({
            title: _('Provider / Models'),
            description: _('AI provider and compact model profiles'),
        });

        const profileEnabledRow = new Adw.SwitchRow({
            title: _('Model profiles enabled'),
            subtitle: _('Allow switching between Fast, Smart, Local, Vision profiles.'),
        });
        settings.bind('model-profiles-enabled', profileEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        providerGroup.add(profileEnabledRow);

        const providerPlaceholder = new Adw.ActionRow({
            title: _('Provider settings are managed by the backend.'),
            subtitle: _('Connect to the backend to view and edit provider settings.'),
        });
        providerGroup.add(providerPlaceholder);

        const providerStatus = new Adw.ActionRow({
            title: _('Status'),
            subtitle: _('Not connected'),
        });
        providerGroup.add(providerStatus);

        const modelProfilesRow = new Adw.ActionRow({
            title: _('Model profiles'),
            subtitle: _('Fast, Smart, Local, and Vision are configured in config.toml.'),
        });
        const openModelsConfigBtn = this._mkButton(_('Open config'), openConfigFile);
        modelProfilesRow.add_suffix(openModelsConfigBtn);
        providerGroup.add(modelProfilesRow);

        const activeProfileRow = new Adw.ActionRow({
            title: _('Active profile'),
            subtitle: _('Shown in the popup footer.'),
        });
        providerGroup.add(activeProfileRow);

        page.add(providerGroup);

        // ── Voice ─────────────────────────────────────────────────────
        const voiceGroup = new Adw.PreferencesGroup({
            title: _('Voice'),
            description: _('Microphone and speech recognition settings'),
        });

        const inputDeviceRow = new Adw.ComboRow({
            title: _('Input device'),
            subtitle: _('Microphone used for recording'),
        });
        voiceGroup.add(inputDeviceRow);

        const voiceButtonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 6,
            margin_bottom: 6,
            halign: Gtk.Align.START,
        });
        const refreshAudioBtn = this._mkButton(_('Refresh devices'), () => {
            this._loadAudioDevices(inputDeviceRow, microphoneTestRow);
        });
        const testAudioBtn = this._mkButton(_('Test microphone'), () => {
            this._testAudioDevice(inputDeviceRow, microphoneTestRow, testAudioBtn);
        });
        voiceButtonBox.append(refreshAudioBtn);
        voiceButtonBox.append(testAudioBtn);
        voiceGroup.add(voiceButtonBox);

        const microphoneTestRow = new Adw.ActionRow({
            title: _('Microphone test'),
            subtitle: _('Choose a device, then test while speaking.'),
        });
        voiceGroup.add(microphoneTestRow);

        const autoFinishRow = new Adw.SwitchRow({
            title: _('Auto-finish recording'),
            subtitle: _('Stop and send automatically after speech ends.'),
        });
        settings.bind(
            'auto-finish-recording',
            autoFinishRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        voiceGroup.add(autoFinishRow);

        voiceGroup.add(this._mkIntSettingRow(
            settings,
            'silence-timeout-ms',
            _('Silence timeout'),
            _('How long to wait after speech ends before sending.'),
            500,
            10000,
            100,
            value => `${(value / 1000).toFixed(1)}s`
        ));
        voiceGroup.add(this._mkIntSettingRow(
            settings,
            'min-recording-ms',
            _('Minimum recording duration'),
            _('Prevents accidental tiny recordings from being submitted.'),
            100,
            10000,
            100,
            value => `${(value / 1000).toFixed(1)}s`
        ));
        voiceGroup.add(this._mkIntSettingRow(
            settings,
            'max-recording-ms',
            _('Maximum recording duration'),
            _('Stops and sends automatically after this limit.'),
            1000,
            300000,
            1000,
            value => `${(value / 1000).toFixed(0)}s`
        ));
        voiceGroup.add(this._mkDoubleSettingRow(
            settings,
            'voice-activity-threshold',
            _('Voice activity threshold'),
            _('Lower values detect quieter speech.'),
            0.0001,
            0.2,
            0.001,
            4
        ));

        const soundFeedbackRow = new Adw.SwitchRow({
            title: _('Sound feedback'),
            subtitle: _('Play short system sounds for recording, copy, and error events.'),
        });
        settings.bind(
            'sound-feedback-enabled',
            soundFeedbackRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        voiceGroup.add(soundFeedbackRow);

        page.add(voiceGroup);

        // ── Screen Context ───────────────────────────────────────────
        const screenGroup = new Adw.PreferencesGroup({
            title: _('Screen Context'),
            description: _('Explicit screenshot capture for Ask about screen'),
        });
        const screenEnabledRow = new Adw.SwitchRow({
            title: _('Enable Ask about screen'),
            subtitle: _('Screenshots are captured only when you trigger this action.'),
        });
        settings.bind('screen-context-enabled', screenEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        screenGroup.add(screenEnabledRow);
        const captureMethodRow = new Adw.EntryRow({
            title: _('Capture method'),
            text: settings.get_string('screen-capture-method'),
        });
        captureMethodRow.connect('changed', () => {
            const value = captureMethodRow.get_text().trim() || 'auto';
            settings.set_string('screen-capture-method', value);
        });
        screenGroup.add(captureMethodRow);
        const saveScreenshotsRow = new Adw.SwitchRow({
            title: _('Save screenshots for debug'),
            subtitle: _('Off by default. Screenshots are otherwise temporary.'),
        });
        settings.bind('screen-capture-save-debug', saveScreenshotsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        screenGroup.add(saveScreenshotsRow);
        const askScreenShortcutRow = new Adw.ActionRow({
            title: _('Ask about screen shortcut'),
            subtitle: settings.get_strv('ask-screen-shortcut').join(', ') || _('Disabled'),
        });
        screenGroup.add(askScreenShortcutRow);
        page.add(screenGroup);

        // ── Notifications ────────────────────────────────────────────
        const notificationsGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
            description: _('GNOME notifications when the popup is closed'),
        });
        for (const [key, title, subtitle] of [
            ['notifications-enabled', _('Enable notifications'), _('Use inline feedback when popup is open.')],
            ['notify-answer-ready', _('Notify answer ready'), _('When generation finishes in the background.')],
            ['notify-command-complete', _('Notify command complete'), _('When command execution finishes.')],
            ['notify-errors', _('Notify errors'), _('Backend and screen-context errors.')],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            notificationsGroup.add(row);
        }
        page.add(notificationsGroup);

        // ── History ──────────────────────────────────────────────────
        const historyGroup = new Adw.PreferencesGroup({
            title: _('History'),
            description: _('Small Recent list for recovering answers and commands'),
        });
        const historyEnabledRow = new Adw.SwitchRow({
            title: _('Enable recent history'),
        });
        settings.bind('history-enabled', historyEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(historyEnabledRow);
        const historyPersistRow = new Adw.SwitchRow({
            title: _('Persist recent history locally'),
            subtitle: _('Screenshots are never stored in recent history.'),
        });
        settings.bind('history-persist', historyPersistRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(historyPersistRow);
        historyGroup.add(this._mkIntSettingRow(
            settings,
            'history-max-items',
            _('Max items'),
            _('Maximum number of recent text items.'),
            1,
            50,
            1,
            value => `${value}`
        ));
        const clearHistoryRow = new Adw.ActionRow({
            title: _('Clear history'),
            subtitle: _('Removes the local persisted recent list.'),
        });
        const clearHistoryBtn = this._mkButton(_('Clear'), () => this._clearPersistedHistory());
        clearHistoryRow.add_suffix(clearHistoryBtn);
        historyGroup.add(clearHistoryRow);
        page.add(historyGroup);

        // ── Diagnostics ───────────────────────────────────────────────
        const diagnosticsGroup = new Adw.PreferencesGroup({
            title: _('Diagnostics'),
            description: _('Current system and connection status'),
        });

        const shellVersionRow = new Adw.ActionRow({
            title: _('GNOME Shell version'),
            subtitle: _('Available at runtime in GNOME Shell'),
        });
        diagnosticsGroup.add(shellVersionRow);

        const extensionVersionRow = new Adw.ActionRow({
            title: _('Extension version'),
            subtitle: this.metadata?.version?.toString() || _('Unknown'),
        });
        diagnosticsGroup.add(extensionVersionRow);

        this._diagRows = {
            serviceStatus: new Adw.ActionRow({title: _('Backend service status')}),
            connectionStatus: new Adw.ActionRow({title: _('Backend connection status')}),
            providerConfigured: new Adw.ActionRow({title: _('Provider configured')}),
            modelSelected: new Adw.ActionRow({title: _('Model selected')}),
            microphoneStatus: new Adw.ActionRow({title: _('Microphone status')}),
            autoFinish: new Adw.ActionRow({title: _('Auto-finish enabled')}),
            silenceTimeout: new Adw.ActionRow({title: _('Silence timeout')}),
            audioEvents: new Adw.ActionRow({title: _('Audio level events')}),
            soundFeedback: new Adw.ActionRow({title: _('Sound feedback')}),
            markdownRenderer: new Adw.ActionRow({title: _('Markdown renderer')}),
            screenCapture: new Adw.ActionRow({title: _('Screen capture available')}),
            visionModel: new Adw.ActionRow({title: _('Vision model available')}),
            ocrEngine: new Adw.ActionRow({title: _('OCR engine available')}),
            notifications: new Adw.ActionRow({title: _('Notifications enabled')}),
            conversationMode: new Adw.ActionRow({title: _('Conversation mode')}),
            historyPersist: new Adw.ActionRow({title: _('History persistence')}),
            lastError: new Adw.ActionRow({title: _('Last error')}),
        };
        for (const row of Object.values(this._diagRows))
            diagnosticsGroup.add(row);

        page.add(diagnosticsGroup);

        // ── About ─────────────────────────────────────────────────────
        const aboutGroup = new Adw.PreferencesGroup({title: _('About')});
        const aboutRow = new Adw.ActionRow({
            title: _('vox2ai'),
            subtitle: _('GNOME-native voice and text AI assistant'),
        });
        aboutGroup.add(aboutRow);
        page.add(aboutGroup);

        window.add(page);

        // ── Dynamic updates ───────────────────────────────────────────
        this._audioDeviceIds = [''];
        this._audioLoading = false;
        inputDeviceRow.connect('notify::selected', () => {
            if (this._audioLoading)
                return;
            const idx = inputDeviceRow.get_selected();
            const id = this._audioDeviceIds[idx] || '';
            this._saveAudioDevice(id, microphoneTestRow);
        });
        this._loadAudioDevices(inputDeviceRow, microphoneTestRow);

        this._updateBackendStatus(statusRow);
        this._updateDiagnostics();

        this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._updateBackendStatus(statusRow);
            this._updateDiagnostics();
            return GLib.SOURCE_CONTINUE;
        });

        window.connect('close-request', () => {
            if (this._tick) {
                GLib.source_remove(this._tick);
                this._tick = null;
            }
            return false;
        });
    }

    _mkButton(label, onClick) {
        const btn = new Gtk.Button({label, valign: Gtk.Align.CENTER});
        btn.connect('clicked', onClick);
        return btn;
    }

    _mkIntSettingRow(settings, key, title, subtitle, lower, upper, step, formatValue) {
        const row = new Adw.ActionRow({title, subtitle});
        const valueLabel = new Gtk.Label({
            label: formatValue(settings.get_int(key)),
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
        });
        const spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: step,
                page_increment: step * 10,
                value: settings.get_int(key),
            }),
            numeric: true,
            digits: 0,
            valign: Gtk.Align.CENTER,
        });
        spin.connect('value-changed', () => {
            const value = Math.round(spin.get_value());
            settings.set_int(key, value);
            valueLabel.set_label(formatValue(value));
        });
        settings.connect(`changed::${key}`, () => {
            const value = settings.get_int(key);
            if (Math.round(spin.get_value()) !== value)
                spin.set_value(value);
            valueLabel.set_label(formatValue(value));
        });
        row.add_suffix(valueLabel);
        row.add_suffix(spin);
        row.set_activatable_widget(spin);
        return row;
    }

    _mkDoubleSettingRow(settings, key, title, subtitle, lower, upper, step, digits) {
        const row = new Adw.ActionRow({title, subtitle});
        const spin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: step,
                page_increment: step * 10,
                value: settings.get_double(key),
            }),
            numeric: true,
            digits,
            valign: Gtk.Align.CENTER,
        });
        spin.connect('value-changed', () => {
            settings.set_double(key, spin.get_value());
        });
        settings.connect(`changed::${key}`, () => {
            const value = settings.get_double(key);
            if (Math.abs(spin.get_value() - value) > 0.00001)
                spin.set_value(value);
        });
        row.add_suffix(spin);
        row.set_activatable_widget(spin);
        return row;
    }

    _clearPersistedHistory() {
        try {
            const file = Gio.File.new_for_path(historyPath());
            file.delete(null);
        } catch (e) {
            // Missing history file is already clear.
        }
    }

    async _runSystemctl(action) {
        await runSystemctl([action, SERVICE_NAME]);
    }

    async _loadAudioDevices(inputDeviceRow, statusRow) {
        this._audioLoading = true;
        statusRow.set_subtitle(_('Loading input devices…'));

        const result = await runVox2ai(['audio-devices', '--json']);
        if (!result.ok) {
            this._audioDeviceIds = [''];
            inputDeviceRow.set_model(new Gtk.StringList({strings: [_('Automatic')]}));
            inputDeviceRow.set_selected(0);
            statusRow.set_subtitle(result.stderr || _('Could not load input devices.'));
            this._audioLoading = false;
            return;
        }

        try {
            const payload = JSON.parse(result.stdout || '{}');
            const selected = payload.selected || '';
            const labels = [_('Automatic')];
            const ids = [''];
            for (const device of payload.devices || []) {
                ids.push(String(device.id || ''));
                labels.push(String(device.label || device.name || device.id || _('Unknown device')));
            }

            if (selected && !ids.includes(selected)) {
                ids.push(selected);
                labels.push(`${selected} (${_('saved, not currently listed')})`);
            }

            this._audioDeviceIds = ids;
            inputDeviceRow.set_model(new Gtk.StringList({strings: labels}));
            const idx = Math.max(0, ids.indexOf(selected));
            inputDeviceRow.set_selected(idx);
            inputDeviceRow.set_sensitive(labels.length > 0);
            statusRow.set_subtitle(labels.length > 1
                ? _('Input devices loaded.')
                : _('No dedicated microphone was listed. Automatic may still work.'));
        } catch (e) {
            this._audioDeviceIds = [''];
            inputDeviceRow.set_model(new Gtk.StringList({strings: [_('Automatic')]}));
            inputDeviceRow.set_selected(0);
            statusRow.set_subtitle(`${_('Could not parse audio device list')}: ${e}`);
        } finally {
            this._audioLoading = false;
        }
    }

    async _saveAudioDevice(deviceId, statusRow) {
        statusRow.set_subtitle(_('Saving microphone selection…'));
        const args = ['set-audio-input'];
        if (deviceId)
            args.push('--device', deviceId);
        const result = await runVox2ai(args);
        if (!result.ok) {
            statusRow.set_subtitle(result.stderr || _('Could not save microphone selection.'));
            return;
        }

        statusRow.set_subtitle(_('Saved. Restarting backend…'));
        const restart = await runSystemctl(['restart', SERVICE_NAME]);
        if (restart.ok)
            statusRow.set_subtitle(_('Saved and backend restarted.'));
        else
            statusRow.set_subtitle(_('Saved. Restart backend before recording.'));
    }

    async _testAudioDevice(inputDeviceRow, statusRow, button) {
        const idx = inputDeviceRow.get_selected();
        const deviceId = this._audioDeviceIds[idx] || '';
        statusRow.set_subtitle(_('Testing microphone… speak now.'));
        const args = ['test-audio-input', '--json'];
        if (deviceId)
            args.push('--device', deviceId);
        const result = await runVox2ai(args);

        try {
            const payload = JSON.parse(result.stdout || '{}');
            if (payload.ok) {
                statusRow.set_subtitle(payload.message || _('Microphone test succeeded.'));
                flashButton(button, _('Works'));
            } else {
                statusRow.set_subtitle(payload.message || _('Microphone test failed.'));
            }
        } catch (e) {
            statusRow.set_subtitle(result.stderr || result.stdout || _('Microphone test failed.'));
        }
    }

    async _updateBackendStatus(statusRow) {
        const status = await getBackendStatus();
        let label;
        if (status.status === 'not-installed')
            label = _('Not installed — run scripts/install_backend_service.sh');
        else if (status.status === 'active')
            label = _('Active');
        else if (status.status === 'failed')
            label = _('Failed');
        else
            label = _('Inactive');
        statusRow.set_subtitle(label);
    }

    async _updateDiagnostics() {
        const status = await getBackendStatus();
        const settings = this._settings;
        this._diagRows.serviceStatus.set_subtitle(status.status === 'not-installed' ? _('Not installed') : status.status);
        this._diagRows.connectionStatus.set_subtitle(status.active ? _('Connected (assumed)') : _('Disconnected'));
        this._diagRows.providerConfigured.set_subtitle(_('Unknown'));
        this._diagRows.modelSelected.set_subtitle(_('Unknown'));
        this._diagRows.microphoneStatus.set_subtitle(_('Unknown'));
        this._diagRows.autoFinish.set_subtitle(settings.get_boolean('auto-finish-recording') ? _('Yes') : _('No'));
        this._diagRows.silenceTimeout.set_subtitle(`${settings.get_int('silence-timeout-ms')}ms`);
        this._diagRows.audioEvents.set_subtitle(_('Available while recording'));
        this._diagRows.soundFeedback.set_subtitle(settings.get_boolean('sound-feedback-enabled') ? _('Enabled') : _('Disabled'));
        this._diagRows.markdownRenderer.set_subtitle(_('Enabled'));
        this._diagRows.screenCapture.set_subtitle(GLib.find_program_in_path('gnome-screenshot') ? _('Yes') : _('No'));
        this._diagRows.visionModel.set_subtitle(_('Configured by model profile'));
        this._diagRows.ocrEngine.set_subtitle(GLib.find_program_in_path('tesseract') ? _('tesseract') : _('Unavailable'));
        this._diagRows.notifications.set_subtitle(settings.get_boolean('notifications-enabled') ? _('Enabled') : _('Disabled'));
        this._diagRows.conversationMode.set_subtitle(settings.get_boolean('conversation-mode') ? _('Conversation') : _('Single Answer'));
        this._diagRows.historyPersist.set_subtitle(settings.get_boolean('history-persist') ? _('Enabled') : _('Session only'));
        this._diagRows.lastError.set_subtitle(_('None'));
    }
}
