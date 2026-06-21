import { useEffect, useState } from "react";
import type {
  BackendConnectionState,
  WebSocketClient,
} from "../api/websocket";

export function useBackendConnectionState(ws: WebSocketClient | null): {
  connectionState: BackendConnectionState;
  connectionMessage: string;
  isBackendConnected: boolean;
} {
  const [connectionState, setConnectionState] =
    useState<BackendConnectionState>("starting");
  const [connectionMessage, setConnectionMessage] = useState("Starting backend...");

  useEffect(() => {
    if (!ws) {
      setConnectionState("starting");
      setConnectionMessage("Starting backend...");
      return;
    }
    return ws.onConnectionState((state, message) => {
      setConnectionState(state);
      setConnectionMessage(message ?? "");
    });
  }, [ws]);

  return {
    connectionState,
    connectionMessage,
    isBackendConnected: connectionState === "connected",
  };
}
