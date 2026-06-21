import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export type RecordingActivationMode = "hold-to-talk" | "toggle-to-talk";

export interface RecordingSettings {
  activationMode: RecordingActivationMode;
  shortcut: string;
}

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Super"] as const;
const MODIFIER_KEYS = new Set(["Ctrl", "Alt", "Shift", "Super", "Cmd"]);

export function platformSuperKey(): "Cmd" | "Super" {
  return navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Super";
}

export function normalizeKeyName(key: string, code?: string): string {
  if (key === "Control" || code === "ControlLeft" || code === "ControlRight") return "Ctrl";
  if (key === "Alt" || code === "AltLeft" || code === "AltRight") return "Alt";
  if (key === "Shift" || code === "ShiftLeft" || code === "ShiftRight") return "Shift";
  if (key === "Meta" || code === "MetaLeft" || code === "MetaRight") return platformSuperKey();
  if (key === " ") return "Space";
  if (key === "Esc") return "Escape";
  if (/^F\d{1,2}$/.test(key)) return key;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function normalizeShortcut(raw: string): string {
  const parts = raw
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "control" || lower === "ctrl") return "Ctrl";
      if (lower === "option" || lower === "alt") return "Alt";
      if (lower === "shift") return "Shift";
      if (lower === "meta" || lower === "super" || lower === "cmd" || lower === "command") {
        return platformSuperKey();
      }
      if (lower === "esc") return "Escape";
      if (lower === "space") return "Space";
      return normalizeKeyName(part);
    });

  const modifiers = MODIFIER_ORDER.filter((mod) => parts.includes(mod));
  const primary = parts.find((part) => !MODIFIER_KEYS.has(part));
  return [...modifiers, ...(primary ? [primary] : [])].join("+");
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent | ReactKeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push(platformSuperKey());

  const key = normalizeKeyName(event.key, event.code);
  if (!MODIFIER_KEYS.has(key)) {
    parts.push(key);
  } else if (parts.length === 0 || !parts.includes(key)) {
    parts.push(key);
  }

  return normalizeShortcut(parts.join("+"));
}

export function validateRecordingShortcut(shortcut: string): string | null {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return "Shortcut cannot be empty.";
  if (normalized === "Escape") return "Esc is reserved for cancel.";
  if (/^[A-Z0-9]$/.test(normalized)) {
    return "Use a modifier or function key to avoid conflicts while typing.";
  }
  return null;
}

export function validateGlobalShortcut(shortcut: string): string | null {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return "Shortcut cannot be empty.";
  if (normalized === "Escape") return "Esc is reserved for cancel.";
  const parts = normalized.split("+");
  const hasPrimaryKey = parts.some((part) => !MODIFIER_KEYS.has(part));
  if (!hasPrimaryKey) return "Global shortcut must include a non-modifier key.";
  if (/^[A-Z0-9]$/.test(normalized)) {
    return "Use a modifier or function key to avoid conflicts while typing.";
  }
  return null;
}

export function shortcutMatchesEvent(
  event: KeyboardEvent,
  shortcut: string
): boolean {
  return shortcutFromKeyboardEvent(event) === normalizeShortcut(shortcut);
}

export function isModifierOnlyShortcut(shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return false;
  return normalized.split("+").every((part) => MODIFIER_KEYS.has(part));
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const el = target as HTMLElement;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable
  );
}
