import type { BackendEvent, FrontendCommand } from "./protocol";

export type EventHandler = (event: BackendEvent) => void;

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url = "ws://127.0.0.1:8765") {
    this.url = url;
  }

  setUrl(url: string) {
    this.url = url;
  }

  connect(url?: string) {
    if (url) this.url = url;
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

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      log("connection failed, scheduling reconnect");
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      log("connected");
      this.send({ type: "ping" });
    };

    this.ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as BackendEvent;
        this.handlers.forEach((h) => h(event));
      } catch {
        log("malformed message", msg.data);
      }
    };

    this.ws.onclose = () => {
      log("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      log("error");
      this.ws?.close();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  send(cmd: FrontendCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      log("sending", cmd.type);
      this.ws.send(JSON.stringify(cmd));
    }
  }

  onEvent(handler: EventHandler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
