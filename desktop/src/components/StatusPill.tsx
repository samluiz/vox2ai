import React from "react";

interface StatusPillProps {
  isListening?: boolean;
  isTranscribing?: boolean;
  isThinking?: boolean;
  isStreaming?: boolean;
  isApproval?: boolean;
  isError?: boolean;
}

const StatusPill: React.FC<StatusPillProps> = ({
  isListening,
  isTranscribing,
  isThinking,
  isStreaming,
  isApproval,
  isError,
}) => {
  let icon: string | null = null;
  let modifier = "";

  if (isError) {
    icon = "✕";
    modifier = "error";
  } else if (isApproval) {
    icon = "!";
    modifier = "approval";
  } else if (isStreaming) {
    icon = "▸";
    modifier = "streaming";
  } else if (isThinking) {
    icon = "⟳";
    modifier = "thinking";
  } else if (isTranscribing) {
    icon = "⋯";
    modifier = "transcribing";
  } else if (isListening) {
    icon = "●";
    modifier = "listening";
  } else {
    icon = "●";
    modifier = "ready";
  }

  return (
    <span className={`status-pill status-pill--${modifier}`}>{icon}</span>
  );
};

export default StatusPill;
