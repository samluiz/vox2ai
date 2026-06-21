import React, { useCallback, useEffect, useRef, useState } from "react";
import { QUICK_ACTIONS } from "../utils/context";

interface PromptInputProps {
  disabled: boolean;
  onSubmit: (text: string) => void;
  quickActionsEnabled?: boolean;
  onQuickAction?: (prompt: string) => void;
}

const PromptInput: React.FC<PromptInputProps> = ({
  disabled,
  onSubmit,
  quickActionsEnabled = true,
  onQuickAction,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasValue, setHasValue] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const focusInput = () => {
      if (!disabled) inputRef.current?.focus();
    };
    window.addEventListener("vox2ai-focus-prompt", focusInput);
    return () => window.removeEventListener("vox2ai-focus-prompt", focusInput);
  }, [disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const value = inputRef.current?.value.trim();
        if (value) {
          onSubmit(value);
          if (inputRef.current) inputRef.current.value = "";
          setHasValue(false);
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (inputRef.current) {
          if (inputRef.current.value) {
            inputRef.current.value = "";
            setHasValue(false);
          } else {
            inputRef.current.blur();
          }
        }
      }
    },
    [onSubmit]
  );

  return (
    <div
      className={`prompt-shell ${disabled ? "prompt-shell--disabled" : ""} ${
        isFocused ? "prompt-shell--focused" : ""
      }`}
    >
      {quickActionsEnabled && (
        <button
          className="quick-actions-trigger"
          type="button"
          aria-label="Open quick actions"
          title="Quick actions"
          disabled={disabled}
          onClick={() => setMenuOpen((open) => !open)}
        >
          +
        </button>
      )}
      <input
        ref={inputRef}
        className="prompt-input"
        type="text"
        placeholder="Ask or type..."
        disabled={disabled}
        onKeyDown={handleKeyDown}
        onChange={(e) => setHasValue(Boolean(e.currentTarget.value.trim()))}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        autoComplete="off"
        spellCheck={false}
        aria-label="Ask or type"
      />
      {isFocused && hasValue && !disabled && (
        <span className="prompt-submit-hint" aria-hidden="true">
          ↵
        </span>
      )}
      {menuOpen && !disabled && (
        <div className="quick-actions-menu">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.id}
              className="quick-action-item"
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onQuickAction?.(action.prompt);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default PromptInput;
