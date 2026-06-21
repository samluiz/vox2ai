import React, { useEffect, useState, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { WebSocketClient } from "./api/websocket";
import type {
  BackendEvent,
  StateEvent,
  AudioLevelEvent,
  TranscriptEvent,
  PartialTranscriptEvent,
  AnswerDeltaEvent,
  CommandApprovalEvent,
  CommandResultEvent,
  ErrorEvent,
} from "./api/protocol";
import {
  initializeWindow,
  applyAlwaysOnTop,
  applyFocus,
  deriveWindowMode,
  hideWindowToTray,
  setLargeOverlayWindow,
  type WindowMode,
} from "./api/windowManager";
import { useAutoResizeWindow } from "./hooks/useAutoResizeWindow";
import { useBackendConnectionState } from "./hooks/useBackendConnectionState";
import { useRecordingShortcut } from "./hooks/useRecordingShortcut";
import { useWindowResizePersistence } from "./hooks/useWindowResizePersistence";
import AssistantWindow from "./components/AssistantWindow";
import SettingsWindow from "./components/SettingsWindow";
import DiagnosticsWindow from "./components/DiagnosticsWindow";
import OnboardingWindow from "./components/OnboardingWindow";
import type { RecordingActivationMode } from "./utils/shortcut";
import {
  previewText,
  readClipboardText,
  shouldUseClipboardAutomatically,
  truncateContextText,
  type ActiveWindowContext,
  type PromptContext,
} from "./utils/context";

const IS_DEV = import.meta.env?.DEV ?? true;

function log(...args: unknown[]) {
  if (IS_DEV) {
    // eslint-disable-next-line no-console
    console.log("[vox2ai:app]", ...args);
  }
}

const DEFAULT_WS_URL = "ws://127.0.0.1:8765";

type BackendRuntimeState = "starting" | "running" | "restarting" | "stopped" | "failed";

interface BackendRuntimePayload {
  state: BackendRuntimeState;
  message?: string;
  attempts?: number;
  url?: string | null;
  log_path?: string;
}

interface ActivationRuntimeStatus {
  registered?: boolean;
  shortcut?: string | null;
  behavior?: string;
  error?: string | null;
  global_shortcut_supported?: boolean;
  platform?: string;
  message?: string | null;
  start_at_login_supported?: boolean;
  start_at_login_enabled?: boolean;
}

interface GlobalShortcutPayload {
  shortcut: string;
  behavior: "show-widget" | "show-and-focus-input" | "show-and-record" | "toggle-widget";
}

const App: React.FC = () => {
  const wsRef = useRef<WebSocketClient | null>(null);
  const [wsClient, setWsClient] = useState<WebSocketClient | null>(null);
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
  const [approvalWorkingDirectory, setApprovalWorkingDirectory] = useState("");
  const [approvalRisk, setApprovalRisk] = useState<"low" | "medium" | "high">("low");
  const [approvalExpectedEffect, setApprovalExpectedEffect] = useState("");
  const [commandResult, setCommandResult] = useState<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  } | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [isHovered, setIsHovered] = useState(false);
  const [mode, setMode] = useState<WindowMode>("ready");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsData, setSettingsData] = useState<Record<string, unknown> | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [manualWindowSize, setManualWindowSize] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsData, setDiagnosticsData] = useState<Record<string, unknown> | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [backendRuntime, setBackendRuntime] = useState<BackendRuntimePayload>({
    state: "stopped",
    message: "Backend stopped.",
  });
  const [activationRuntimeStatus, setActivationRuntimeStatus] =
    useState<ActivationRuntimeStatus | null>(null);
  const [contextIndicator, setContextIndicator] = useState<string | null>(null);
  const [pendingClipboard, setPendingClipboard] = useState<{
    prompt: string;
    text: string;
    preview: string;
  } | null>(null);
  const largeOverlayOpen = settingsOpen || diagnosticsOpen || onboardingOpen;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const isListeningRef = useRef(false);
  const isHoveredRef = useRef(false);
  const largeOverlayOpenRef = useRef(false);
  const startHiddenAppliedRef = useRef(false);
  const settingsReceivedRef = useRef(false);
  const compactInitRef = useRef(false);
  const pendingStartRecordingRef = useRef(false);
  const wasStreamingRef = useRef(false);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevModeRef = useRef<string | null>(null);
  const isActiveRef = useRef(false);
  const { connectionState, isBackendConnected } = useBackendConnectionState(wsClient);

  const isActive =
    isListening || isTranscribing || isThinking || isStreaming || isApproval;

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);
  const isCancellable = isListening || isTranscribing || isThinking || isStreaming;
  const recording = (settingsData?.recording as Record<string, unknown> | undefined) ?? {};
  const recordingActivationMode =
    ((recording.activation_mode as string) ?? "hold-to-talk") as RecordingActivationMode;
  const recordingShortcut = (recording.shortcut as string) ?? "Ctrl";
  const desktopWindowSettings =
    (settingsData?.desktop_window as
      | {
          user_resizable?: boolean;
          remember_size?: boolean;
          manual_size?: boolean;
          width?: number;
          height?: number;
          always_on_top?: boolean;
          auto_hide_after_answer?: boolean;
          auto_hide_delay_ms?: number;
          remember_position?: boolean;
          summon_position?: string;
          fade_after_seconds?: number;
          active_opacity?: number;
          inactive_opacity?: number;
        }
      | undefined) ?? null;
  const contextSettings =
    (settingsData?.context as
      | {
          clipboard_enabled?: boolean;
          clipboard_auto_detect?: boolean;
          max_clipboard_chars?: number;
          active_window_enabled?: boolean;
        }
      | undefined) ?? {};
  const quickActionsEnabled = Boolean(
    ((settingsData?.quick_actions as Record<string, unknown> | undefined)?.enabled as boolean | undefined) ??
      true
  );

  const applyRuntimeSettings = useCallback((s: Record<string, unknown>) => {
    const general = (s.general as Record<string, unknown> | undefined) ?? {};
    const activation = (s.activation as Record<string, unknown> | undefined) ?? {};
    const desktop = (s.desktop as Record<string, unknown> | undefined) ?? {};
    invoke("configure_runtime_settings", {
      settings: {
        minimize_to_tray: general.minimize_to_tray,
        start_at_login: general.start_at_login ?? general.launch_at_login,
        auto_restart_backend: desktop.auto_restart_backend,
        global_shortcut: activation.global_shortcut,
        shortcut_behavior: activation.shortcut_behavior,
      },
    })
      .then((status) => setActivationRuntimeStatus(status as ActivationRuntimeStatus))
      .catch((err) => {
        setActivationRuntimeStatus({
          registered: false,
          error: String(err),
        });
      });
  }, []);

  useEffect(() => {
    largeOverlayOpenRef.current = largeOverlayOpen;
  }, [largeOverlayOpen]);

  // Apply opacity CSS variables from settings.
  useEffect(() => {
    const root = document.documentElement;
    if (desktopWindowSettings?.active_opacity !== undefined) {
      root.style.setProperty("--active-opacity", String(desktopWindowSettings.active_opacity));
    }
    if (desktopWindowSettings?.inactive_opacity !== undefined) {
      root.style.setProperty("--inactive-opacity", String(desktopWindowSettings.inactive_opacity));
    }
  }, [desktopWindowSettings?.active_opacity, desktopWindowSettings?.inactive_opacity]);

  // Initialize always-on-top and focus on mount. Defer sizing until
  // settings arrive to avoid a compact→large overlay blink.
  useEffect(() => {
    let mounted = true;
    const init = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (!mounted) return;
      await applyAlwaysOnTop();
      await applyFocus();
    };
    init();
    return () => {
      mounted = false;
    };
  }, []);

  // Deferred compact sizing: run once after settings arrive and no large overlay is open.
  useEffect(() => {
    if (settingsData && !onboardingOpen && !compactInitRef.current) {
      compactInitRef.current = true;
      initializeWindow();
    }
  }, [settingsData, onboardingOpen]);

  const startUserResize = useWindowResizePersistence({
    settings: desktopWindowSettings,
    enabled: !largeOverlayOpen,
    settingsOpen,
    restoreSavedSize: false,
    onManualSizeChange: setManualWindowSize,
    onPersistSize: (width, height) => {
      wsRef.current?.send({
        type: "update_settings",
        settings: {
          desktop_window: {
            ...(desktopWindowSettings ?? {}),
            manual_size: true,
            width,
            height,
          },
        },
      });
    },
  });

  // Auto-resize window based on compact card content.
  useAutoResizeWindow({
    cardRef,
    mode,
    isStreaming,
    enabled: !largeOverlayOpen,
  });

  // Larger panels are separate desktop surfaces and should not inherit OSD sizing.
  useEffect(() => {
    if (largeOverlayOpen) {
      setLargeOverlayWindow();
    }
  }, [largeOverlayOpen]);

  // WebSocket connection — supports both Tauri sidecar mode and dev mode.
  useEffect(() => {
    const ws = new WebSocketClient();
    wsRef.current = ws;
    setWsClient(ws);

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

    const unlistenBackendEvent = ws.onEvent((event: BackendEvent) => {
      log("event", event.type, event);

      switch (event.type) {
        case "hello":
          setStatus("Ready");
          setIsError(false);
          setIsListening(false);
          isListeningRef.current = false;
          setIsTranscribing(false);
          setIsThinking(false);
          setIsStreaming(false);
          setIsApproval(false);
          setTranscript("");
          setTranscriptSource("voice");
          setPartialTranscript("");
          setAnswerText("");
          setApprovalCommand("");
          setApprovalReason(null);
          setApprovalWorkingDirectory("");
          setApprovalRisk("low");
          setApprovalExpectedEffect("");
          setCommandResult(null);
          setLevels([]);
          ws.send({ type: "get_settings" });
          break;
        case "backend_status": {
          const ev = event as { status?: string; message?: string };
          setStatus(ev.message ?? "Ready");
          if (ev.status === "connected") {
            setIsError(false);
          }
          break;
        }
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
          setIsError((current) => ev.state === "error" || (current && ev.state === "ready"));
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
          setApprovalWorkingDirectory(ev.working_directory ?? ".");
          setApprovalRisk(ev.risk ?? "low");
          setApprovalExpectedEffect(ev.expected_effect ?? "");
          break;
        }
        case "command_running":
          setIsApproval(false);
          break;
        case "command_result": {
          const ev = event as CommandResultEvent;
          setCommandResult({
            command: ev.command,
            exitCode: ev.exit_code,
            stdout: ev.stdout,
            stderr: ev.stderr,
          });
          break;
        }
        case "settings": {
          const s = (event as unknown as { settings: Record<string, unknown> }).settings;
          setSettingsData(s);
          applyRuntimeSettings(s);
          const setupNeeded = (s.needs_setup as boolean) ?? false;
          const onboardingCompleted = Boolean(
            (s.onboarding as Record<string, unknown> | undefined)?.completed
          );
          setNeedsSetup(setupNeeded);
          setOnboardingOpen(setupNeeded || !onboardingCompleted);
          if (
            !startHiddenAppliedRef.current &&
            Boolean((s.general as Record<string, unknown> | undefined)?.start_hidden) &&
            !setupNeeded
          ) {
            startHiddenAppliedRef.current = true;
            hideWindowToTray();
          }
          setManualWindowSize(
            Boolean((s.desktop_window as Record<string, unknown> | undefined)?.manual_size)
          );
          const aos = (s.desktop_window as Record<string, unknown> | undefined)
            ?.always_on_top;
          if (aos !== undefined) {
            applyAlwaysOnTop(Boolean(aos));
          }
          break;
        }
        case "settings_saved": {
          const s = (event as unknown as { settings: Record<string, unknown> }).settings;
          setSettingsData(s);
          applyRuntimeSettings(s);
          const setupNeeded = (s.needs_setup as boolean) ?? false;
          const onboardingCompleted = Boolean(
            (s.onboarding as Record<string, unknown> | undefined)?.completed
          );
          setNeedsSetup(setupNeeded);
          setOnboardingOpen(setupNeeded || !onboardingCompleted);
          setManualWindowSize(
            Boolean((s.desktop_window as Record<string, unknown> | undefined)?.manual_size)
          );
          const aos = (s.desktop_window as Record<string, unknown> | undefined)
            ?.always_on_top;
          if (aos !== undefined) {
            applyAlwaysOnTop(Boolean(aos));
          }
          ws.send({ type: "get_settings" });
          break;
        }
        case "diagnostics":
          setDiagnosticsData(
            (event as unknown as { diagnostics: Record<string, unknown> }).diagnostics
          );
          break;
        case "conversation_cleared":
          setContextIndicator(null);
          setStatus("Conversation cleared.");
          break;
        case "operation_cancelled":
          setStatus("Cancelled.");
          clearSessionState();
          setIsListening(false);
          isListeningRef.current = false;
          setIsTranscribing(false);
          setIsThinking(false);
          setIsStreaming(false);
          break;
        case "error": {
          const ev = event as ErrorEvent;
          setStatus(`Error: ${ev.message}`);
          setIsError(true);
          break;
        }
      }
    });

    // In all cases, start connecting to the default dev URL immediately.
    // If backend_ready fires later with a different URL we switch to it.
    ws.connect(DEFAULT_WS_URL);

    return () => {
      unlistenBackendEvent();
      ws.disconnect();
      setWsClient(null);
      unlistenReadyPromise.then((fn) => fn());
      unlistenErrorPromise.then((fn) => fn());
    };
  }, [applyRuntimeSettings]);

  useEffect(() => {
    if (isBackendConnected) return;
    setIsListening(false);
    isListeningRef.current = false;
    setIsTranscribing(false);
    setIsThinking(false);
    setIsStreaming(false);
    setIsApproval(false);
  }, [isBackendConnected]);

  useEffect(() => {
    if (isBackendConnected) {
      if (disconnectRestartTimerRef.current) {
        clearTimeout(disconnectRestartTimerRef.current);
        disconnectRestartTimerRef.current = null;
      }
      return;
    }
    const autoRestart =
      ((settingsData?.desktop as Record<string, unknown> | undefined)
        ?.auto_restart_backend as boolean | undefined) ?? true;
    const disconnected =
      connectionState === "disconnected" || connectionState === "failed";
    if (!autoRestart || !disconnected || backendRuntime.state !== "running") return;
    if (disconnectRestartTimerRef.current) return;

    disconnectRestartTimerRef.current = setTimeout(() => {
      disconnectRestartTimerRef.current = null;
      setStatus("Restarting backend...");
      invoke("restart_backend").catch((err) => log("restart_backend unavailable", err));
    }, 800);
  }, [backendRuntime.state, connectionState, isBackendConnected, settingsData]);

  useEffect(() => {
    invoke("get_activation_runtime_status")
      .then((status) => setActivationRuntimeStatus(status as ActivationRuntimeStatus))
      .catch((err) =>
        setActivationRuntimeStatus({
          registered: false,
          error: String(err),
        })
      );
    invoke("get_backend_runtime_status")
      .then((payload) => setBackendRuntime(payload as BackendRuntimePayload))
      .catch(() => undefined);
  }, []);

  // Derive window mode from state.
  useEffect(() => {
    const nextMode = deriveWindowMode(
      isListening,
      isTranscribing,
      isThinking,
      isStreaming,
      isApproval,
      isError || !isBackendConnected,
      Boolean(answerText || isStreaming),
      Boolean(transcript),
      Boolean(partialTranscript)
    );

    const effectiveMode = isBackendConnected ? nextMode : "disconnected";

    if (prevModeRef.current !== effectiveMode) {
      prevModeRef.current = effectiveMode;
      setMode(effectiveMode);
      log("mode changed to", effectiveMode);
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
    isBackendConnected,
  ]);

  // Fade logic
  const startFadeTimer = useCallback(() => {
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    if (isActiveRef.current || isHoveredRef.current) return;

    const fadeAfterMs =
      (desktopWindowSettings?.fade_after_seconds ?? 8) * 1000;

    fadeTimerRef.current = setTimeout(() => {
      if (!isActiveRef.current && !isHoveredRef.current) {
        setIsFaded(true);
      }
    }, fadeAfterMs);
  }, [desktopWindowSettings?.fade_after_seconds]);

  const restoreOpacity = useCallback(() => {
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    setIsFaded(false);
  }, []);

  useEffect(() => {
    if (isActive || isHovered) {
      restoreOpacity();
    } else {
      startFadeTimer();
    }
  }, [isActive, isHovered, startFadeTimer, restoreOpacity]);

  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true;
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
        autoHideTimerRef.current = null;
      }
      return;
    }

    if (
      wasStreamingRef.current &&
      answerText &&
      desktopWindowSettings?.auto_hide_after_answer
    ) {
      wasStreamingRef.current = false;
      const delay = desktopWindowSettings.auto_hide_delay_ms ?? 2500;
      autoHideTimerRef.current = setTimeout(() => {
        hideWindowToTray();
      }, delay);
    }

    return () => {
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
        autoHideTimerRef.current = null;
      }
    };
  }, [
    answerText,
    desktopWindowSettings?.auto_hide_after_answer,
    desktopWindowSettings?.auto_hide_delay_ms,
    isStreaming,
  ]);

  const clearSessionState = useCallback(() => {
    setTranscript("");
    setTranscriptSource("voice");
    setPartialTranscript("");
    setAnswerText("");
    setApprovalCommand("");
    setApprovalReason(null);
    setApprovalWorkingDirectory("");
    setApprovalRisk("low");
    setApprovalExpectedEffect("");
    setCommandResult(null);
    setLevels([]);
  }, []);

  const startRecording = useCallback(() => {
    if (!isBackendConnected) return;
    restoreOpacity();
    clearSessionState();
    const sent = wsRef.current?.send({ type: "start_recording" }) ?? false;
    if (sent) {
      setIsError(false);
      setStatus("Listening...");
      setIsListening(true);
      isListeningRef.current = true;
    }
  }, [clearSessionState, isBackendConnected, restoreOpacity]);

  useEffect(() => {
    if (!isBackendConnected || !pendingStartRecordingRef.current) return;
    pendingStartRecordingRef.current = false;
    startRecording();
  }, [isBackendConnected, startRecording]);

  const stopRecording = useCallback(() => {
    if (!isBackendConnected) return;
    const sent = wsRef.current?.send({ type: "stop_recording" }) ?? false;
    if (sent) {
      setStatus("Transcribing...");
      setIsListening(false);
      isListeningRef.current = false;
      setIsTranscribing(true);
    }
  }, [isBackendConnected]);

  const cancelCurrentOperation = useCallback(() => {
    if (!isBackendConnected) return;
    wsRef.current?.send({ type: "cancel_current_operation" });
    clearSessionState();
    setIsListening(false);
    isListeningRef.current = false;
    setIsTranscribing(false);
    setIsThinking(false);
    setIsStreaming(false);
  }, [clearSessionState, isBackendConnected]);

  const buildActiveWindowContext = useCallback(async (): Promise<ActiveWindowContext | null> => {
    if (!(contextSettings.active_window_enabled ?? true)) return null;
    try {
      return (await invoke("get_active_window_context")) as ActiveWindowContext | null;
    } catch {
      return null;
    }
  }, [contextSettings.active_window_enabled]);

  const submitPromptWithContext = useCallback(
    async (text: string, context: PromptContext = {}, indicator: string | null = null) => {
      if (!isBackendConnected) return;
      const activeWindow = await buildActiveWindowContext();
      const finalContext: PromptContext = {
        ...context,
        ...(activeWindow ? { active_window: activeWindow } : {}),
      };
      const labels: string[] = [];
      if (indicator) labels.push(indicator);
      if (activeWindow?.title || activeWindow?.app) labels.push("Using active window");

      const sent =
        wsRef.current?.send({
          type: "submit_text_prompt",
          text,
          context: finalContext as Record<string, unknown>,
        }) ?? false;
      if (!sent) {
        setStatus("Backend disconnected.");
        setIsError(true);
        return;
      }
      clearSessionState();
      setTranscript(text);
      setTranscriptSource("text");
      setContextIndicator(labels.length > 0 ? labels.join(" · ") : null);
      setIsError(false);
      setStatus("Thinking...");
      setIsThinking(true);
      restoreOpacity();
    },
    [buildActiveWindowContext, clearSessionState, isBackendConnected, restoreOpacity]
  );

  const handleTextSubmit = useCallback(
    async (text: string) => {
      if (!isBackendConnected) return;
      const clipboardEnabled = contextSettings.clipboard_enabled ?? true;
      const maxClipboardChars = contextSettings.max_clipboard_chars ?? 8000;
      if (!clipboardEnabled) {
        await submitPromptWithContext(text);
        return;
      }
      if (!(contextSettings.clipboard_auto_detect ?? true)) {
        await submitPromptWithContext(text);
        return;
      }
      const clipboard = await readClipboardText();
      if (clipboard && shouldUseClipboardAutomatically(text)) {
        await submitPromptWithContext(
          text,
          { clipboard: truncateContextText(clipboard, maxClipboardChars) },
          "Using clipboard"
        );
        return;
      }
      await submitPromptWithContext(text);
    },
    [
      contextSettings.clipboard_enabled,
      contextSettings.clipboard_auto_detect,
      contextSettings.max_clipboard_chars,
      isBackendConnected,
      submitPromptWithContext,
    ]
  );

  const handleQuickAction = useCallback(
    async (prompt: string) => {
      const clipboard = await readClipboardText();
      const maxClipboardChars = contextSettings.max_clipboard_chars ?? 8000;
      if (clipboard && (contextSettings.clipboard_enabled ?? true)) {
        setPendingClipboard({
          prompt,
          text: truncateContextText(clipboard, maxClipboardChars),
          preview: previewText(clipboard),
        });
        return;
      }
      await submitPromptWithContext(prompt);
    },
    [
      contextSettings.clipboard_enabled,
      contextSettings.max_clipboard_chars,
      submitPromptWithContext,
    ]
  );

  useRecordingShortcut({
    enabled: isBackendConnected && !largeOverlayOpen,
    shortcut: recordingShortcut,
    activationMode: recordingActivationMode,
    isListening,
    isCancellable,
    onStart: startRecording,
    onStop: stopRecording,
    onCancel: cancelCurrentOperation,
  });

  useEffect(() => {
    const isTextInputTarget = (target: EventTarget | null): boolean => {
      if (!target) return false;
      const el = target as HTMLElement;
      return (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.isContentEditable ||
        Boolean(el.closest("[data-shortcut-recorder='true']"))
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (largeOverlayOpen) return;
      if (isTextInputTarget(e.target)) return;

      if (e.key === "y" || e.key === "Y")
        wsRef.current?.send({ type: "approve_command" });
      if (e.key === "n" || e.key === "N")
        wsRef.current?.send({ type: "deny_command" });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [largeOverlayOpen]);

  const handleReconnect = useCallback(() => {
    setStatus("Reconnecting...");
    invoke("restart_backend").catch((err) => log("restart_backend unavailable", err));
    wsRef.current?.reconnect();
  }, []);

  const focusPromptInput = useCallback(() => {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("vox2ai-focus-prompt"));
    }, 80);
  }, []);

  const handleGlobalActivation = useCallback(
    (payload: GlobalShortcutPayload) => {
      restoreOpacity();
      if (payload.behavior === "toggle-widget") return;

      if (!isBackendConnected) {
        pendingStartRecordingRef.current = payload.behavior === "show-and-record";
        handleReconnect();
        if (payload.behavior === "show-and-focus-input") focusPromptInput();
        return;
      }

      if (payload.behavior === "show-and-focus-input") {
        focusPromptInput();
      } else if (payload.behavior === "show-and-record") {
        startRecording();
      }
    },
    [focusPromptInput, handleReconnect, isBackendConnected, restoreOpacity, startRecording]
  );

  const openDiagnostics = useCallback(() => {
    setDiagnosticsOpen(true);
    wsRef.current?.send({ type: "get_diagnostics" });
  }, []);

  const clearConversation = useCallback(() => {
    wsRef.current?.send({ type: "clear_conversation" });
  }, []);

  useEffect(() => {
    const settingsPromise = listen("tray_open_settings", () => {
      setSettingsOpen(true);
    });
    const diagnosticsPromise = listen("tray_open_diagnostics", () => {
      openDiagnostics();
    });
    const startRecordingPromise = listen("tray_start_recording", () => {
      if (isBackendConnected) {
        startRecording();
      } else {
        pendingStartRecordingRef.current = true;
        handleReconnect();
      }
    });
    const globalShortcutPromise = listen<GlobalShortcutPayload>(
      "global_shortcut_pressed",
      (event) => {
        handleGlobalActivation(event.payload);
      }
    );
    const backendRuntimePromise = listen<BackendRuntimePayload>(
      "backend_runtime_state",
      (event) => {
        const payload = event.payload;
        setBackendRuntime(payload);
        if (payload.state === "starting") {
          setStatus(payload.message || "Backend starting...");
        } else if (payload.state === "restarting") {
          setStatus(payload.message || "Restarting backend...");
        } else if (payload.state === "failed") {
          setIsError(true);
          setStatus(payload.message || "Backend failed to start.");
        }
      }
    );
    const restartingPromise = listen("backend_restarting", () => {
      setStatus("Restarting backend...");
    });
    return () => {
      settingsPromise.then((fn) => fn());
      diagnosticsPromise.then((fn) => fn());
      startRecordingPromise.then((fn) => fn());
      globalShortcutPromise.then((fn) => fn());
      backendRuntimePromise.then((fn) => fn());
      restartingPromise.then((fn) => fn());
    };
  }, [handleGlobalActivation, handleReconnect, isBackendConnected, openDiagnostics, startRecording]);

  useEffect(() => {
    const onBeforeUnload = () => wsRef.current?.disconnect();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const usePendingClipboard = useCallback(() => {
    if (!pendingClipboard) return;
    const { prompt, text } = pendingClipboard;
    setPendingClipboard(null);
    submitPromptWithContext(prompt, { clipboard: text }, "Using clipboard");
  }, [pendingClipboard, submitPromptWithContext]);

  const ignorePendingClipboard = useCallback(() => {
    if (!pendingClipboard) return;
    const { prompt } = pendingClipboard;
    setPendingClipboard(null);
    submitPromptWithContext(prompt);
  }, [pendingClipboard, submitPromptWithContext]);

  return (
    <div
      ref={rootRef}
      className={`app-root ${isFaded ? "faded" : ""} ${
        isListening ? "listening" : ""
      } ${isError ? "error" : ""} ${largeOverlayOpen ? "large-overlay-open" : ""} ${
        manualWindowSize ? "no-transition" : ""
      }`}
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
      {!largeOverlayOpen && (
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
          connectionState={connectionState}
          isBackendConnected={isBackendConnected}
          backendRuntimeState={backendRuntime.state}
          backendRuntimeMessage={backendRuntime.message}
          transcript={transcript}
          transcriptSource={transcriptSource}
          partialTranscript={partialTranscript}
          answerText={answerText}
          approvalCommand={approvalCommand}
          approvalReason={approvalReason}
          approvalWorkingDirectory={approvalWorkingDirectory}
          approvalRisk={approvalRisk}
          approvalExpectedEffect={approvalExpectedEffect}
          commandResult={commandResult}
          levels={levels}
          needsSetup={needsSetup}
          contextIndicator={contextIndicator}
          pendingClipboardPreview={pendingClipboard?.preview ?? null}
          quickActionsEnabled={quickActionsEnabled}
          recordingActivationMode={recordingActivationMode}
          recordingShortcut={recordingShortcut}
          onApprove={() => wsRef.current?.send({ type: "approve_command" })}
          onDeny={() => wsRef.current?.send({ type: "deny_command" })}
          onCancel={cancelCurrentOperation}
          onReconnect={handleReconnect}
          onTextSubmit={handleTextSubmit}
          onQuickAction={handleQuickAction}
          onUseClipboard={usePendingClipboard}
          onIgnoreClipboard={ignorePendingClipboard}
          onClearConversation={clearConversation}
          onSettingsClick={() => setSettingsOpen(true)}
          onHideToTray={hideWindowToTray}
          onStartResize={startUserResize}
        />
      )}

      {settingsOpen && (
        <SettingsWindow
          ws={wsRef.current}
          initialSettings={settingsData}
          backendConnectionState={connectionState}
          backendRuntimeState={backendRuntime.state}
          activationRuntimeStatus={activationRuntimeStatus}
          onOpenDiagnostics={openDiagnostics}
          onRestartBackend={handleReconnect}
          onClose={() => setSettingsOpen(false)}
          onSettingsChanged={() => wsRef.current?.send({ type: "get_settings" })}
        />
      )}

      {diagnosticsOpen && (
        <DiagnosticsWindow
          ws={wsRef.current}
          diagnostics={diagnosticsData}
          backendConnectionState={connectionState}
          onRestartBackend={handleReconnect}
          onClose={() => setDiagnosticsOpen(false)}
        />
      )}

      {onboardingOpen && (
        <OnboardingWindow
          ws={wsRef.current}
          initialSettings={settingsData}
          onClose={() => {
            setOnboardingOpen(false);
            wsRef.current?.send({ type: "get_settings" });
          }}
        />
      )}
    </div>
  );
};

export default App;
