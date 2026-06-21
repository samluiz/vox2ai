import {
  getCurrentWindow,
  LogicalSize,
  LogicalPosition,
  currentMonitor,
  primaryMonitor,
  availableMonitors,
} from "@tauri-apps/api/window";

export type WindowMode = string;

export const WINDOW_SIZE_LIMITS = {
  minWidth: 360,
  minHeight: 136,
  defaultWidth: 520,
  defaultHeight: 160,
  maxWidth: 900,
  maxHeight: 720,
};

export const LARGE_OVERLAY_SIZE = {
  width: 900,
  height: 680,
  minWidth: 760,
  minHeight: 520,
};

export const WINDOW_PADDING = 10;
export const MIN_CARD_WIDTH = WINDOW_SIZE_LIMITS.minWidth - WINDOW_PADDING * 2;
export const PREFERRED_CARD_WIDTH = WINDOW_SIZE_LIMITS.defaultWidth - WINDOW_PADDING * 2;
export const MAX_CARD_WIDTH = WINDOW_SIZE_LIMITS.maxWidth - WINDOW_PADDING * 2;
export const MIN_CARD_HEIGHT = WINDOW_SIZE_LIMITS.minHeight - WINDOW_PADDING * 2;
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
    ready: {
      width: WINDOW_SIZE_LIMITS.minWidth - WINDOW_PADDING * 2,
      height: WINDOW_SIZE_LIMITS.minHeight - WINDOW_PADDING * 2,
    },
    readyWithInput: {
      width: WINDOW_SIZE_LIMITS.minWidth - WINDOW_PADDING * 2,
      height: WINDOW_SIZE_LIMITS.minHeight - WINDOW_PADDING * 2,
    },
    listening: { width: 400, height: 88 },
    listeningWithPartial: { width: 460, height: 112 },
    transcribing: { width: 400, height: 58 },
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

  const maxTotalHeight = Math.min(
    WINDOW_SIZE_LIMITS.maxHeight,
    monitorLogicalHeight - WINDOW_TOP_MARGIN - WINDOW_BOTTOM_MARGIN
  );
  const maxHeight = Math.max(MIN_CARD_HEIGHT, maxTotalHeight - WINDOW_PADDING * 2);
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
 * Make settings/onboarding/diagnostics feel like real desktop panels instead
 * of inheriting the compact OSD widget constraints.
 */
export async function setLargeOverlayWindow(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.setResizable(true);
    await win.setMinSize(
      new LogicalSize(LARGE_OVERLAY_SIZE.minWidth, LARGE_OVERLAY_SIZE.minHeight)
    );
    await win.setMaxSize(
      new LogicalSize(WINDOW_SIZE_LIMITS.maxWidth, WINDOW_SIZE_LIMITS.maxHeight)
    );
  } catch (err) {
    log("setLargeOverlayWindow constraints failed", err);
  }

  await setWindowSizeAndPosition(LARGE_OVERLAY_SIZE.width, LARGE_OVERLAY_SIZE.height);
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
  await setWindowSizeAndPosition(
    WINDOW_SIZE_LIMITS.minWidth,
    WINDOW_SIZE_LIMITS.minHeight
  );
  await applyAlwaysOnTop();
  await applyFocus();
}
