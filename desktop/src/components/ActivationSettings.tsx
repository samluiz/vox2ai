import React from "react";
import ShortcutRecorder from "./ShortcutRecorder";
import { validateGlobalShortcut } from "../utils/shortcut";

export type ShortcutBehavior =
  | "show-widget"
  | "show-and-focus-input"
  | "show-and-record"
  | "toggle-widget";

export interface ActivationRuntimeStatus {
  registered?: boolean;
  shortcut?: string | null;
  behavior?: string;
  error?: string | null;
  global_shortcut_supported?: boolean;
  platform?: string;
  message?: string | null;
  start_at_login_supported?: boolean;
  start_at_login_enabled?: boolean;
}

interface ActivationSettingsProps {
  general: Record<string, unknown>;
  activation: Record<string, unknown>;
  desktopWindow: Record<string, unknown>;
  desktop: Record<string, unknown>;
  backendState: string;
  activationRuntimeStatus?: ActivationRuntimeStatus | null;
  onGeneralChange: (key: string, value: unknown) => void;
  onActivationChange: (key: string, value: unknown) => void;
  onDesktopWindowChange: (key: string, value: unknown) => void;
  onDesktopChange: (key: string, value: unknown) => void;
  onRestartBackend: () => void;
}

const ActivationSettings: React.FC<ActivationSettingsProps> = ({
  general,
  activation,
  desktopWindow,
  desktop,
  backendState,
  activationRuntimeStatus,
  onGeneralChange,
  onActivationChange,
  onDesktopWindowChange,
  onDesktopChange,
  onRestartBackend,
}) => {
  const startAtLoginSupported = activationRuntimeStatus?.start_at_login_supported ?? true;
  const registrationError = activationRuntimeStatus?.error;
  const shortcutSupported = activationRuntimeStatus?.global_shortcut_supported ?? true;
  const shortcutMessage = activationRuntimeStatus?.message;

  return (
    <div className="activation-settings">
      <div className="settings-subsection">
        <h4>Background</h4>
        <p className="settings-desc">Keep vox2ai available from the tray and shortcut.</p>
        <label className="form-check-label">
          <input
            type="checkbox"
            checked={(general.minimize_to_tray as boolean) ?? true}
            onChange={(event) => onGeneralChange("minimize_to_tray", event.target.checked)}
          />
          <span>
            <strong>Run in background</strong>
            <small>Closing the widget keeps vox2ai running in the tray.</small>
          </span>
        </label>
        <label className="form-check-label">
          <input
            type="checkbox"
            checked={(general.start_hidden as boolean) ?? true}
            onChange={(event) => onGeneralChange("start_hidden", event.target.checked)}
          />
          <span>
            <strong>Start hidden</strong>
            <small>Launch directly into tray/background when setup is complete.</small>
          </span>
        </label>
        <label className={`form-check-label ${startAtLoginSupported ? "" : "disabled-setting"}`}>
          <input
            type="checkbox"
            checked={(general.start_at_login as boolean) ?? false}
            disabled={!startAtLoginSupported}
            onChange={(event) => onGeneralChange("start_at_login", event.target.checked)}
          />
          <span>
            <strong>Start at login</strong>
            <small>
              {startAtLoginSupported
                ? "Launch vox2ai automatically when you sign in."
                : "Start at login is not supported on this platform yet."}
            </small>
          </span>
        </label>
      </div>

      <div className="settings-subsection">
        <h4>Global Shortcut</h4>
        <p className="settings-desc">This shortcut works from other apps, even when vox2ai is hidden.</p>
        <ShortcutRecorder
          value={(activation.global_shortcut as string) ?? "Ctrl+Space"}
          onChange={(next) => onActivationChange("global_shortcut", next)}
          validate={validateGlobalShortcut}
        />
        {activationRuntimeStatus?.registered ? (
          <div className="runtime-ok">
            Registered globally
            {activationRuntimeStatus?.platform ? (
              <span> · {activationRuntimeStatus.platform}</span>
            ) : null}
          </div>
        ) : !shortcutSupported ? (
          <div className="runtime-warning">
            <strong>Unavailable on this session.</strong>
            <span>{shortcutMessage || registrationError}</span>
          </div>
        ) : (
          <div className="form-error">
            {registrationError || "Shortcut will be registered after saving."}
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Behavior</label>
          <select
            className="form-select"
            value={(activation.shortcut_behavior as string) ?? "show-and-record"}
            onChange={(event) => onActivationChange("shortcut_behavior", event.target.value)}
          >
            <option value="show-widget">Show widget</option>
            <option value="show-and-focus-input">Show and focus input</option>
            <option value="show-and-record">Show and start recording</option>
            <option value="toggle-widget">Toggle widget</option>
          </select>
        </div>
      </div>

      <div className="settings-subsection">
        <h4>Window</h4>
        <div className="form-group">
          <label className="form-label">Summon position</label>
          <select
            className="form-select"
            value={(desktopWindow.summon_position as string) ?? "active-monitor-top-center"}
            onChange={(event) => onDesktopWindowChange("summon_position", event.target.value)}
          >
            <option value="active-monitor-top-center">Active monitor top-center</option>
            <option value="primary-monitor-top-center">Primary monitor top-center</option>
            <option value="remembered">Remembered position</option>
          </select>
        </div>
        <label className="form-check-label">
          <input
            type="checkbox"
            checked={(desktopWindow.remember_position as boolean) ?? true}
            onChange={(event) => onDesktopWindowChange("remember_position", event.target.checked)}
          />
          <span>Remember window position</span>
        </label>
        <label className="form-check-label">
          <input
            type="checkbox"
            checked={(desktopWindow.remember_size as boolean) ?? true}
            onChange={(event) => onDesktopWindowChange("remember_size", event.target.checked)}
          />
          <span>Remember widget size</span>
        </label>
        <label className="form-check-label">
          <input
            type="checkbox"
            checked={(desktopWindow.auto_hide_after_answer as boolean) ?? false}
            onChange={(event) =>
              onDesktopWindowChange("auto_hide_after_answer", event.target.checked)
            }
          />
          <span>Auto-hide after answer</span>
        </label>
        <div className="form-group">
          <label className="form-label">Auto-hide delay (ms)</label>
          <input
            className="form-input"
            type="number"
            value={(desktopWindow.auto_hide_delay_ms as number) ?? 2500}
            onChange={(event) =>
              onDesktopWindowChange("auto_hide_delay_ms", Number.parseInt(event.target.value, 10))
            }
          />
        </div>
      </div>

      <div className="settings-subsection">
        <h4>Backend</h4>
        <div className="settings-status-row">
          <span>Runtime state</span>
          <strong>{backendState}</strong>
        </div>
        <label className="form-check-label">
          <input
            type="checkbox"
            checked={(desktop.auto_restart_backend as boolean) ?? true}
            onChange={(event) => onDesktopChange("auto_restart_backend", event.target.checked)}
          />
          <span>Restart backend automatically</span>
        </label>
        <button className="form-btn form-btn-secondary" type="button" onClick={onRestartBackend}>
          Restart backend now
        </button>
      </div>
    </div>
  );
};

export default ActivationSettings;
