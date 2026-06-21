import React from "react";
import ShortcutRecorder from "./ShortcutRecorder";
import type { RecordingActivationMode } from "../utils/shortcut";

interface RecordingSettingsProps {
  activationMode: RecordingActivationMode;
  shortcut: string;
  onChange: (patch: { activation_mode?: RecordingActivationMode; shortcut?: string }) => void;
  onReset: () => void;
}

const RecordingSettings: React.FC<RecordingSettingsProps> = ({
  activationMode,
  shortcut,
  onChange,
  onReset,
}) => (
  <div className="recording-settings">
    <div className="form-group">
      <label className="form-label">Recording mode</label>
      <div className="segmented-list">
        <label className={`mode-option ${activationMode === "hold-to-talk" ? "active" : ""}`}>
          <input
            type="radio"
            name="recording-mode"
            checked={activationMode === "hold-to-talk"}
            onChange={() => onChange({ activation_mode: "hold-to-talk" })}
          />
          <span>
            <strong>Hold key to talk</strong>
            <small>Recording starts while the shortcut is held and stops when released.</small>
          </span>
        </label>
        <label className={`mode-option ${activationMode === "toggle-to-talk" ? "active" : ""}`}>
          <input
            type="radio"
            name="recording-mode"
            checked={activationMode === "toggle-to-talk"}
            onChange={() => onChange({ activation_mode: "toggle-to-talk" })}
          />
          <span>
            <strong>Press once to start</strong>
            <small>Recording starts on the first press and stops on the next press.</small>
          </span>
        </label>
      </div>
    </div>

    <div className="form-group">
      <label className="form-label">Recording shortcut</label>
      <ShortcutRecorder
        value={shortcut}
        onChange={(next) => onChange({ shortcut: next })}
      />
    </div>

    <button className="form-btn form-btn-secondary" type="button" onClick={onReset}>
      Reset to default
    </button>
  </div>
);

export default RecordingSettings;
