import React, { useMemo } from "react";
import type { WebSocketClient } from "../api/websocket";
import type { BackendConnectionState } from "../api/websocket";
import CopyButton from "./CopyButton";
import { useLargeOverlayWindow } from "../hooks/useLargeOverlayWindow";

interface DiagnosticsWindowProps {
  ws: WebSocketClient | null;
  diagnostics: Record<string, unknown> | null;
  backendConnectionState: BackendConnectionState;
  onClose: () => void;
  onRestartBackend: () => void;
}

function record(value: unknown): Record<string, unknown> {
  return (value as Record<string, unknown> | null) ?? {};
}

function statusValue(value: unknown, fallback = "unknown"): string {
  if (typeof value === "boolean") return value ? "configured" : "missing";
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

const DiagnosticsWindow: React.FC<DiagnosticsWindowProps> = ({
  ws,
  diagnostics,
  backendConnectionState,
  onClose,
  onRestartBackend,
}) => {
  useLargeOverlayWindow();

  const backend = record(diagnostics?.backend);
  const provider = record(diagnostics?.provider);
  const microphone = record(diagnostics?.microphone);
  const shortcut = record(diagnostics?.shortcut);
  const activation = record(diagnostics?.activation);
  const transcription = record(diagnostics?.transcription);
  const paths = record(diagnostics?.paths);
  const app = record(diagnostics?.app);

  const report = useMemo(
    () =>
      JSON.stringify(
        {
          backend: diagnostics?.backend ?? { status: backendConnectionState },
          websocket: { status: backendConnectionState },
          provider,
          microphone,
          shortcut,
          activation,
          transcription,
          paths,
          app,
          backend_version: diagnostics?.backend_version ?? "unknown",
        },
        null,
        2
      ),
    [
      app,
      backendConnectionState,
      diagnostics?.backend,
      diagnostics?.backend_version,
      microphone,
      paths,
      provider,
      shortcut,
      activation,
      transcription,
    ]
  );

  const rows: [string, string][] = [
    ["Backend", statusValue(backend.status, "running")],
    ["WebSocket", backendConnectionState],
    ["Provider", statusValue(provider.configured)],
    ["Model", statusValue(provider.model)],
    ["API key", statusValue(provider.api_key)],
    ["Microphone", statusValue(microphone.available)],
    ["Shortcut", `${statusValue(shortcut.shortcut)} · ${statusValue(shortcut.mode)}`],
    ["Global shortcut", `${statusValue(activation.global_shortcut)} · ${statusValue(activation.shortcut_behavior)}`],
    ["Transcription", `${statusValue(transcription.status)} · ${statusValue(transcription.model)}`],
    ["Logs path", statusValue(paths.logs)],
    ["Config path", statusValue(paths.config)],
    ["App version", statusValue(app.version)],
    ["Backend version", statusValue(diagnostics?.backend_version)],
  ];

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="diagnostics-panel" onClick={(event) => event.stopPropagation()}>
        <header className="panel-header">
          <div>
            <h2>Diagnostics</h2>
            <p>Status and repair tools for vox2ai.</p>
          </div>
          <button className="settings-close-btn" type="button" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="diagnostics-grid">
          {rows.map(([label, value]) => (
            <div className="diagnostic-row" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>

        {Boolean(microphone.message) && (
          <div className="diagnostic-note">{String(microphone.message)}</div>
        )}

        <div className="diagnostic-actions">
          <button
            className="form-btn form-btn-secondary"
            onClick={() =>
              ws?.send({
                type: "test_provider",
                provider_id: String(provider.provider ?? ""),
                base_url: String(provider.base_url ?? ""),
                api_key: "",
                model: String(provider.model ?? ""),
              })
            }
          >
            Test provider
          </button>
          <button
            className="form-btn form-btn-secondary"
            onClick={() => ws?.send({ type: "get_diagnostics" })}
          >
            Test microphone
          </button>
          <button className="form-btn form-btn-secondary" onClick={onRestartBackend}>
            Restart backend
          </button>
          <button className="form-btn form-btn-secondary" onClick={() => ws?.send({ type: "open_logs" })}>
            Open logs folder
          </button>
          <button className="form-btn form-btn-secondary" onClick={() => ws?.send({ type: "open_config_folder" })}>
            Open config folder
          </button>
          <CopyButton text={report} label="Copy diagnostic report" title="Copy diagnostic report" />
        </div>

        <pre className="diagnostics-report">
          <code>{report}</code>
        </pre>
      </div>
    </div>
  );
};

export default DiagnosticsWindow;
