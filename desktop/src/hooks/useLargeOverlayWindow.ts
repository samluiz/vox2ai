import { useEffect } from "react";
import { setLargeOverlayWindow } from "../api/windowManager";

export function useLargeOverlayWindow(): void {
  useEffect(() => {
    void setLargeOverlayWindow();
    const retry = window.setTimeout(() => {
      void setLargeOverlayWindow();
    }, 120);

    return () => {
      window.clearTimeout(retry);
    };
  }, []);
}
