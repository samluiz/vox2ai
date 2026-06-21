import React from "react";

interface CommandApprovalProps {
  command: string;
  reason?: string | null;
  onApprove: () => void;
  onDeny: () => void;
}

const CommandApproval: React.FC<CommandApprovalProps> = ({
  command,
  reason,
  onApprove,
  onDeny,
}) => (
  <div className="approval-view">
    <code className="command-text">{command}</code>
    {reason && <div className="approval-reason">{reason}</div>}
    <div className="approval-actions">
      <button
        className="btn btn-approve"
        onClick={onApprove}
        type="button"
        autoFocus
      >
        Approve
      </button>
      <button className="btn btn-deny" onClick={onDeny} type="button">
        Deny
      </button>
    </div>
  </div>
);

export default CommandApproval;
