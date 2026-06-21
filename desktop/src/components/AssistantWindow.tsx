import React, { MutableRefObject, Ref } from "react";
import type { WindowMode } from "../api/windowManager";
import StatusPill from "./StatusPill";
import Waveform from "./Waveform";
import TranscriptView from "./TranscriptView";
import StreamingAnswer from "./StreamingAnswer";
import CommandApproval from "./CommandApproval";
import PromptInput from "./PromptInput";

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
  transcript: string;
  transcriptSource?: string;
  partialTranscript: string;
  answerText: string;
  approvalCommand: string;
  approvalReason: string | null;
  levels: number[];
  needsSetup?: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onTextSubmit: (text: string) => void;
  onSettingsClick: () => void;
}

const AssistantWindow: React.FC<Props> = ({
  cardRef,
  mode,
  isListening,
  isTranscribing,
  isThinking,
  isStreaming,
  isApproval,
  isError,
  transcript,
  transcriptSource,
  partialTranscript,
  answerText,
  approvalCommand,
  approvalReason,
  levels,
  needsSetup,
  onApprove,
  onDeny,
  onTextSubmit,
  onSettingsClick,
}) => {
  const isReadyOrDone = mode === "ready" || mode === "readyWithInput";
  const showInput =
    !isListening &&
    !isTranscribing &&
    !isThinking &&
    !isStreaming &&
    !isApproval;
  const showBody =
    mode === "thinking" ||
    mode === "answer" ||
    mode === "approval" ||
    mode === "error";
  const showAnswer = Boolean(answerText) || isStreaming;
  const showTranscript = Boolean(transcript) && !showAnswer;

  return (
    <div
      ref={cardRef as React.Ref<HTMLDivElement>}
      className={`assistant-card ${isError ? "assistant-card--error" : ""}`}
      data-tauri-drag-region
    >
      <header className="widget-header" data-tauri-drag-region>
        <StatusPill
          isListening={isListening}
          isTranscribing={isTranscribing}
          isThinking={isThinking}
          isStreaming={isStreaming}
          isApproval={isApproval}
          isError={isError}
        />
        {isReadyOrDone && !needsSetup && <span className="assistant-hint">Hold Ctrl</span>}
        {needsSetup && (
          <span className="assistant-hint setup-needed" onClick={onSettingsClick}>
            Setup needed ⚙
          </span>
        )}
        <button className="settings-gear" onClick={onSettingsClick} title="Settings">
          ⚙
        </button>
      </header>

      {isListening && <Waveform levels={levels} />}

      {isListening && partialTranscript && (
        <div className="partial-transcript" title={partialTranscript}>
          {partialTranscript}
        </div>
      )}

      {showInput && (
        <PromptInput
          disabled={isThinking || isStreaming || isTranscribing || isApproval}
          onSubmit={onTextSubmit}
        />
      )}

      {showBody && (
        <main className="widget-body">
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
              onApprove={onApprove}
              onDeny={onDeny}
            />
          )}
        </main>
      )}
    </div>
  );
};

export default AssistantWindow;
