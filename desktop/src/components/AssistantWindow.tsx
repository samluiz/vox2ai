import React, { MutableRefObject } from "react";
import type { WindowMode } from "../api/windowManager";
import type { BackendConnectionState } from "../api/websocket";
import StatusPill from "./StatusPill";
import Waveform from "./Waveform";
import TranscriptView from "./TranscriptView";
import StreamingAnswer from "./StreamingAnswer";
import CommandApproval from "./CommandApproval";
import CommandResultView from "./CommandResultView";
import PromptInput from "./PromptInput";
import CancelButton from "./CancelButton";
import ConnectionStatus from "./ConnectionStatus";
import type { RecordingActivationMode } from "../utils/shortcut";

interface Props {
  cardRef?: MutableRefObject<HTMLDivElement | null>;
  mode: WindowMode;
  status: string;
  isListening: boolean;
  isTranscribing: boolean;
  isThinking: boolean;
  isStreaming: boolean;
  isApproval: boolean;
  isError: boolean;
  connectionState: BackendConnectionState;
  isBackendConnected: boolean;
  backendRuntimeState?: string;
  backendRuntimeMessage?: string;
  transcript: string;
  transcriptSource?: string;
  partialTranscript: string;
  answerText: string;
  approvalCommand: string;
  approvalReason: string | null;
  approvalWorkingDirectory: string;
  approvalRisk: "low" | "medium" | "high";
  approvalExpectedEffect: string;
  commandResult: {
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  } | null;
  levels: number[];
  needsSetup?: boolean;
  contextIndicator?: string | null;
  pendingClipboardPreview?: string | null;
  quickActionsEnabled?: boolean;
  recordingActivationMode: RecordingActivationMode;
  recordingShortcut: string;
  onApprove: () => void;
  onDeny: () => void;
  onCancel: () => void;
  onReconnect: () => void;
  onTextSubmit: (text: string) => void;
  onQuickAction: (prompt: string) => void;
  onUseClipboard: () => void;
  onIgnoreClipboard: () => void;
  onClearConversation: () => void;
  onSettingsClick: () => void;
  onHideToTray: () => void;
  onStartResize: () => void;
}

