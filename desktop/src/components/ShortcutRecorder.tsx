import React, { useRef, useState } from "react";
import {
  normalizeShortcut,
  shortcutFromKeyboardEvent,
  validateRecordingShortcut,
} from "../utils/shortcut";

interface ShortcutRecorderProps {
  value: string;
  onChange: (shortcut: string) => void;
  disabled?: boolean;
}

const ShortcutRecorder: React.FC<ShortcutRecorderProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const captureRef = useRef<HTMLButtonElement>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCapture = () => {
    if (disabled) return;
    setError(null);
    setCapturing(true);
    requestAnimationFrame(() => captureRef.current?.focus());
  };

  return (
    <div className="shortcut-recorder" data-shortcut-recorder="true">
      <div className={`shortcut-display ${capturing ? "capturing" : ""}`}>
        {capturing ? "Press shortcut..." : normalizeShortcut(value)}
      </div>
      <button
        ref={captureRef}
        className="form-btn form-btn-secondary shortcut-record-btn"
        type="button"
        disabled={disabled}
        onClick={startCapture}
        onBlur={() => setCapturing(false)}
        onKeyDown={(event) => {
          if (!capturing) return;
          event.preventDefault();
          event.stopPropagation();
          const next = shortcutFromKeyboardEvent(event);
          const validation = validateRecordingShortcut(next);
          if (validation) {
            setError(validation);
            return;
          }
          onChange(next);
          setCapturing(false);
          setError(null);
        }}
      >
        {capturing ? "Listening" : "Record shortcut"}
      </button>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
};

export default ShortcutRecorder;
