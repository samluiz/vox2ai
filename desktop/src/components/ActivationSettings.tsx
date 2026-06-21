import React, { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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

interface ActivationBackendInfo {
  kind: string;
  available: boolean;
  active: boolean;
  session_type: string;
  desktop: string;
  shortcut: string | null;
  message: string;
  details: string | null;
}

interface GnomeBridgeStatus {
  installed: boolean;
  name: string;
  command: string;
  binding: string;
  resolved_command: string | null;
  error: string | null;
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

function backendKindLabel(kind: string): string {
  switch (kind) {
    case "X11GlobalHotkey":
      return "Direct global shortcut";
    case "GnomeShortcutBridge":
      return "GNOME Shortcut Bridge";
    case "XdgPortalGlobalShortcuts":
      return "XDG Portal (experimental)";
    case "Unsupported":
      return "Unsupported";
    default:
      return kind;
  }
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

  const [backendInfo, setBackendInfo] = useState<ActivationBackendInfo | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<GnomeBridgeStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState(false);

  const refreshBackendInfo = useCallback(async () => {
    try {
      const info = (await invoke("get_activation_backend_status")) as ActivationBackendInfo;
      setBackendInfo(info);
    } catch {
      // Tauri invoke not available in dev mode
    }
  }, []);

  const refreshBridgeStatus = useCallback(async () => {
    try {
      const status = (await invoke("get_gnome_bridge_status")) as GnomeBridgeStatus;
      setBridgeStatus(status);
    } catch {
      // Tauri invoke not available in dev mode
    }
  }, []);

  useEffect(() => {
    refreshBackendInfo();
    refreshBridgeStatus();
  }, [refreshBackendInfo, refreshBridgeStatus]);

  const handleInstallBridge = useCallback(async () => {
    setInstalling(true);
    try {
      const shortcut = (activation.global_shortcut as string) ?? "Ctrl+Space";
      const behavior = (activation.shortcut_behavior as string) ?? "show-and-record";
      const result = (await invoke("install_gnome_shortcut", {
        shortcut,
        behavior,
      })) as GnomeBridgeStatus;
      setBridgeStatus(result);
      await refreshBackendInfo();
    } catch (e) {
      setBridgeStatus({
        installed: false,
        name: "",
        command: "",
        binding: "",
        resolved_command: null,
        error: String(e),
      });
    }
    setInstalling(false);
  }, [activation, refreshBackendInfo]);

  const handleRemoveBridge = useCallback(async () => {
    setRemoving(true);
    try {
      const result = (await invoke("remove_gnome_shortcut")) as GnomeBridgeStatus;
      setBridgeStatus(result);
      await refreshBackendInfo();
    } catch (e) {
      setBridgeStatus({
        installed: false,
        name: "",
        command: "",
        binding: "",
        resolved_command: null,
        error: String(e),
      });
    }
    setRemoving(false);
  }, [refreshBackendInfo]);

  const isWayland = backendInfo?.session_type === "Wayland";
  const isGnome = backendInfo?.desktop === "Gnome";
  const backendKind = backendInfo?.kind ?? "Unsupported";
  const showGnomeBridge = isWayland && isGnome;

  const manualFallbackCommand =
    (bridgeStatus?.resolved_command ?? "vox2aictl") + " summon --record";

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
        <h4>Global Activation</h4>
        <p className="settings-desc">
          Configure how vox2ai responds to the activation shortcut.
        </p>

        <div className="settings-status-row">
          <span>Session</span>
          <strong>
            {backendInfo
              ? `${backendInfo.desktop} / ${backendInfo.session_type}`
              : "Detecting..."}
          </strong>
        </div>
        <div className="settings-status-row">
          <span>Backend</span>
          <strong>{backendKindLabel(backendKind)}</strong>
        </div>

        {isWayland && (
          <div className="runtime-warning">
            <strong>Wayland session detected.</strong>
            <span>
              {isGnome
                ? "Direct global shortcuts are unavailable on Wayland. Use the GNOME Shortcut Bridge below."
                : "Global shortcuts are not available on this Wayland compositor. Configure a system-level shortcut manually."}
            </span>
          </div>
        )}

        {backendInfo && backendInfo.active && (
          <div className="runtime-ok">
            Shortcut active
            {backendInfo.shortcut ? <span> · {backendInfo.shortcut}</span> : null}
          </div>
        )}

        {backendInfo?.message && !backendInfo.active && (
          <div className="runtime-info">
            <span>{backendInfo.message}</span>
          </div>
        )}

        {!isWayland && (
          <>
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
          </>
        )}

        <div className="form-group">
          <label className="form-label">Shortcut behavior</label>
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

      {showGnomeBridge && (
        <div className="settings-subsection">
          <h4>GNOME Shortcut Bridge</h4>
          <p className="settings-desc">
            GNOME owns the global keybinding. vox2ai installs a custom shortcut that
            calls vox2aictl to control the running app.
          </p>

          <div className="settings-status-row">
            <span>Status</span>
            <strong>
              {bridgeStatus === null
                ? "Checking..."
                : bridgeStatus.installed
                  ? "Installed"
                  : "Not installed"}
            </strong>
          </div>

          {bridgeStatus?.installed && (
            <>
              <div className="settings-status-row">
                <span>Command</span>
                <code className="settings-code">{bridgeStatus.command}</code>
              </div>
              <div className="settings-status-row">
                <span>Binding</span>
                <code className="settings-code">{bridgeStatus.binding}</code>
              </div>
            </>
          )}

          {bridgeStatus?.error && (
            <div className="form-error">{bridgeStatus.error}</div>
          )}

          <div className="form-actions">
            {bridgeStatus?.installed ? (
              <button
                className="form-btn form-btn-secondary"
                onClick={handleRemoveBridge}
                disabled={removing}
              >
                {removing ? "Removing..." : "Remove GNOME Shortcut"}
              </button>
            ) : (
              <button
                className="form-btn form-btn-primary"
                onClick={handleInstallBridge}
                disabled={installing}
              >
                {installing
                  ? "Installing..."
                  : bridgeStatus !== null
                    ? "Reinstall GNOME Shortcut"
                    : "Install GNOME Shortcut"}
              </button>
            )}
          </div>

          <details className="settings-details">
            <summary>Manual fallback</summary>
            <p className="settings-desc">
              If automatic installation fails, create a GNOME custom shortcut manually:
            </p>
            <div className="settings-fallback">
              <div className="settings-status-row">
                <span>Name</span>
                <code className="settings-code">vox2ai</code>
              </div>
              <div className="settings-status-row">
                <span>Command</span>
                <code className="settings-code">{manualFallbackCommand}</code>
              </div>
              <div className="settings-status-row">
                <span>Shortcut</span>
                <code className="settings-code">
                  {(activation.global_shortcut as string) ?? "Ctrl+Space"}
                </code>
              </div>
            </div>
          </details>
        </div>
      )}

      {!showGnomeBridge && backendKind === "Unsupported" && (
        <div className="settings-subsection">
          <h4>Manual shortcut</h4>
          <p className="settings-desc">
            Configure a system-level shortcut manually to run:
          </p>
          <div className="settings-fallback">
            <code className="settings-code">{manualFallbackCommand}</code>
          </div>
        </div>
      )}

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
