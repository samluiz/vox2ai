import React from "react";
import type { BackendConnectionState } from "../api/websocket";

interface StatusPillProps {
  isListening?: boolean;
  isTranscribing?: boolean;
  isThinking?: boolean;
  isStreaming?: boolean;
  isApproval?: boolean;
  isError?: boolean;
  needsSetup?: boolean;
  connectionState?: BackendConnectionState;
  isBackendConnected?: boolean;
}

const StatusPill: React.FC<StatusPillProps> = ({
  isListening,
  isTranscribing,
  isThinking,
  isStreaming,
  isApproval,
  isError,
  needsSetup,
  connectionState = "connected",
  isBackendConnected = true,
}) => {
  let label = "Ready";
  let modifier = "ready";

  if (!isBackendConnected) {
    if (connectionState === "starting" || connectionState === "connecting") {
      label = "Connecting";
      modifier = "connecting";
    } else if (connectionState === "reconnecting") {
      label = "Reconnecting";
      modifier = "connecting";
    } else {
      label = "Disconnected";
      modifier = "disconnected";
    }
  } else if (isError) {
    label = "Error";
    modifier = "error";
  } else if (isApproval) {
    label = "Approval needed";
    modifier = "approval";
  } else if (isStreaming) {
    label = "Answering";
    modifier = "streaming";
  } else if (isThinking) {
    label = "Thinking";
    modifier = "thinking";
  } else if (isTranscribing) {
    label = "Transcribing";
    modifier = "transcribing";
  } else if (isListening) {
    label = "Listening";
    modifier = "listening";
  } else if (needsSetup) {
    label = "Needs setup";
    modifier = "setup";
  }

  return (
    <span className={`status-pill status-pill--${modifier}`}>
      <span className="status-dot" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
};

export default StatusPill;
