import React from "react";

interface TranscriptViewProps {
  text: string;
  source?: string;
}

const TranscriptView: React.FC<TranscriptViewProps> = ({ text, source }) => {
  if (!text) return null;
  const label = source === "text" ? "You:" : "You said:";
  return (
    <div className="transcript-view">
      <span className="transcript-label">{label}</span>{" "}
      <span className="transcript-text">{text}</span>
    </div>
  );
};

export default TranscriptView;
