import { useEffect, useRef } from "react";
import {
  isModifierOnlyShortcut,
  isTextInputTarget,
  shortcutMatchesEvent,
  type RecordingActivationMode,
} from "../utils/shortcut";

interface UseRecordingShortcutOptions {
  enabled: boolean;
  shortcut: string;
  activationMode: RecordingActivationMode;
  isListening: boolean;
  isCancellable: boolean;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}

function isShortcutCaptureTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  return Boolean((target as HTMLElement).closest("[data-shortcut-recorder='true']"));
}

export function useRecordingShortcut({
  enabled,
  shortcut,
  activationMode,
  isListening,
  isCancellable,
  onStart,
  onStop,
  onCancel,
}: UseRecordingShortcutOptions): void {
  const keyActiveRef = useRef(false);
  const listeningRef = useRef(isListening);
  const cancellableRef = useRef(isCancellable);

  useEffect(() => {
    listeningRef.current = isListening;
  }, [isListening]);

  useEffect(() => {
    cancellableRef.current = isCancellable;
  }, [isCancellable]);

  useEffect(() => {
    if (!enabled) {
      keyActiveRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && cancellableRef.current) {
        event.preventDefault();
        onCancel();
        keyActiveRef.current = false;
        return;
      }

      if (!enabled) return;
      if (event.repeat) return;
      if (isShortcutCaptureTarget(event.target)) return;
      if (isTextInputTarget(event.target) && !isModifierOnlyShortcut(shortcut)) return;
      if (!shortcutMatchesEvent(event, shortcut)) return;

      event.preventDefault();
      if (keyActiveRef.current) return;
      keyActiveRef.current = true;

      if (activationMode === "toggle-to-talk") {
        if (listeningRef.current) {
          onStop();
        } else {
          onStart();
        }
        return;
      }

      if (!listeningRef.current) {
        onStart();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!enabled) return;
      if (!shortcutMatchesEvent(event, shortcut)) return;

      if (activationMode === "hold-to-talk" && keyActiveRef.current && listeningRef.current) {
        event.preventDefault();
        onStop();
      }
      keyActiveRef.current = false;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [activationMode, enabled, onCancel, onStart, onStop, shortcut]);
}
