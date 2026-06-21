import { useCallback, useEffect, useRef } from "react";
import {
  getCurrentWindow,
  LogicalSize,
  currentMonitor,
  primaryMonitor,
  availableMonitors,
} from "@tauri-apps/api/window";
import { WINDOW_SIZE_LIMITS } from "../api/windowManager";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

interface DesktopWindowSettings {
  user_resizable?: boolean;
  remember_size?: boolean;
  manual_size?: boolean;
  width?: number;
  height?: number;
}

interface UseWindowResizePersistenceOptions {
  settings?: DesktopWindowSettings | null;
  enabled: boolean;
  settingsOpen: boolean;
  restoreSavedSize?: boolean;
  onManualSizeChange: (manual: boolean) => void;
  onPersistSize: (width: number, height: number) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function physicalToLogical(width: number, height: number): Promise<{ width: number; height: number }> {
  const monitor =
    (await currentMonitor()) ??
    (await primaryMonitor()) ??
    (await availableMonitors())[0];
  const scaleFactor = monitor?.scaleFactor ?? 1;
  return {
    width: Math.round(width / scaleFactor),
    height: Math.round(height / scaleFactor),
  };
}

export function useWindowResizePersistence({
  settings,
  enabled,
  settingsOpen,
  restoreSavedSize = true,
  onManualSizeChange,
  onPersistSize,
}: UseWindowResizePersistenceOptions): (direction?: ResizeDirection) => void {
  const userSizingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoredRef = useRef(false);

  useEffect(() => {
    const applyConstraints = async () => {
      const win = getCurrentWindow();
      const resizable = enabled && (settings?.user_resizable ?? true);
      await win.setResizable(resizable);
      await win.setMinSize(
        new LogicalSize(WINDOW_SIZE_LIMITS.minWidth, WINDOW_SIZE_LIMITS.minHeight)
      );
      await win.setMaxSize(
        new LogicalSize(WINDOW_SIZE_LIMITS.maxWidth, WINDOW_SIZE_LIMITS.maxHeight)
      );
    };
    applyConstraints().catch(() => undefined);
  }, [enabled, settings?.user_resizable]);

  useEffect(() => {
    if (!enabled || settingsOpen || restoredRef.current || !restoreSavedSize) return;
    if (!(settings?.remember_size ?? true)) return;
    if (!settings?.manual_size) return;

    const width = clamp(
      settings.width ?? WINDOW_SIZE_LIMITS.defaultWidth,
      WINDOW_SIZE_LIMITS.minWidth,
      WINDOW_SIZE_LIMITS.maxWidth
    );
    const height = clamp(
      settings.height ?? WINDOW_SIZE_LIMITS.defaultHeight,
      WINDOW_SIZE_LIMITS.minHeight,
      WINDOW_SIZE_LIMITS.maxHeight
    );
    restoredRef.current = true;

    getCurrentWindow()
      .setSize(new LogicalSize(width, height))
      .catch(() => undefined);
    onManualSizeChange(true);
  }, [
    enabled,
    onManualSizeChange,
    restoreSavedSize,
    settings?.height,
    settings?.manual_size,
    settings?.remember_size,
    settings?.width,
    settingsOpen,
  ]);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    getCurrentWindow()
      .onResized(({ payload }) => {
        if (!userSizingRef.current || settingsOpen) return;
        if (!(settings?.remember_size ?? true)) return;
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          physicalToLogical(payload.width, payload.height)
            .then((size) => {
              onPersistSize(
                clamp(size.width, WINDOW_SIZE_LIMITS.minWidth, WINDOW_SIZE_LIMITS.maxWidth),
                clamp(size.height, WINDOW_SIZE_LIMITS.minHeight, WINDOW_SIZE_LIMITS.maxHeight)
              );
            })
            .catch(() => undefined);
        }, 300);
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [enabled, onPersistSize, settings?.remember_size, settingsOpen]);

  return useCallback(
    (direction: ResizeDirection = "SouthEast") => {
      if (!enabled || !(settings?.user_resizable ?? true)) return;
      userSizingRef.current = true;
      onManualSizeChange(true);
      getCurrentWindow().startResizeDragging(direction).catch(() => undefined);
    },
    [enabled, onManualSizeChange, settings?.user_resizable]
  );
}
