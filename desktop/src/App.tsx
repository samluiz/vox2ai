import React, { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { WebSocketClient } from "./api/websocket";
import type {
  BackendEvent,
  StateEvent,
  AudioLevelEvent,
  TranscriptEvent,
  PartialTranscriptEvent,
  AnswerDeltaEvent,
  CommandApprovalEvent,
  ErrorEvent,
} from "./api/protocol";
import {
  initializeWindow,
  deriveWindowMode,
  setWindowSizeAndPosition,
  type WindowMode,
} from "./api/windowManager";
import { useAutoResizeWindow } from "./hooks/useAutoResizeWindow";
import AssistantWindow from "./components/AssistantWindow";
import SettingsWindow from "./components/SettingsWindow";

const IS_DEV = import.meta.env?.DEV ?? true;

function log(...args: unknown[]) {
  if (IS_DEV) {
    // eslint-disable-next-line no-console
    console.log("[vox2ai:app]", ...args);
  }
}

const DEFAULT_WS_URL = "ws://127.0.0.1:8765";

const App: React.FC = () => {
  const wsRef = useRef<WebSocketClient | null>(null);
  const [status, setStatus] = useState("Starting backend...");
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isApproval, setIsApproval] = useState(false);
  const [isError, setIsError] = useState(false);
  const [isFaded, setIsFaded] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [transcriptSource, setTranscriptSource] = useState<string>("voice");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [approvalCommand, setApprovalCommand] = useState("");
  const [approvalReason, setApprovalReason] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [isHovered, setIsHovered] = useState(false);
  const [mode, setMode] = useState<WindowMode>("ready");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsData, setSettingsData] = useState<Record<string, unknown> | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const pttRef = useRef(false);
  const isListeningRef = useRef(false);
  const isHoveredRef = useRef(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevModeRef = useRef<string | null>(null);

  const isActive =
    isListening || isTranscribing || isThinking || isStreaming || isApproval;

  // Initialize window placement and always-on-top on mount
  useEffect(() => {
    let mounted = true;
    const init = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!mounted) return;
      await initializeWindow();
    };
    init();
    return () => {
      mounted = false;
    };
  }, []);

  // Auto-resize window based on card content (disabled while settings are open).
  useAutoResizeWindow({ cardRef, mode, isStreaming, enabled: !settingsOpen });

  // Resize Tauri window for settings panel.
  useEffect(() => {
    if (settingsOpen) {
      setWindowSizeAndPosition(900, 680);
    } else {
      // Auto-resize will handle returning to compact size.
    }
  }, [settingsOpen]);

  // WebSocket connection — supports both Tauri sidecar mode and dev mode.
  useEffect(() => {
    const ws = new WebSocketClient();
    wsRef.current = ws;

    // Listen for Tauri backend_ready event (production sidecar mode).
    const unlistenReadyPromise = listen<{ url: string }>("backend_ready", (event) => {
      const url = event.payload.url;
      log("backend ready event received with url", url);
      setStatus("Connecting...");
      ws.disconnect();           // close any stale connection
      ws.setUrl(url);
      ws.connect();
    });

    const unlistenErrorPromise = listen<string>("backend_error", (event) => {
      setStatus(`Backend error: ${event.payload}`);
      setIsError(true);
    });

    // In all cases, start connecting to the default dev URL immediately.
    // If backend_ready fires later with a different URL we switch to it.
    ws.connect(DEFAULT_WS_URL);

    ws.onEvent((event: BackendEvent) => {
      log("event", event.type, event);

      switch (event.type) {
        case "hello":
          setStatus("Ready");
          ws.send({ type: "get_settings" });
          break;
        case "state": {
          const ev = event as StateEvent;
          setStatus(ev.message);
          const listening = ev.state === "listening";
          setIsListening(listening);
          isListeningRef.current = listening;
          setIsTranscribing(ev.state === "transcribing");
          setIsThinking(ev.state === "thinking");
          setIsStreaming(ev.state === "streaming_answer");
          setIsApproval(ev.state === "approval_required");
          setIsError(ev.state === "error");
          break;
        }
        case "audio_level": {
          if (!isListeningRef.current) break;
          const ev = event as AudioLevelEvent;
          setLevels((prev) => [...prev.slice(-31), ev.rms]);
          break;
        }
        case "transcript": {
          const ev = event as TranscriptEvent;
          setTranscript(ev.text);
          setTranscriptSource(ev.source ?? "voice");
          setPartialTranscript("");
          break;
        }
        case "partial_transcript": {
          const ev = event as PartialTranscriptEvent;
          setPartialTranscript(ev.text);
          break;
        }
        case "answer_start":
          setAnswerText("");
          setIsStreaming(true);
          break;
        case "answer_delta":
          setAnswerText((prev) => prev + (event as AnswerDeltaEvent).text);
          break;
        case "answer_done":
          setIsStreaming(false);
          break;
        case "command_approval": {
          const ev = event as CommandApprovalEvent;
          setIsApproval(true);
          setApprovalCommand(ev.command);
          setApprovalReason(ev.reason ?? null);
          break;
        }
        case "command_running":
          setIsApproval(false);
          break;
        case "settings": {
          const s = (event as unknown as { settings: Record<string, unknown> }).settings;
          setSettingsData(s);
          setNeedsSetup((s.needs_setup as boolean) ?? false);
          break;
        }
        case "settings_saved": {
          const s = (event as unknown as { settings: Record<string, unknown> }).settings;
          setSettingsData(s);
          setNeedsSetup((s.needs_setup as boolean) ?? false);
          break;
        }
        case "error": {
          const ev = event as ErrorEvent;
          setStatus(`Error: ${ev.message}`);
          setIsError(true);
          break;
        }
      }
    });

    ws.connect();
    return () => {
      ws.disconnect();
      unlistenReadyPromise.then((fn) => fn());
      unlistenErrorPromise.then((fn) => fn());
    };
  }, []);

  // Derive window mode from state.
  useEffect(() => {
    const nextMode = deriveWindowMode(
      isListening,
      isTranscribing,
      isThinking,
      isStreaming,
      isApproval,
      isError,
      Boolean(answerText || isStreaming),
      Boolean(transcript),
      Boolean(partialTranscript)
    );

    if (prevModeRef.current !== nextMode) {
      prevModeRef.current = nextMode;
      setMode(nextMode);
      log("mode changed to", nextMode);
    }
  }, [
    isListening,
    isTranscribing,
    isThinking,
    isStreaming,
    isApproval,
    isError,
    answerText,
    transcript,
    partialTranscript,
  ]);

  // Fade logic
  const startFadeTimer = useCallback(() => {
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    if (isActive || pttRef.current || isHoveredRef.current) return;

    fadeTimerRef.current = setTimeout(() => {
      if (!isActive && !isHoveredRef.current && !pttRef.current) {
        setIsFaded(true);
      }
    }, 6000);
  }, [isActive]);

  const restoreOpacity = useCallback(() => {
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    setIsFaded(false);
  }, []);

  useEffect(() => {
    if (isActive || isHovered || pttRef.current) {
      restoreOpacity();
    } else {
      startFadeTimer();
    }
  }, [isActive, isHovered, startFadeTimer, restoreOpacity]);

  // Helper: skip global handlers when focus is inside a text input.
  const isTextInputTarget = useCallback(
    (target: EventTarget | null): boolean => {
      if (!target) return false;
      const el = target as HTMLElement;
      return (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable
      );
    },
    []
  );

  // PTT key handlers
  const clearSessionState = useCallback(() => {
    setTranscript("");
    setTranscriptSource("voice");
    setPartialTranscript("");
    setAnswerText("");
    setApprovalCommand("");
    setApprovalReason(null);
    setLevels([]);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // PTT (Control key) always works — even when input is focused.
      if (e.key === "Control" && !pttRef.current) {
        pttRef.current = true;
        restoreOpacity();
        clearSessionState();
        wsRef.current?.send({ type: "start_recording" });
        return;
      }

      // Only skip approval keys when typing in a text input.
      if (isTextInputTarget(e.target)) return;

      if (e.key === "y" || e.key === "Y")
        wsRef.current?.send({ type: "approve_command" });
      if (e.key === "n" || e.key === "N")
        wsRef.current?.send({ type: "deny_command" });
    },
    [restoreOpacity, clearSessionState, isTextInputTarget]
  );

  const handleTextSubmit = useCallback(
    (text: string) => {
      clearSessionState();
      restoreOpacity();
      wsRef.current?.send({ type: "submit_text_prompt", text });
    },
    [clearSessionState, restoreOpacity]
  );

  const handleKeyUp = useCallback((e: KeyboardEvent) => {
    if (e.key === "Control" && pttRef.current) {
      pttRef.current = false;
      wsRef.current?.send({ type: "stop_recording" });
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [handleKeyDown, handleKeyUp]);

  useEffect(() => {
    const onClick = () => window.focus();
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    const onBeforeUnload = () => wsRef.current?.disconnect();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return (
    <div
      ref={rootRef}
      className={`app-root ${isFaded ? "faded" : ""} ${
        isListening ? "listening" : ""
      } ${isError ? "error" : ""}`}
      onMouseEnter={() => {
        setIsHovered(true);
        isHoveredRef.current = true;
        restoreOpacity();
      }}
      onMouseLeave={() => {
        setIsHovered(false);
        isHoveredRef.current = false;
        startFadeTimer();
      }}
    >
      <AssistantWindow
        cardRef={cardRef}
        mode={mode}
        status={status}
        isListening={isListening}
        isTranscribing={isTranscribing}
        isThinking={isThinking}
        isStreaming={isStreaming}
        isApproval={isApproval}
        isError={isError}
        transcript={transcript}
        transcriptSource={transcriptSource}
        partialTranscript={partialTranscript}
        answerText={answerText}
        approvalCommand={approvalCommand}
        approvalReason={approvalReason}
        levels={levels}
        needsSetup={needsSetup}
        onApprove={() => wsRef.current?.send({ type: "approve_command" })}
        onDeny={() => wsRef.current?.send({ type: "deny_command" })}
        onTextSubmit={handleTextSubmit}
        onSettingsClick={() => setSettingsOpen(true)}
      />

      {settingsOpen && (
        <SettingsWindow
          ws={wsRef.current}
          initialSettings={settingsData}
          onClose={() => setSettingsOpen(false)}
          onSettingsChanged={() => wsRef.current?.send({ type: "get_settings" })}
        />
      )}
    </div>
  );
};

export default App;
