import React from "react";
import type { BackendConnectionState } from "../api/websocket";

interface ConnectionStatusProps {
  state: BackendConnectionState;
  onReconnect: () => void;
  onOpenSettings: () => void;
}

const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  state,
  onReconnect,
  onOpenSettings,
}) => {
  const isTrying = state === "connecting" || state === "reconnecting" || state === "starting";

  return (
    <div className="connection-status">
      <div className="connection-copy">
        <div className="connection-title">Backend is not running.</div>
        <div className="connection-detail">
          {isTrying ? "Trying to reconnect..." : "Start `vox2ai server` or reconnect."}
        </div>
      </div>
      <div className="connection-actions">
        <button className="btn connection-btn" type="button" onClick={onReconnect}>
          Reconnect
        </button>
        <button className="btn connection-btn" type="button" onClick={onOpenSettings}>
          Open Settings
        </button>
      </div>
    </div>
  );
};

export default ConnectionStatus;
