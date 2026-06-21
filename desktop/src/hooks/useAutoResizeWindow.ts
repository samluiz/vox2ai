import { useEffect, useRef, useCallback } from "react";
import {
  computeWindowSize,
  setWindowSizeAndPosition,
  cardSizeForModeCompact,
  clamp,
  MIN_CARD_WIDTH,
  MAX_CARD_WIDTH,
  MIN_CARD_HEIGHT,
  PREFERRED_CARD_WIDTH,
  WINDOW_PADDING,
} from "../api/windowManager";

interface UseAutoResizeWindowOptions {
  cardRef: React.RefObject<HTMLDivElement | null>;
  mode: string;
  isStreaming: boolean;
  enabled?: boolean;
}

/**
 * Automatically resizes the Tauri window to fit the assistant card content.
 *
 * Uses ResizeObserver to detect DOM size changes, debounces resize during
 * streaming answer deltas, and measures card.scrollHeight after layout via
 * requestAnimationFrame. Falls back to compact fixed sizes for known modes
 * that have minimal transient content (ready, listening, transcribing, etc.).
 */
export function useAutoResizeWindow({
  cardRef,
  mode,
  isStreaming,
  enabled = true,
}: UseAutoResizeWindowOptions): void {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastSizeRef = useRef<{ w: number; h: number } | null>(null);

  const doResize = useCallback(() => {
    if (!enabled) return;
    if (!cardRef.current) return;

    const card = cardRef.current;

    requestAnimationFrame(async () => {
      const compact = cardSizeForModeCompact(mode);

      let cardW: number;
      let cardH: number;

      if (compact) {
        cardW = compact.width;
        cardH = compact.height;
      } else {
        cardW = clamp(card.scrollWidth, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
        cardW = Math.max(cardW, PREFERRED_CARD_WIDTH);
        cardH = card.scrollHeight;
      }

      const size = await computeWindowSize(cardW, cardH);
      if (!size) return;

      const w = size.totalWidth;
      const h = size.totalHeight;

      // Skip if size hasn't changed (avoid redundant setSize calls).
      if (lastSizeRef.current && lastSizeRef.current.w === w && lastSizeRef.current.h === h) {
        return;
      }
      lastSizeRef.current = { w, h };

      await setWindowSizeAndPosition(w, h);

      // When the answer area exceeds available monitor height, enable internal scroll.
      const needsScroll = compact === null && cardH > size.maxHeight;
      const answerView = card.querySelector<HTMLElement>(".answer-view");
      if (answerView) {
        if (needsScroll) {
          const header = card.querySelector<HTMLElement>(".widget-header");
          const input = card.querySelector<HTMLElement>(".prompt-input");
          const tv = card.querySelector<HTMLElement>(".transcript-view");
          const availableForAnswer =
            size.maxHeight -
            WINDOW_PADDING * 2 -
            (header?.offsetHeight ?? 20) -
            (input?.offsetHeight ?? 0) -
            (tv?.offsetHeight ?? 0) -
            6;
          answerView.style.maxHeight = `${Math.max(availableForAnswer, 48)}px`;
          answerView.style.overflowY = "auto";
        } else {
          answerView.style.maxHeight = "";
          answerView.style.overflowY = "";
        }
      }
    });
  }, [cardRef, mode]);

  // Debounced resize for streaming.
  const scheduleResize = useCallback(() => {
    if (isStreaming) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        doResize();
      }, 80);
    } else {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      doResize();
    }
  }, [isStreaming, doResize]);

  // ResizeObserver on the card element.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    observerRef.current?.disconnect();

    observerRef.current = new ResizeObserver(() => {
      scheduleResize();
    });

    observerRef.current.observe(card);

    return () => {
      observerRef.current?.disconnect();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [cardRef, scheduleResize]);
}
