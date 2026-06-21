import React from "react";
import type { BackendConnectionState } from "../api/websocket";

interface ConnectionStatusProps {
  state: BackendConnectionState;
  backendRuntimeState?: string;
  backendRuntimeMessage?: string;
  onReconnect: () => void;
  onOpenSettings: () => void;
}

const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  state,
  backendRuntimeState,
  backendRuntimeMessage,
  onReconnect,
  onOpenSettings,
}) => {
  const isTrying = state === "connecting" || state === "reconnecting" || state === "starting";
  const title =
    backendRuntimeState === "starting"
      ? "Backend starting..."
      : backendRuntimeState === "restarting"
        ? "Restarting backend..."
        : backendRuntimeState === "failed"
          ? "Backend failed to start."
          : "Backend is not running.";
  const detail =
    backendRuntimeMessage ||
    (isTrying ? "Trying to reconnect..." : "Start `vox2ai server` or reconnect.");

  return (
    <div className="connection-status">
      <div className="connection-copy">
        <div className="connection-title">{title}</div>
        <div className="connection-detail">{detail}</div>
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
