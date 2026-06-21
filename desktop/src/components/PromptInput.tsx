import React, { useCallback, useRef } from "react";

interface PromptInputProps {
  disabled: boolean;
  onSubmit: (text: string) => void;
}

const PromptInput: React.FC<PromptInputProps> = ({ disabled, onSubmit }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const value = inputRef.current?.value.trim();
        if (value) {
          onSubmit(value);
          if (inputRef.current) inputRef.current.value = "";
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (inputRef.current) {
          if (inputRef.current.value) {
            inputRef.current.value = "";
          } else {
            inputRef.current.blur();
          }
        }
      }
    },
    [onSubmit]
  );

  return (
    <input
      ref={inputRef}
      className="prompt-input"
      type="text"
      placeholder="Ask or type..."
      disabled={disabled}
      onKeyDown={handleKeyDown}
      autoComplete="off"
      spellCheck={false}
    />
  );
};

export default PromptInput;
