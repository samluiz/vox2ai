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
  const enabledRef = useRef(enabled);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const mutationObserverRef = useRef<MutationObserver | null>(null);
  const lastSizeRef = useRef<{ w: number; h: number } | null>(null);

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      observerRef.current?.disconnect();
      mutationObserverRef.current?.disconnect();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    }
  }, [enabled]);

  const doResize = useCallback(() => {
    if (!enabled) return;
    if (!cardRef.current) return;

    const card = cardRef.current;

    requestAnimationFrame(async () => {
      if (!enabledRef.current) return;
      if (!cardRef.current || cardRef.current !== card) return;

      const compact = cardSizeForModeCompact(mode);
      const messages = card.querySelector<HTMLElement>(".messages");

      if (messages) {
        messages.style.maxHeight = "";
        messages.style.overflowY = "";
      }

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

      // When the message stack exceeds available monitor height, enable internal scroll.
      const needsScroll = compact === null && cardH > size.maxHeight;
      if (messages) {
        if (needsScroll) {
          const header = card.querySelector<HTMLElement>(".widget-header");
          const input = card.querySelector<HTMLElement>(".prompt-shell");
          const waveform = card.querySelector<HTMLElement>(".waveform");
          const partial = card.querySelector<HTMLElement>(".partial-transcript");
          const idle = card.querySelector<HTMLElement>(".idle-copy");
          const cardStyle = getComputedStyle(card);
          const verticalPadding =
            (Number.parseFloat(cardStyle.paddingTop) || 0) +
            (Number.parseFloat(cardStyle.paddingBottom) || 0);
          const fixedContentHeight =
            verticalPadding +
            (header?.offsetHeight ?? 20) +
            (input?.offsetHeight ?? 0) +
            (waveform?.offsetHeight ?? 0) +
            (partial?.offsetHeight ?? 0) +
            (idle?.offsetHeight ?? 0) +
            28;
          const availableForMessages = size.maxHeight - fixedContentHeight;
          messages.style.maxHeight = `${Math.max(availableForMessages, 72)}px`;
          messages.style.overflowY = "auto";
        } else {
          messages.style.maxHeight = "";
          messages.style.overflowY = "";
        }
      }

      // Skip if size hasn't changed (avoid redundant setSize calls).
      if (lastSizeRef.current && lastSizeRef.current.w === w && lastSizeRef.current.h === h) {
        return;
      }
      lastSizeRef.current = { w, h };

      await setWindowSizeAndPosition(w, h);
    });
  }, [cardRef, enabled, mode]);

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

  // ResizeObserver for layout changes plus MutationObserver for streaming text growth.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    observerRef.current?.disconnect();
    mutationObserverRef.current?.disconnect();

    observerRef.current = new ResizeObserver(() => {
      scheduleResize();
    });

    observerRef.current.observe(card);

    mutationObserverRef.current = new MutationObserver(() => {
      scheduleResize();
    });
    mutationObserverRef.current.observe(card, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    lastSizeRef.current = null;
    scheduleResize();

    return () => {
      observerRef.current?.disconnect();
      mutationObserverRef.current?.disconnect();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [cardRef, scheduleResize]);
}
