import {
  getCurrentWindow,
  LogicalSize,
  LogicalPosition,
  currentMonitor,
  primaryMonitor,
  availableMonitors,
} from "@tauri-apps/api/window";

export type WindowMode = string;

export const WINDOW_PADDING = 10;
export const MIN_CARD_WIDTH = 360;
export const PREFERRED_CARD_WIDTH = 520;
export const MAX_CARD_WIDTH = 680;
export const MIN_CARD_HEIGHT = 64;
export const WINDOW_TOP_MARGIN = 24;
export const WINDOW_BOTTOM_MARGIN = 48;

const IS_DEV = import.meta.env?.DEV ?? true;

function log(...args: unknown[]) {
  if (IS_DEV) {
    // eslint-disable-next-line no-console
    console.log("[vox2ai:window]", ...args);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Determine the window mode from UI state.
 */
export function deriveWindowMode(
  isListening: boolean,
  isTranscribing: boolean,
  isThinking: boolean,
  isStreaming: boolean,
  isApproval: boolean,
  isError: boolean,
  hasAnswer: boolean,
  hasTranscript: boolean,
  hasPartialTranscript: boolean
): WindowMode {
  if (isError) return "error";
  if (isApproval) return "approval";
  if (hasAnswer || isStreaming) return "answer";
  if (isThinking && hasTranscript) return "thinking";
  if (isThinking) return "thinking";
  if (isTranscribing) return "transcribing";
  if (isListening && hasPartialTranscript) return "listeningWithPartial";
  if (isListening) return "listening";
  if (hasTranscript) return "thinking";
  return "readyWithInput";
}

export function cardSizeForModeCompact(mode: string): { width: number; height: number } | null {
  const COMPACT: Record<string, { width: number; height: number }> = {
    ready: { width: 360, height: 52 },
    readyWithInput: { width: 420, height: 76 },
    listening: { width: 360, height: 72 },
    listeningWithPartial: { width: 420, height: 92 },
    transcribing: { width: 360, height: 64 },
    thinking: { width: 420, height: 72 },
  };
  return COMPACT[mode] ?? null;
}

/**
 * Compute the desired total window size (card + transparent padding)
 * and the available max height from the current monitor.
 * Returns null if monitor info is unavailable.
 */
export async function computeWindowSize(
  cardWidth: number,
  cardHeight: number
): Promise<{ totalWidth: number; totalHeight: number; maxHeight: number } | null> {
  const monitor =
    (await currentMonitor()) ??
    (await primaryMonitor()) ??
    (await availableMonitors())[0];

  if (!monitor) return null;

  const scaleFactor = monitor.scaleFactor;
  const monitorLogicalHeight = monitor.size.height / scaleFactor;

  const maxHeight = monitorLogicalHeight - WINDOW_TOP_MARGIN - WINDOW_BOTTOM_MARGIN;
  const totalWidth = clamp(cardWidth, MIN_CARD_WIDTH, MAX_CARD_WIDTH) + WINDOW_PADDING * 2;
  const targetCardH = clamp(cardHeight, MIN_CARD_HEIGHT, maxHeight);
  const totalHeight = targetCardH + WINDOW_PADDING * 2;

  return { totalWidth, totalHeight, maxHeight };
}

/**
 * Set the Tauri window size and reposition top-center.
 */
export async function setWindowSizeAndPosition(width: number, height: number): Promise<void> {
  try {
    const win = getCurrentWindow();

    const monitor =
      (await currentMonitor()) ??
      (await primaryMonitor()) ??
      (await availableMonitors())[0];

    if (!monitor) {
      log("no monitor available, skipping positioning");
      return;
    }

    const scaleFactor = monitor.scaleFactor;
    const monitorWidth = monitor.size.width / scaleFactor;
    const monitorX = monitor.position.x / scaleFactor;

    const x = Math.round(monitorX + (monitorWidth - width) / 2);
    const y = WINDOW_TOP_MARGIN;

    log("placing window", { logicalSize: `${width}x${height}`, logicalPosition: `${x},${y}` });

    await win.setSize(new LogicalSize(width, height));
    await win.setPosition(new LogicalPosition(x, y));
  } catch (err) {
    log("setWindowSizeAndPosition failed", err);
  }
}

/**
 * Best-effort always-on-top.
 */
export async function applyAlwaysOnTop(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(true);
    log("setAlwaysOnTop(true) applied");
  } catch (err) {
    log("setAlwaysOnTop failed (best effort only)", err);
  }
}

/**
 * Best-effort focus.
 */
export async function applyFocus(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.setFocus();
    log("setFocus() applied");
  } catch (err) {
    log("setFocus failed", err);
  }
}

/**
 * Initialize the window on startup.
 */
export async function initializeWindow(): Promise<void> {
  const size = await computeWindowSize(MIN_CARD_WIDTH, MIN_CARD_HEIGHT);
  if (size) {
    await setWindowSizeAndPosition(size.totalWidth, size.totalHeight);
  }
  await applyAlwaysOnTop();
  await applyFocus();
}
