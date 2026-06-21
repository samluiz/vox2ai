import React from "react";
import CopyButton from "./CopyButton";

interface CommandResultViewProps {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

const CommandResultView: React.FC<CommandResultViewProps> = ({
  command,
  exitCode,
  stdout,
  stderr,
}) => {
  const all = [
    `$ ${command}`,
    `exit code: ${exitCode}`,
    stdout ? `stdout:\n${stdout}` : "",
    stderr ? `stderr:\n${stderr}` : "",
  ].filter(Boolean).join("\n\n");

  return (
    <div className="message assistant command-result-message">
      <span className="message-label">vox2ai</span>
      <div className="message-bubble command-result-view">
        <div className="command-result-header">
          <span>Command result</span>
          <span className={exitCode === 0 ? "result-ok" : "result-fail"}>
            exit {exitCode}
          </span>
        </div>
        {stdout && (
          <pre className="command-output">
            <code>{stdout}</code>
          </pre>
        )}
        {stderr && (
          <pre className="command-output command-output-stderr">
            <code>{stderr}</code>
          </pre>
        )}
        <div className="approval-actions">
          <CopyButton text={stdout} label="Copy stdout" title="Copy stdout" />
          <CopyButton text={stderr} label="Copy stderr" title="Copy stderr" />
          <CopyButton text={all} label="Copy all" title="Copy command result" />
        </div>
      </div>
    </div>
  );
};

export default CommandResultView;