const AssistantWindow: React.FC<Props> = ({
  cardRef,
  mode,
  status,
  isListening,
  isTranscribing,
  isThinking,
  isStreaming,
  isApproval,
  isError,
  connectionState,
  isBackendConnected,
  backendRuntimeState,
  backendRuntimeMessage,
  transcript,
  transcriptSource,
  partialTranscript,
  answerText,
  approvalCommand,
  approvalReason,
  approvalWorkingDirectory,
  approvalRisk,
  approvalExpectedEffect,
  commandResult,
  levels,
  needsSetup,
  contextIndicator,
  pendingClipboardPreview,
  quickActionsEnabled,
  recordingActivationMode,
  recordingShortcut,
  onApprove,
  onDeny,
  onCancel,
  onReconnect,
  onTextSubmit,
  onQuickAction,
  onUseClipboard,
  onIgnoreClipboard,
  onClearConversation,
  onSettingsClick,
  onHideToTray,
  onStartResize,
}) => {
  const isDisconnected = !isBackendConnected;
  const isReadyOrDone = mode === "ready";
  const showInput = !isDisconnected && !isListening && !isTranscribing && !isApproval;
  const showBody =
    mode === "thinking" ||
    mode === "answer" ||
    mode === "approval" ||
    mode === "error";
  const showAnswer = Boolean(answerText) || isStreaming;
  const showTranscript = Boolean(transcript);
  const showCommandResult = Boolean(commandResult);
  const showMessages = showTranscript || showAnswer || isApproval || isError || showCommandResult;
  const showIdleCopy = !isDisconnected && isReadyOrDone && !showMessages && !isListening;
  const showSetupCopy = !isDisconnected && needsSetup && !showMessages && !isListening;
  const showErrorMessage = isError && !showAnswer && !isApproval;
  const inputDisabled = isDisconnected || isThinking || isStreaming || isTranscribing || isApproval;
  const showCancelPanel = !isDisconnected && (isListening || isTranscribing || isThinking);
  const recordingCopy = (() => {
    if (isListening) {
      return recordingActivationMode === "toggle-to-talk"
        ? `Recording. Press ${recordingShortcut} again to send.`
        : `Recording. Release ${recordingShortcut} to send.`;
    }
    if (isTranscribing) return "Processing speech...";
    return "Preparing answer...";
  })();
  const readyCopy =
    recordingActivationMode === "toggle-to-talk"
      ? `Ready. Press ${recordingShortcut} to speak or type below.`
      : `Ready. Hold ${recordingShortcut} to speak or type below.`;

  return (
    <div
      ref={cardRef as React.Ref<HTMLDivElement>}
      className={`assistant-card ${isError ? "assistant-card--error" : ""}`}
    >
      <header className="widget-header">
        <div className="header-drag-area" data-tauri-drag-region>
          <div className="brand" data-tauri-drag-region>
            vox2ai
          </div>
        </div>
        <div className="header-actions">
          <StatusPill
            isListening={isListening}
            isTranscribing={isTranscribing}
            isThinking={isThinking}
            isStreaming={isStreaming}
            isApproval={isApproval}
            isError={isError}
            needsSetup={needsSetup}
            connectionState={connectionState}
            isBackendConnected={isBackendConnected}
          />
          <button
            className="settings-gear"
            onClick={(event) => {
              event.stopPropagation();
              onSettingsClick();
            }}
            title="Settings"
            aria-label="Open settings"
            type="button"
          >
            ⚙
          </button>
          <button
            className="hide-to-tray"
            onClick={(event) => {
              event.stopPropagation();
              onHideToTray();
            }}
            title="Hide to tray"
            aria-label="Hide to tray"
            type="button"
          >
            ×
          </button>
        </div>
      </header>

      {isDisconnected && (
        <ConnectionStatus
          state={connectionState}
          backendRuntimeState={backendRuntimeState}
          backendRuntimeMessage={backendRuntimeMessage}
          onReconnect={onReconnect}
          onOpenSettings={onSettingsClick}
        />
      )}

      {isListening && <Waveform levels={levels} />}

      {isListening && partialTranscript && (
        <div className="partial-transcript" title={partialTranscript}>
          <span className="partial-transcript-label">Heard: </span>
          {partialTranscript}
        </div>
      )}

      {showInput && (
        <PromptInput
          disabled={inputDisabled}
          onSubmit={onTextSubmit}
          quickActionsEnabled={quickActionsEnabled}
          onQuickAction={onQuickAction}
        />
      )}

      {contextIndicator && (
        <div className="context-chip">
          <span>{contextIndicator}</span>
          <button type="button" onClick={onClearConversation}>
            Clear
          </button>
        </div>
      )}

      {pendingClipboardPreview && (
        <div className="context-request">
          <div>
            <strong>Clipboard text detected.</strong>
            <span>{pendingClipboardPreview}</span>
          </div>
          <div className="context-actions">
            <button className="btn" type="button" onClick={onUseClipboard}>
              Use
            </button>
            <button className="btn btn-deny" type="button" onClick={onIgnoreClipboard}>
              Ignore
            </button>
          </div>
        </div>
      )}

      {showCancelPanel && (
        <div className="operation-control">
          <span>{recordingCopy}</span>
          <CancelButton onCancel={onCancel} />
        </div>
      )}

      {showIdleCopy && (
        <div className="idle-copy">
          {showSetupCopy
            ? "Needs setup. Open settings to finish."
            : readyCopy}
        </div>
      )}

      {(showBody || showMessages) && (
        <main className="widget-body messages">
          {showTranscript && (
            <TranscriptView text={transcript} source={transcriptSource} />
          )}

          {showAnswer && (
            <StreamingAnswer text={answerText} isStreaming={isStreaming} />
          )}

          {isApproval && (
            <CommandApproval
              command={approvalCommand}
              reason={approvalReason}
              workingDirectory={approvalWorkingDirectory}
              risk={approvalRisk}
              expectedEffect={approvalExpectedEffect}
              onApprove={onApprove}
              onDeny={onDeny}
            />
          )}

          {commandResult && (
            <CommandResultView
              command={commandResult.command}
              exitCode={commandResult.exitCode}
              stdout={commandResult.stdout}
              stderr={commandResult.stderr}
            />
          )}

          {showErrorMessage && (
            <div className="message assistant message-error">
              <span className="message-label">vox2ai</span>
              <div className="message-bubble">{status}</div>
            </div>
          )}
        </main>
      )}

      <button
        className="resize-handle"
        type="button"
        aria-label="Resize widget"
        title="Resize"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onStartResize();
        }}
      />
    </div>
  );
};

export default AssistantWindow;
