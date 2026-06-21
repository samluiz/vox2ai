import React, { useEffect, useRef } from "react";
import CopyButton from "./CopyButton";

interface StreamingAnswerProps {
  text: string;
  isStreaming: boolean;
}

const StreamingAnswer: React.FC<StreamingAnswerProps> = ({
  text,
  isStreaming,
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      const scrollParent = ref.current.closest(".messages") as HTMLElement | null;
      const target = scrollParent ?? ref.current;
      target.scrollTop = target.scrollHeight;
    }
  }, [text]);

  if (!text && !isStreaming) return null;

  return (
    <div className="message assistant">
      <div className="message-meta">
        <span className="message-label">vox2ai</span>
        <CopyButton text={text} className="message-copy" title="Copy answer" />
      </div>
      <div className="message-bubble">
        <div className="answer-view" ref={ref}>
          <div className="answer-text">
            {text}
            {isStreaming && <span className="answer-cursor">▊</span>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default StreamingAnswer;
