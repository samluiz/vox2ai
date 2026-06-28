import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";
import Soup from "gi://Soup";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const SERVICE_NAME = "vox2ai.service";
const LOGS_COMMAND = "journalctl --user -u vox2ai.service -f";

function getConfigPath() {
  const configHome = GLib.getenv("XDG_CONFIG_HOME");
  const baseDir =
    configHome && configHome.length > 0
      ? configHome
      : GLib.build_filenamev([GLib.get_home_dir(), ".config"]);
  return GLib.build_filenamev([baseDir, "vox2ai", "config.toml"]);
}

const CONFIG_PATH = getConfigPath();

function runCommand(argv) {
  return new Promise((resolve) => {
    try {
      const proc = new Gio.Subprocess({
        argv,
        flags:
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      });
      proc.init(null);
      proc.communicate_utf8_async(null, null, (sub, res) => {
        try {
          const [, stdout, stderr] = sub.communicate_utf8_finish(res);
          resolve({
            ok: sub.get_exit_status() === 0,
            stdout: (stdout || "").trim(),
            stderr: (stderr || "").trim(),
          });
        } catch (e) {
          resolve({ ok: false, stdout: "", stderr: String(e) });
        }
      });
    } catch (e) {
      resolve({ ok: false, stdout: "", stderr: String(e) });
    }
  });
}

function runSystemctl(args) {
  return runCommand(["systemctl", "--user", ...args]);
}

function getVox2aiCommand() {
  const found = GLib.find_program_in_path("vox2ai");
  if (found) return found;
  return null;
}

function runVox2ai(args) {
  const command = getVox2aiCommand();
  if (!command) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "vox2ai command not found. Reinstall the backend service.",
    });
  }
  return runCommand([command, ...args]);
}

function copyText(text, button = null) {
  const display = Gdk.Display.get_default();
  if (!display) return;
  display.get_clipboard().set_text(text);
  if (!button) return;
  const original = button.get_label();
  button.set_label(_("Copied"));
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
    button.set_label(original);
    return false;
  });
}

function openConfigFile() {
  try {
    const file = Gio.File.new_for_path(CONFIG_PATH);
    Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
  } catch (e) {
    log(`[vox2ai] open config file error: ${e}`);
  }
}

function boolText(value) {
  return value ? _("Available") : _("Unavailable");
}

const MIN_THRESHOLD = 0.00001; // most sensitive
const DEFAULT_THRESHOLD = 0.025;
const MAX_THRESHOLD = 0.12; // least sensitive

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function thresholdToSensitivity(threshold) {
  const t = clamp(threshold, MIN_THRESHOLD, MAX_THRESHOLD);
  if (t <= DEFAULT_THRESHOLD)
    return Math.round(
      ((DEFAULT_THRESHOLD - t) / (DEFAULT_THRESHOLD - MIN_THRESHOLD)) * 100,
    );
  return -Math.round(
    ((t - DEFAULT_THRESHOLD) / (MAX_THRESHOLD - DEFAULT_THRESHOLD)) * 100,
  );
}

function sensitivityToThreshold(sensitivity) {
  const s = clamp(sensitivity, -100, 100);
  if (s >= 0)
    return DEFAULT_THRESHOLD - (s / 100) * (DEFAULT_THRESHOLD - MIN_THRESHOLD);
  return DEFAULT_THRESHOLD + (-s / 100) * (MAX_THRESHOLD - DEFAULT_THRESHOLD);
}

function screenCaptureMethod(settings) {
  const value = settings.get_string("screen-capture-method") || "auto";
  if (["auto", "gnome-screenshot", "portal"].includes(value)) return value;
  try {
    settings.set_string("screen-capture-method", "auto");
  } catch (e) {
    // Keep Preferences usable even if settings are temporarily inconsistent.
  }
  return "auto";
}

function decodeWebSocketText(data) {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (data && typeof data.get_data === "function")
    return new TextDecoder().decode(data.get_data());
  return String(data ?? "");
}

class PrefsBackendConnection {
  constructor(settings, onEvent, onState) {
    this._settings = settings;
    this._onEvent = onEvent;
    this._onState = onState;
    this._session = null;
    this._ws = null;
  }

