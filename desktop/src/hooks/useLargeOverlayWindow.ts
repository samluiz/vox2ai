import { useEffect } from "react";
import { setLargeOverlayWindow } from "../api/windowManager";

export function useLargeOverlayWindow(): void {
  useEffect(() => {
    void setLargeOverlayWindow();
  }, []);
}
