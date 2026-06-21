import React from "react";
import CopyButton from "./CopyButton";

interface TranscriptViewProps {
  text: string;
  source?: string;
}

const TranscriptView: React.FC<TranscriptViewProps> = ({ text, source }) => {
  if (!text) return null;
  const sourceKind = source === "text" ? "text" : "voice";
  return (
    <div className={`message user message--${sourceKind}`}>
      <div className="message-meta">
        <CopyButton text={text} className="message-copy" title="Copy prompt" />
        <span className="message-label">You</span>
      </div>
      <div className="message-bubble transcript-view">
        <span className="transcript-text">{text}</span>
      </div>
    </div>
  );
};

export default TranscriptView;