  connect() {
    const host = this._settings.get_string("backend-host") || "127.0.0.1";
    const port = this._settings.get_int("backend-port") || 8765;
    try {
      this._session = new Soup.Session();
      const uri = GLib.uri_parse(`ws://${host}:${port}`, GLib.UriFlags.NONE);
      const msg = new Soup.Message({ method: "GET", uri });
      this._onState("connecting");
      this._session.websocket_connect_async(
        msg,
        null,
        null,
        GLib.PRIORITY_DEFAULT,
        null,
        (source, result) => {
          try {
            this._ws = this._session.websocket_connect_finish(result);
            this._onState("connected");
            this._ws.connect("message", (_ws, type, data) => {
              try {
                if (type !== Soup.WebsocketDataType.TEXT) return;
                const text = decodeWebSocketText(data).trim();
                if (!text.startsWith("{")) return;
                this._onEvent(JSON.parse(text));
              } catch (e) {
                log(`[vox2ai] prefs websocket parse error: ${e}`);
              }
            });
            this._ws.connect("closed", () => this._onState("disconnected"));
            this.send({ type: "get_settings" });
            this.send({ type: "get_capabilities" });
            this.send({ type: "get_conversation_state" });
          } catch (e) {
            this._onState("disconnected");
          }
        },
      );
    } catch (e) {
      this._onState("disconnected");
    }
  }

