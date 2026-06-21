import type { BackendEvent, FrontendCommand } from "./protocol";

export type EventHandler = (event: BackendEvent) => void;
export type BackendConnectionState =
  | "starting"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed";
export type ConnectionHandler = (
  state: BackendConnectionState,
  message?: string
) => void;

const IS_DEV = import.meta.env?.DEV ?? true;

function log(...args: unknown[]) {
  if (IS_DEV) {
    // eslint-disable-next-line no-console
    console.log("[vox2ai:ws]", ...args);
  }
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private handlers: Set<EventHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionState: BackendConnectionState = "starting";
  private manualClose = false;

  constructor(url = "ws://127.0.0.1:8765") {
    this.url = url;
  }

  setUrl(url: string) {
    this.url = url;
  }

  connect(url?: string) {
    if (url) this.url = url;
    this.manualClose = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // If switching URLs, close any existing connection first.
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    log("connecting to", this.url);
    this.setConnectionState("connecting", "Connecting to backend...");

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      log("connection failed, scheduling reconnect", err);
      this.setConnectionState("failed", "Backend connection failed.");
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      log("connected");
      this.setConnectionState("connected", "Ready");
      this.send({ type: "ping" });
    };

    socket.onmessage = (msg) => {
      if (this.ws !== socket) return;
      try {
        const event = JSON.parse(msg.data) as BackendEvent;
        this.handlers.forEach((h) => h(event));
      } catch {
        log("malformed message", msg.data);
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      log("disconnected");
      this.ws = null;
      this.setConnectionState("disconnected", "Backend disconnected.");
      if (this.manualClose) return;
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.ws !== socket) return;
      log("error");
      this.setConnectionState("failed", "Backend connection failed.");
      socket.close();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.setConnectionState("reconnecting", "Trying to reconnect...");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  send(cmd: FrontendCommand): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      log("sending", cmd.type);
      this.ws.send(JSON.stringify(cmd));
      return true;
    }
    if (!this.manualClose && (!this.ws || this.ws.readyState !== WebSocket.CONNECTING)) {
      this.setConnectionState("disconnected", "Backend disconnected.");
      this.scheduleReconnect();
    }
    return false;
  }

  onEvent(handler: EventHandler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onConnectionState(handler: ConnectionHandler) {
    this.connectionHandlers.add(handler);
    handler(this.connectionState);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  reconnect() {
    this.manualClose = false;
    this.connect();
  }

  isConnected(): boolean {
    return this.connectionState === "connected";
  }

  private setConnectionState(state: BackendConnectionState, message?: string) {
    this.connectionState = state;
    this.connectionHandlers.forEach((h) => h(state, message));
  }

  disconnect() {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try { this.ws.close(); } catch { /* ignore */ }
    }
    this.ws = null;
    this.setConnectionState("disconnected", "Backend disconnected.");
  }
}
