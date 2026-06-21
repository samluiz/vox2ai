import React from "react";
import CopyButton from "./CopyButton";

interface CommandApprovalProps {
  command: string;
  reason?: string | null;
  workingDirectory?: string;
  risk?: "low" | "medium" | "high";
  expectedEffect?: string;
  onApprove: () => void;
  onDeny: () => void;
}

const CommandApproval: React.FC<CommandApprovalProps> = ({
  command,
  reason,
  workingDirectory,
  risk = "low",
  expectedEffect,
  onApprove,
  onDeny,
}) => (
  <div className="message assistant approval-message">
    <span className="message-label">vox2ai</span>
    <div className={`message-bubble approval-view approval-risk-${risk}`}>
      <div className="approval-header">
        <div>
          <div className="approval-title">Command approval</div>
          <div className={`risk-pill risk-pill-${risk}`}>{risk} risk</div>
        </div>
        <CopyButton text={command} label="Copy command" title="Copy command" />
      </div>
      <div className="approval-field">
        <span>Command</span>
        <code className="command-text">{command}</code>
      </div>
      {reason && (
        <div className="approval-field">
          <span>Reason</span>
          <p>{reason}</p>
        </div>
      )}
      <div className="approval-field">
        <span>Working directory</span>
        <p>{workingDirectory || "."}</p>
      </div>
      <div className="approval-field">
        <span>Expected effect</span>
        <p>{expectedEffect || "Runs the proposed shell command."}</p>
      </div>
      <div className="approval-actions">
        <button
          className="btn btn-approve"
          onClick={onApprove}
          type="button"
          autoFocus
        >
          Run
        </button>
        <button className="btn btn-deny" onClick={onDeny} type="button">
          Deny
        </button>
      </div>
    </div>
  </div>
);

export default CommandApproval;
