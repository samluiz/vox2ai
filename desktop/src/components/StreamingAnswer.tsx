import React, { useEffect, useRef } from "react";

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
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [text]);

  if (!text && !isStreaming) return null;

  return (
    <div className="answer-view" ref={ref}>
      <div className="answer-text">
        {text}
        {isStreaming && <span className="answer-cursor">▊</span>}
      </div>
    </div>
  );
};

export default StreamingAnswer;
