import React, { useState } from "react";
import { copyText } from "../utils/context";

interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  title?: string;
}

const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  className = "",
  title,
}) => {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      className={`copy-button ${className}`}
      type="button"
      onClick={onCopy}
      title={title ?? label}
      aria-label={title ?? label}
      disabled={!text}
    >
      {copied ? copiedLabel : label}
    </button>
  );
};

export default CopyButton;