  send(data) {
    if (!this._ws) return false;
    try {
      this._ws.send_text(JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  }

  disconnect() {
    if (this._ws) {
      try {
        this._ws.close(1000, "");
      } catch (e) {}
      this._ws = null;
    }
    this._session = null;
  }
}

export default class Vox2aiPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    this._settings = settings;
    this._capabilities = null;
    this._backendSettings = null;
    this._audioTestRunning = false;

    const page = new Adw.PreferencesPage({
      title: _("vox2ai"),
      icon_name: "audio-input-microphone-symbolic",
    });

    this._buildGeneral(page, settings);
    this._buildVoice(page, settings);
    this._buildVoiceActivation(page, settings);
    this._buildScreen(page, settings);
    this._buildAI(page);
    this._buildDiagnostics(page);
    this._buildAdvanced(page, settings);

    window.add(page);

    this._connection = new PrefsBackendConnection(
      settings,
      (event) => this._handleBackendEvent(event),
      (state) => this._setConnectionState(state),
    );
    this._connection.connect();
    this._loadAudioDevices();
    this._refreshServiceStatus();

    this._tick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
      this._refreshServiceStatus();
      if (this._connection) this._connection.send({ type: "get_capabilities" });
      return GLib.SOURCE_CONTINUE;
    });

    window.connect("close-request", () => {
      this._stopAudioTest();
      if (this._connection) {
        this._connection.disconnect();
        this._connection = null;
      }
      if (this._tick) {
        GLib.source_remove(this._tick);
        this._tick = null;
      }
      return false;
    });
  }

  _buildGeneral(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: _("General"),
      description: _("Only the controls that affect the GNOME assistant."),
    });

    const autoStart = new Adw.SwitchRow({
      title: _("Start backend automatically"),
    });
    settings.bind(
      "auto-start-backend",
      autoStart,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    group.add(autoStart);

    const behavior = new Adw.ComboRow({ title: _("Shortcut behavior") });
    const labels = [_("Show widget"), _("Focus input"), _("Start recording")];
    const values = ["show-widget", "show-and-focus-input", "show-and-record"];
    behavior.set_model(new Gtk.StringList({ strings: labels }));
    behavior.set_selected(
      Math.max(0, values.indexOf(settings.get_string("shortcut-behavior"))),
    );
    behavior.connect("notify::selected", () => {
      const idx = behavior.get_selected();
      if (idx >= 0 && idx < values.length)
        settings.set_string("shortcut-behavior", values[idx]);
    });
    group.add(behavior);

    const conversation = new Adw.SwitchRow({
      title: _("Conversation mode"),
      subtitle: _(
        "Keep recent turns in backend memory for follow-up questions.",
      ),
    });
    settings.bind(
      "conversation-mode",
      conversation,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    conversation.connect("notify::active", () => {
      this._sendConversationSettings();
    });
    group.add(conversation);

    const notifications = new Adw.SwitchRow({ title: _("Notifications") });
    settings.bind(
      "notifications-enabled",
      notifications,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    group.add(notifications);
    page.add(group);
  }

  _buildVoice(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: _("Voice"),
      description: _("Microphone input, auto-stop, and live calibration."),
    });

    this._inputDeviceRow = new Adw.ComboRow({ title: _("Input device") });
    group.add(this._inputDeviceRow);

    const buttons = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
      margin_top: 6,
      margin_bottom: 6,
      halign: Gtk.Align.START,
    });
    const refresh = this._mkButton(_("Refresh devices"), () =>
      this._loadAudioDevices(),
    );
    this._micTestButton = this._mkButton(_("Test microphone"), () =>
      this._toggleAudioTest(),
    );
    buttons.append(refresh);
    buttons.append(this._micTestButton);
    group.add(buttons);

    this._meterRow = new Adw.ActionRow({
      title: _("Live microphone test"),
      subtitle: _("Click Test microphone and speak."),
    });
    this._levelBar = new Gtk.LevelBar({
      min_value: 0,
      max_value: 1,
      value: 0,
      width_request: 140,
      valign: Gtk.Align.CENTER,
    });
    this._meterRow.add_suffix(this._levelBar);
    group.add(this._meterRow);

    this._speechRow = new Adw.ActionRow({
      title: _("Speech detected"),
      subtitle: _("No"),
    });
    group.add(this._speechRow);
    this._rmsRow = new Adw.ActionRow({
      title: _("Current RMS"),
      subtitle: "0.0000",
    });
    group.add(this._rmsRow);
    this._thresholdRow = new Adw.ActionRow({
      title: _("Current threshold"),
      subtitle: settings.get_double("voice-activity-threshold").toFixed(4),
    });
    group.add(this._thresholdRow);

    const autoStop = new Adw.SwitchRow({ title: _("Auto-stop after silence") });
    settings.bind(
      "auto-finish-recording",
      autoStop,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    autoStop.connect("notify::active", () => this._sendVoiceSettings());
    group.add(autoStop);

    group.add(
      this._mkIntSettingRow(
        settings,
        "silence-timeout-ms",
        _("Silence duration"),
        500,
        10000,
        100,
        (value) => `${(value / 1000).toFixed(1)}s`,
      ),
    );
    group.add(this._mkSensitivityRow(settings));
    group.add(
      this._mkIntSettingRow(
        settings,
        "min-recording-ms",
        _("Minimum recording duration"),
        100,
        10000,
        100,
        (value) => `${(value / 1000).toFixed(1)}s`,
      ),
    );
    group.add(
      this._mkIntSettingRow(
        settings,
        "max-recording-ms",
        _("Maximum recording duration"),
        1000,
        300000,
        1000,
        (value) => `${(value / 1000).toFixed(0)}s`,
      ),
    );
    group.add(this._mkLanguageModeRow(settings));
    this._primaryLanguageRow = new Adw.EntryRow({
      title: _("Primary language"),
      text: this._backendSettings?.voice?.primary_language || "en",
    });
    this._primaryLanguageRow.connect("changed", () =>
      this._sendVoiceSettings(),
    );
    group.add(this._primaryLanguageRow);
    this._whisperModelRow = new Adw.EntryRow({
      title: _("Whisper model"),
      text: this._backendSettings?.voice?.whisper_model || "small",
    });
    this._whisperModelRow.connect("changed", () => this._sendVoiceSettings());
    group.add(this._whisperModelRow);
    page.add(group);
  }

  _buildVoiceActivation(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: _("Voice Activation"),
      description: _("Wake word detection. Say the wake phrase to activate hands-free."),
    });

    const enabled = new Adw.SwitchRow({
      title: _("Enable voice activation"),
      subtitle: _("Passive wake word detection runs while idle. Low CPU usage."),
    });
    settings.bind("wake-word-enabled", enabled, "active", Gio.SettingsBindFlags.DEFAULT);
    enabled.connect("notify::active", () => this._sendWakeSettings());
    group.add(enabled);

    const sensitivityRow = new Adw.ActionRow({
      title: _("Sensitivity"),
      subtitle: _("Higher = more sensitive, may trigger on similar words."),
    });
    const scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0.1, 0.99, 0.05);
    scale.set_digits(2);
    scale.set_draw_value(true);
    scale.set_value(settings.get_double("wake-word-threshold"));
    scale.set_property("width-request", 200);
    scale.connect("value-changed", () => {
      settings.set_double("wake-word-threshold", scale.get_value());
      this._sendWakeSettings();
    });
    sensitivityRow.add_suffix(scale);
    sensitivityRow.set_activatable_widget(scale);
    group.add(sensitivityRow);

    const wakeStatus = new Adw.ActionRow({
      title: _("Wake engine"),
      subtitle: _("Will start when backend connects"),
    });
    group.add(wakeStatus);
    this._wakeStatusRow = wakeStatus;

    // Test wake phrase
    const testRow = new Adw.ActionRow({
      title: _("Test wake phrase"),
      subtitle: _("Say the wake phrase to verify detection."),
    });
    this._wakeTestButton = this._mkButton(_("Start test"), () => this._toggleWakeTest());
    testRow.add_suffix(this._wakeTestButton);
    group.add(testRow);
    this._wakeTestRow = testRow;
    this._wakeTestRunning = false;

    page.add(group);

    // Experimental section
    const expGroup = new Adw.PreferencesGroup({
      title: _("Experimental"),
      description: _("Optional features that may change or be removed."),
    });
    const shortcutEnabled = new Adw.SwitchRow({
      title: _("Keyboard shortcut"),
      subtitle: _("Ctrl+Space to activate. Disabled — use voice activation instead."),
    });
    settings.bind("keyboard-shortcut-enabled", shortcutEnabled, "active", Gio.SettingsBindFlags.DEFAULT);
    expGroup.add(shortcutEnabled);
    page.add(expGroup);
  }

  _sendWakeSettings() {
    this._connection?.send({
      type: "update_settings",
      settings: {
        wake_word: {
          enabled: this._settings.get_boolean("wake-word-enabled"),
          model: "hey_jarvis",
          threshold: this._settings.get_double("wake-word-threshold"),
        },
      },
    });
    // Also start/stop wake engine directly
    if (this._settings.get_boolean("wake-word-enabled"))
      this._connection?.send({ type: "start_wake_word" });
    else
      this._connection?.send({ type: "stop_wake_word" });
  }

  _toggleWakeTest() {
    if (this._wakeTestRunning) this._stopWakeTest();
    else this._startWakeTest();
  }

  _startWakeTest() {
    this._wakeTestRunning = true;
    this._wakeTestButton?.set_label(_("Stop test"));
    this._wakeTestRow?.set_subtitle(_("Listening for \"Hey Jarvis\"..."));
    this._sendWakeSettings();
    this._connection?.send({ type: "start_wake_word" });
  }

  _stopWakeTest() {
    this._wakeTestRunning = false;
    this._wakeTestButton?.set_label(_("Start test"));
    this._wakeTestRow?.set_subtitle(_("Test stopped."));
    this._connection?.send({ type: "stop_wake_word" });
  }

  _buildScreen(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: _("Screen"),
      description: _("Explicit screenshot capture for Ask about screen."),
    });
    const enabled = new Adw.SwitchRow({
      title: _("Ask about screen"),
      subtitle: _(
        "Shown only when backend capture plus vision or OCR is available.",
      ),
    });
    settings.bind(
      "screen-context-enabled",
      enabled,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    enabled.connect("notify::active", () => this._sendScreenSettings());
    group.add(enabled);
    group.add(
      new Adw.ActionRow({ title: _("Capture method"), subtitle: _("Auto") }),
    );
    this._screenVisionRow = new Adw.ActionRow({
      title: _("Vision"),
      subtitle: _("Checking…"),
    });
    this._screenOcrRow = new Adw.ActionRow({
      title: _("OCR"),
      subtitle: _("Checking…"),
    });
    this._screenOcrEngineRow = new Adw.ActionRow({
      title: _("OCR engine"),
      subtitle: _("Checking…"),
    });
    group.add(this._screenVisionRow);
    group.add(this._screenOcrRow);
    group.add(this._screenOcrEngineRow);
    this._testScreenRow = new Adw.ActionRow({
      title: _("Test screen capture"),
    });
    const testBtn = this._mkButton(_("Test"), () => {
      this._testScreenRow.set_subtitle(_("Capturing…"));
      this._connection?.send({ type: "capture_screen_context", mode: "auto" });
    });
    this._testScreenRow.add_suffix(testBtn);
    group.add(this._testScreenRow);
    this._askScreenShortcutRow = new Adw.SwitchRow({
      title: _("Shortcut: Ctrl+Shift+Space"),
      subtitle: _("Enabled only when screen context is available."),
    });
    settings.bind(
      "ask-screen-shortcut-enabled",
      this._askScreenShortcutRow,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    group.add(this._askScreenShortcutRow);
    page.add(group);
  }

  _buildAI(page) {
    const group = new Adw.PreferencesGroup({
      title: _("AI"),
      description: _("Provider settings are stored in the vox2ai config file."),
    });
    this._providerRow = new Adw.ActionRow({
      title: _("Provider"),
      subtitle: _("Checking…"),
    });
    this._baseUrlRow = new Adw.ActionRow({
      title: _("Base URL"),
      subtitle: _("Checking…"),
    });
    this._modelRow = new Adw.ActionRow({
      title: _("Model"),
      subtitle: _("Checking…"),
    });
    this._apiKeyRow = new Adw.ActionRow({
      title: _("API key"),
      subtitle: _("Checking…"),
    });
    this._visionSupportRow = new Adw.ActionRow({
      title: _("Vision support"),
      subtitle: _("Checking…"),
    });
    group.add(this._providerRow);
    group.add(this._baseUrlRow);
    group.add(this._modelRow);
    group.add(this._apiKeyRow);
    group.add(this._visionSupportRow);
    const actions = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
      margin_top: 6,
      margin_bottom: 6,
      halign: Gtk.Align.START,
    });
    actions.append(
      this._mkButton(_("Test connection"), () => {
        this._apiKeyRow.set_subtitle(_("Testing…"));
        this._connection?.send({ type: "test_provider" });
      }),
    );
    actions.append(this._mkButton(_("Open config"), openConfigFile));
    group.add(actions);
    page.add(group);
  }

  _buildDiagnostics(page) {
    const group = new Adw.PreferencesGroup({
      title: _("Diagnostics"),
      description: _("Read-only capability report from the backend."),
    });
    this._diagRows = {
      backend: new Adw.ActionRow({ title: _("Backend") }),
      service: new Adw.ActionRow({ title: _("Backend service") }),
      text: new Adw.ActionRow({ title: _("Text prompt") }),
      voice: new Adw.ActionRow({ title: _("Voice prompt") }),
      audio: new Adw.ActionRow({ title: _("Audio input") }),
      audioTest: new Adw.ActionRow({ title: _("Audio input test") }),
      autoFinish: new Adw.ActionRow({ title: _("Auto-finish") }),
      conversation: new Adw.ActionRow({ title: _("Conversation") }),
      screen: new Adw.ActionRow({ title: _("Screen capture") }),
      vision: new Adw.ActionRow({ title: _("Vision") }),
      ocr: new Adw.ActionRow({ title: _("OCR") }),
      lastError: new Adw.ActionRow({ title: _("Last error") }),
    };
    for (const row of Object.values(this._diagRows)) group.add(row);
    page.add(group);
  }

  _buildAdvanced(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: _("Advanced"),
      description: _("Service paths and recovery actions."),
    });
    const safeMode = new Adw.SwitchRow({ title: _("Safe mode") });
    settings.bind(
      "safe-mode",
      safeMode,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    group.add(safeMode);

    const approvalMode = new Adw.ComboRow({ title: _("Command approval") });
    const approvalLabels = [
      _("Always ask"),
      _("Auto-approve safe commands"),
      _("Auto-approve everything"),
    ];
    const approvalValues = ["ask", "safe_only", "always"];
    approvalMode.set_model(new Gtk.StringList({ strings: approvalLabels }));
    const currentApproval = settings.get_string("command-approval-mode") || "ask";
    approvalMode.set_selected(Math.max(0, approvalValues.indexOf(currentApproval)));
    approvalMode.connect("notify::selected", () => {
      const idx = approvalMode.get_selected();
      if (idx >= 0 && idx < approvalValues.length) {
        settings.set_string("command-approval-mode", approvalValues[idx]);
        this._sendCommandApprovalMode(approvalValues[idx]);
      }
    });
    group.add(approvalMode);
    group.add(
      new Adw.ActionRow({
        title: _("Backend service name"),
        subtitle: SERVICE_NAME,
      }),
    );
    group.add(
      new Adw.ActionRow({
        title: _("Backend endpoint"),
        subtitle: `${settings.get_string("backend-host")}:${settings.get_int("backend-port")}`,
      }),
    );
    const saveDebug = new Adw.SwitchRow({
      title: _("Save screen captures for debug"),
    });
    settings.bind(
      "screen-capture-save-debug",
      saveDebug,
      "active",
      Gio.SettingsBindFlags.DEFAULT,
    );
    saveDebug.connect("notify::active", () => this._sendScreenSettings());
    group.add(saveDebug);
    const actions = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
      margin_top: 6,
      margin_bottom: 6,
      halign: Gtk.Align.START,
    });
    const logsBtn = this._mkButton(_("Open logs"), () =>
      copyText(LOGS_COMMAND, logsBtn),
    );
    actions.append(logsBtn);
    actions.append(this._mkButton(_("Open config"), openConfigFile));
    actions.append(
      this._mkButton(_("Reset settings"), () => this._resetSettings()),
    );
    group.add(actions);
    page.add(group);
  }

  _mkButton(label, onClick) {
    const btn = new Gtk.Button({ label, valign: Gtk.Align.CENTER });
    btn.connect("clicked", onClick);
    return btn;
  }

  _mkIntSettingRow(settings, key, title, lower, upper, step, formatValue) {
    const row = new Adw.ActionRow({ title });
    const valueLabel = new Gtk.Label({
      label: formatValue(settings.get_int(key)),
      css_classes: ["dim-label"],
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
    spin.connect("value-changed", () => {
      const value = Math.round(spin.get_value());
      settings.set_int(key, value);
      valueLabel.set_label(formatValue(value));
      this._sendVoiceSettings();
    });
    row.add_suffix(valueLabel);
    row.add_suffix(spin);
    row.set_activatable_widget(spin);
    return row;
  }

  _mkSensitivityRow(settings) {
    const row = new Adw.ActionRow({
      title: _("Sensitivity"),
      subtitle: _("Negative is less sensitive; positive detects quieter speech."),
    });

    const scale = Gtk.Scale.new_with_range(
      Gtk.Orientation.HORIZONTAL,
      -100,
      100,
      1,
    );

    scale.set_digits(0);
    scale.set_draw_value(true);
    scale.set_value(
      thresholdToSensitivity(settings.get_double("voice-activity-threshold")),
    );

    scale.set_property("width-request", 200);

    scale.connect("value-changed", () => {
      const sensitivity = scale.get_value();
      const threshold = sensitivityToThreshold(sensitivity);

      settings.set_double("voice-activity-threshold", threshold);

      this._thresholdRow?.set_subtitle(
        `${Math.round(sensitivity)}% sensitivity · threshold ${threshold.toFixed(4)}`,
      );

      this._sendVoiceSettings();
    });

    row.add_suffix(scale);
    row.set_activatable_widget(scale);

    return row;
  }
  _mkLanguageModeRow() {
    const row = new Adw.ComboRow({ title: _("Language mode") });
    const labels = [_("Auto"), _("Force primary"), _("Constrained auto")];
    const values = ["auto", "force", "constrained-auto"];
    const current = this._backendSettings?.voice?.language_mode || "auto";
    row.set_model(new Gtk.StringList({ strings: labels }));
    row.set_selected(Math.max(0, values.indexOf(current)));
    row.connect("notify::selected", () => this._sendVoiceSettings());
    this._languageModeRow = row;
    this._languageModeValues = values;
    return row;
  }

  async _loadAudioDevices() {
    if (!this._inputDeviceRow) return;
    const result = await runVox2ai(["audio-devices", "--json"]);
    const labels = [_("Automatic")];
    const ids = [""];
    let selected = "";
    if (result.ok) {
      try {
        const payload = JSON.parse(result.stdout || "{}");
        selected = payload.selected || "";
        for (const device of payload.devices || []) {
          ids.push(String(device.id || ""));
          labels.push(
            String(
              device.label || device.name || device.id || _("Unknown device"),
            ),
          );
        }
      } catch (e) {
        // Keep Automatic as fallback.
      }
    }
    if (selected && !ids.includes(selected)) {
      ids.push(selected);
      labels.push(`${selected} (${_("saved")})`);
    }
    this._audioDeviceIds = ids;
    this._audioDeviceLoading = true;
    this._inputDeviceRow.set_model(new Gtk.StringList({ strings: labels }));
    this._inputDeviceRow.set_selected(Math.max(0, ids.indexOf(selected)));
    if (!this._inputDeviceSignal) {
      this._inputDeviceSignal = this._inputDeviceRow.connect(
        "notify::selected",
        () => {
          if (this._audioDeviceLoading) return;
          this._sendVoiceSettings();
        },
      );
    }
    this._audioDeviceLoading = false;
  }

  _toggleAudioTest() {
    if (this._audioTestRunning) this._stopAudioTest();
    else this._startAudioTest();
  }

  _startAudioTest() {
    this._sendVoiceSettings();
    if (!this._connection?.send({ type: "start_audio_input_test" })) {
      this._meterRow.set_subtitle(_("Backend is not connected."));
      return;
    }
    this._meterRow.set_subtitle(_("Listening for microphone levels…"));
  }

  _stopAudioTest() {
    if (this._audioTestRunning || this._connection)
      this._connection?.send({ type: "stop_audio_input_test" });
    this._audioTestRunning = false;
    if (this._micTestButton)
      this._micTestButton.set_label(_("Test microphone"));
  }

  _sendVoiceSettings() {
    if (!this._connection) return;
    const modeIdx = this._languageModeRow?.get_selected() ?? 0;
    const deviceIdx = this._inputDeviceRow?.get_selected() ?? 0;
    this._connection.send({
      type: "update_voice_settings",
      settings: {
        auto_finish_enabled: this._settings.get_boolean(
          "auto-finish-recording",
        ),
        silence_timeout_ms: this._settings.get_int("silence-timeout-ms"),
        min_recording_ms: this._settings.get_int("min-recording-ms"),
        max_recording_ms: this._settings.get_int("max-recording-ms"),
        voice_activity_threshold: this._settings.get_double(
          "voice-activity-threshold",
        ),
        input_device: this._audioDeviceIds?.[deviceIdx] || "",
        language_mode: this._languageModeValues?.[modeIdx] || "auto",
        primary_language: this._primaryLanguageRow?.get_text?.() || "en",
        whisper_model: this._whisperModelRow?.get_text?.() || "small",
      },
    });
  }

  _sendConversationSettings() {
    const enabled = this._settings.get_boolean("conversation-mode");
    this._connection?.send({ type: "set_conversation_mode", enabled });
    this._connection?.send({
      type: "update_settings",
      settings: {
        conversation: {
          enabled,
          max_turns: this._settings.get_int("conversation-max-turns"),
          max_messages: this._settings.get_int("conversation-max-turns") * 2,
        },
      },
    });
  }

  _sendCommandApprovalMode(mode) {
    this._connection?.send({
      type: "update_settings",
      settings: {
        commands: { approval_mode: mode },
      },
    });
  }

  _sendScreenSettings() {
    this._connection?.send({
      type: "update_settings",
      settings: {
        context: {
          screen_context_enabled: this._settings.get_boolean(
            "screen-context-enabled",
          ),
          screen_capture_method: screenCaptureMethod(this._settings),
          screen_capture_save_debug: this._settings.get_boolean(
            "screen-capture-save-debug",
          ),
        },
      },
    });
  }

  async _refreshServiceStatus() {
    const result = await runSystemctl(["is-active", SERVICE_NAME]);
    let status = "inactive";
    if (result.ok && result.stdout) status = result.stdout;
    else if (result.stderr.includes("not loaded")) status = "not installed";
    this._diagRows?.service?.set_subtitle(status);
  }

  _setConnectionState(state) {
    if (this._diagRows?.backend) this._diagRows.backend.set_subtitle(state);
  }

  _handleBackendEvent(event) {
    switch (event.type) {
      case "capabilities":
        this._capabilities = event;
        this._updateCapabilityRows();
        break;
      case "settings":
      case "settings_saved":
        this._backendSettings = event.settings || null;
        this._updateAiRows();
        break;
      case "conversation_state":
        if (this._diagRows?.conversation)
          this._diagRows.conversation.set_subtitle(
            event.enabled
              ? `${_("Enabled")} (${event.turn_count || 0}/${event.max_turns || 8})`
              : _("Disabled"),
          );
        break;
      case "audio_input_test_started":
        this._audioTestRunning = true;
        this._micTestButton?.set_label(_("Stop test"));
        this._meterRow?.set_subtitle(
          _("Speak normally and adjust sensitivity."),
        );
        break;
      case "audio_input_test_level":
        this._updateAudioTestLevel(event);
        break;
      case "audio_input_test_stopped":
        this._audioTestRunning = false;
        this._micTestButton?.set_label(_("Test microphone"));
        break;
      case "audio_input_test_error":
        this._audioTestRunning = false;
        this._micTestButton?.set_label(_("Test microphone"));
        this._meterRow?.set_subtitle(
          event.message || _("Could not open microphone."),
        );
        break;
      case "screen_capture_started":
        this._testScreenRow?.set_subtitle(_("Capturing…"));
        break;
      case "screen_context_ready":
        this._testScreenRow?.set_subtitle(`Works (${event.mode || "screen"})`);
        break;
      case "screen_context_error":
        this._testScreenRow?.set_subtitle(
          event.message || _("Screen capture failed."),
        );
        break;
      case "provider_test_result":
        this._apiKeyRow?.set_subtitle(
          event.ok ? _("Connection works") : event.message,
        );
        break;
      case "wake_listening":
        this._wakeStatusRow?.set_subtitle(
          `Listening (${event.model || "unknown"}, threshold ${Number(event.threshold || 0).toFixed(2)})`,
        );
        if (this._wakeTestRunning)
          this._wakeTestRow?.set_subtitle(`Listening for "${event.model || "wake word"}"...`);
        break;
      case "wake_detected":
        this._wakeStatusRow?.set_subtitle(_("Wake word detected!"));
        if (this._wakeTestRunning) {
          this._wakeTestRow?.set_subtitle(_("Detected! Wake word recognized."));
          this._stopWakeTest();
        }
        break;
      case "wake_stopped":
        this._wakeStatusRow?.set_subtitle(_("Stopped"));
        break;
    }
  }

  _updateAudioTestLevel(event) {
    const rms = Math.max(0, Number(event.rms) || 0);
    const peak = Math.max(0, Number(event.peak) || 0);
    const level = Math.min(1, Math.max(rms * 12, peak * 4));
    this._levelBar?.set_value(level);
    this._speechRow?.set_subtitle(event.speech_detected ? _("Yes") : _("No"));
    this._rmsRow?.set_subtitle(rms.toFixed(5));
    this._thresholdRow?.set_subtitle((Number(event.threshold) || 0).toFixed(4));
  }

  _updateCapabilityRows() {
    const caps = this._capabilities?.capabilities || {};
    const screen = this._capabilities?.screen || {};
    const audio = this._capabilities?.audio || {};
    const assistant = this._capabilities?.assistant || {};
    this._diagRows.text.set_subtitle(boolText(!!caps.text_prompt?.available));
    this._diagRows.voice.set_subtitle(boolText(!!caps.voice_prompt?.available));
    this._diagRows.audio.set_subtitle(
      audio.input_available
        ? `${_("Available")} (${audio.input_device || "default"})`
        : audio.last_error || _("Unavailable"),
    );
    this._diagRows.audioTest.set_subtitle(
      boolText(!!caps.audio_input_test?.available),
    );
    this._diagRows.autoFinish.set_subtitle(
      boolText(!!caps.auto_finish_recording?.available),
    );
    this._diagRows.screen.set_subtitle(
      screen.capture_available
        ? `${_("Available")} (${screen.capture_method || "auto"})`
        : screen.last_error || caps.screen_capture?.reason || _("Unavailable"),
    );
    this._diagRows.vision.set_subtitle(
      screen.vision_available
        ? _("Available")
        : caps.vision?.reason || _("Unavailable"),
    );
    this._diagRows.ocr.set_subtitle(
      screen.ocr_available
        ? `${_("Available")} (${screen.ocr_engine || "tesseract"})`
        : caps.ocr?.reason || _("Unavailable"),
    );
    this._diagRows.lastError.set_subtitle(
      screen.last_error || audio.last_error || _("None"),
    );

    this._screenVisionRow?.set_subtitle(
      screen.vision_available
        ? _("Available")
        : caps.vision?.reason || _("Unavailable"),
    );
    this._screenOcrRow?.set_subtitle(
      screen.ocr_available
        ? _("Available")
        : caps.ocr?.reason || _("Unavailable"),
    );
    this._screenOcrEngineRow?.set_subtitle(screen.ocr_engine || _("None"));
    const screenUsable = !!(
      screen.capture_available &&
      (screen.vision_available || screen.ocr_available)
    );
    this._askScreenShortcutRow?.set_sensitive(screenUsable);
    if (!screenUsable)
      this._askScreenShortcutRow?.set_subtitle(
        _("Unavailable until capture plus vision or OCR works."),
      );
    else
      this._askScreenShortcutRow?.set_subtitle(
        _("Optional shortcut for Ask about screen."),
      );

    this._visionSupportRow?.set_subtitle(
      assistant.supports_vision ? _("Yes") : _("No"),
    );
    this._modelRow?.set_subtitle(assistant.model || _("Unknown"));
    this._apiKeyRow?.set_subtitle(
      assistant.api_key_present
        ? `${_("Configured")} (${assistant.api_key_source || "unknown"})`
        : _("Missing"),
    );
  }

  _updateAiRows() {
    const assistant = this._backendSettings?.assistant;
    if (!assistant) return;
    this._providerRow?.set_subtitle(assistant.provider || _("Unknown"));
    this._baseUrlRow?.set_subtitle(assistant.base_url || _("Unknown"));
    this._modelRow?.set_subtitle(assistant.model || _("Unknown"));
    this._apiKeyRow?.set_subtitle(
      assistant.api_key_configured ? _("Configured") : _("Missing"),
    );
  }

  _resetSettings() {
    for (const key of this._settings.settings_schema.list_keys()) {
      try {
        this._settings.reset(key);
      } catch (e) {
        // Keep going.
      }
    }
  }
}
