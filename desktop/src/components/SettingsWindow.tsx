import React, { useState, useCallback, useEffect, useRef } from "react";
import type { WebSocketClient } from "../api/websocket";

interface Props {
  ws: WebSocketClient | null;
  initialSettings: Record<string, unknown> | null;
  onClose: () => void;
  onSettingsChanged: () => void;
}

type Section = "provider" | "voice" | "commands" | "window" | "advanced" | "about";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "provider", label: "Provider" },
  { id: "voice", label: "Voice" },
  { id: "commands", label: "Commands" },
  { id: "window", label: "Window" },
  { id: "advanced", label: "Advanced" },
  { id: "about", label: "About" },
];

const API_KEY_PLACEHOLDER = "••••••••••••••••";

const PROVIDER_PRESETS: Record<string, { base_url: string; auth_type: string }> = {
  openai: { base_url: "https://api.openai.com/v1", auth_type: "bearer" },
  openrouter: { base_url: "https://openrouter.ai/api/v1", auth_type: "bearer" },
  lmstudio: { base_url: "http://localhost:1234/v1", auth_type: "optional" },
  ollama: { base_url: "http://localhost:11434", auth_type: "none" },
  custom: { base_url: "", auth_type: "bearer_or_none" },
};

const SettingsWindow: React.FC<Props> = ({ ws, initialSettings, onClose, onSettingsChanged }) => {
  const [section, setSection] = useState<Section>("provider");
  const [settings, setSettings] = useState<Record<string, unknown>>(initialSettings ?? {});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [backendConnected, setBackendConnected] = useState(true);
  const [providerId, setProviderId] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const holdApiKeyRef = useRef("");

  // Initialize form fields from settings.
  useEffect(() => {
    const asst = (settings.assistant as Record<string, unknown>) ?? {};
    setProviderId((asst.provider as string) ?? "openai");
    setBaseUrl((asst.base_url as string) ?? "");
    setModelName((asst.model as string) ?? "");
  }, [settings]);

  const updateDirty = useCallback(() => setDirty(true), []);

  const send = useCallback(
    (cmd: Record<string, unknown>) => {
      ws?.send(cmd as never);
    },
    [ws]
  );

  // Notify backend of a settings change.
  const save = useCallback(() => {
    setSaving(true);
    setSaved(false);

    const patch: Record<string, unknown> = {};

    // Provider section
    const asst: Record<string, unknown> = {};
    asst.provider = providerId;
    asst.base_url = baseUrl;
    asst.model = modelName;
    if (holdApiKeyRef.current) {
      asst.api_key = holdApiKeyRef.current;
    }
    patch.assistant = asst;

    // Other sections (from the settings state)
    if (settings.voice) patch.voice = settings.voice;
    if (settings.transcription) patch.transcription = settings.transcription;
    if (settings.commands) patch.commands = settings.commands;
    if (settings.desktop_window) patch.desktop_window = settings.desktop_window;
    if (settings.debug) patch.debug = settings.debug;

    send({ type: "update_settings", settings: patch });
  }, [providerId, baseUrl, modelName, settings, send]);

  const testConnection = useCallback(() => {
    setTestResult(null);
    setSaved(false);
    const key = holdApiKeyRef.current || apiKey;
    send({
      type: "test_provider",
      provider_id: providerId,
      base_url: baseUrl,
      api_key: key,
      model: modelName,
    });
  }, [providerId, baseUrl, modelName, apiKey, send]);

  const refreshModels = useCallback(() => {
    setModelsLoading(true);
    setModels([]);
    const key = holdApiKeyRef.current || apiKey;
    send({
      type: "list_provider_models",
      provider_id: providerId,
      base_url: baseUrl,
      api_key: key,
    });
  }, [providerId, baseUrl, apiKey, send]);

  const handlePresetChange = useCallback((pid: string) => {
    setProviderId(pid);
    const preset = PROVIDER_PRESETS[pid];
    if (preset) {
      setBaseUrl(preset.base_url);
    }
    setModels([]);
    setTestResult(null);
    holdApiKeyRef.current = "";
    setApiKey("");
    updateDirty();
  }, [updateDirty]);

  const renderProvider = () => {
    const configured = Boolean((settings.assistant as Record<string, unknown>)?.api_key_configured);
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">Provider</h3>
        <p className="settings-desc">
          Choose your AI provider and configure the API connection.
        </p>

        <div className="form-group">
          <label className="form-label">Provider preset</label>
          <select
            className="form-select"
            value={providerId}
            onChange={(e) => handlePresetChange(e.target.value)}
          >
            <option value="openai">OpenAI</option>
            <option value="openrouter">OpenRouter</option>
            <option value="lmstudio">LM Studio</option>
            <option value="ollama">Ollama</option>
            <option value="custom">Custom OpenAI-compatible</option>
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Base URL</label>
          <input
            className="form-input"
            type="text"
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); updateDirty(); }}
            placeholder="https://api.openai.com/v1"
          />
        </div>

        <div className="form-group">
          <label className="form-label">API Key</label>
          <div className="secret-input-row">
            <input
              className="form-input secret-input"
              type={showApiKey ? "text" : "password"}
              value={holdApiKeyRef.current || (configured ? API_KEY_PLACEHOLDER : "")}
              onChange={(e) => {
                holdApiKeyRef.current = e.target.value;
                setApiKey(e.target.value);
                updateDirty();
              }}
              placeholder={configured ? "Saved key (enter to replace)" : "sk-..."}
            />
            <button
              className="form-btn form-btn-ghost"
              onClick={() => setShowApiKey(!showApiKey)}
              title={showApiKey ? "Hide key" : "Show key"}
            >
              {showApiKey ? "🙈" : "👁"}
            </button>
            {configured && (
              <button
                className="form-btn form-btn-ghost"
                onClick={() => {
                  send({ type: "delete_api_key" });
                  holdApiKeyRef.current = "";
                  setApiKey("");
                  updateDirty();
                }}
                title="Clear saved key"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Model</label>
          <div className="model-row">
            <input
              className="form-input"
              type="text"
              value={modelName}
              onChange={(e) => { setModelName(e.target.value); updateDirty(); }}
              placeholder="gpt-4.1-mini"
              list="model-suggestions"
            />
            <datalist id="model-suggestions">
              {models.slice(0, 20).map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
            <button
              className="form-btn form-btn-secondary"
              onClick={refreshModels}
              disabled={modelsLoading || !baseUrl}
            >
              {modelsLoading ? "Loading…" : "Refresh models"}
            </button>
          </div>
          {models.length > 0 && (
            <div className="model-count">{models.length} models available</div>
          )}
        </div>

        <div className="form-actions">
          <button className="form-btn form-btn-secondary" onClick={testConnection}>
            Test connection
          </button>
          <button className="form-btn form-btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        </div>

        {testResult && (
          <div className={`test-result ${testResult.ok ? "test-result-ok" : "test-result-fail"}`}>
            {testResult.ok ? "✓ " : "✗ "}{testResult.message}
          </div>
        )}
      </div>
    );
  };

  const renderVoice = () => {
    const voice = (settings.voice as Record<string, unknown>) ?? {};
    const trans = (settings.transcription as Record<string, unknown>) ?? {};
    const partial = (trans.partial as Record<string, unknown>) ?? {};

    const setVoice = (key: string, value: unknown) => {
      setSettings((s) => ({ ...s, voice: { ...voice, [key]: value } }));
      updateDirty();
    };
    const setTrans = (key: string, value: unknown) => {
      setSettings((s) => ({ ...s, transcription: { ...trans, [key]: value } }));
      updateDirty();
    };
    const setPartial = (key: string, value: unknown) => {
      setSettings((s) => ({
        ...s,
        transcription: { ...trans, partial: { ...partial, [key]: value } },
      }));
      updateDirty();
    };

    return (
      <div className="settings-section">
        <h3 className="settings-section-title">Voice & Transcription</h3>

        <div className="form-group">
          <label className="form-label">Whisper model</label>
          <select
            className="form-select"
            value={(voice.whisper_model as string) ?? "small"}
            onChange={(e) => setVoice("whisper_model", e.target.value)}
          >
            <option value="tiny">Tiny (fastest, lowest quality)</option>
            <option value="base">Base</option>
            <option value="small">Small (recommended)</option>
            <option value="medium">Medium (slower, better quality)</option>
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Language mode</label>
          <p className="form-hint">
            Auto detects freely. Force locks to one language. Constrained auto
            falls back to primary language when detection is unreliable.
          </p>
          <select
            className="form-select"
            value={(voice.language_mode as string) ?? "auto"}
            onChange={(e) => setVoice("language_mode", e.target.value)}
          >
            <option value="auto">Auto (detect freely)</option>
            <option value="force">Force primary language</option>
            <option value="constrained-auto">Constrained auto</option>
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Primary language</label>
          <input
            className="form-input"
            type="text"
            value={(voice.primary_language as string) ?? "en"}
            onChange={(e) => setVoice("primary_language", e.target.value)}
            placeholder="en"
          />
        </div>

        {(voice.language_mode as string) === "constrained-auto" && (
          <div className="form-group">
            <label className="form-label">Allowed languages</label>
            <input
              className="form-input"
              type="text"
              value={((voice.allowed_languages as string[]) ?? []).join(", ")}
              onChange={(e) =>
                setVoice(
                  "allowed_languages",
                  e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
                )
              }
              placeholder="pt, en"
            />
            <p className="form-hint">Comma-separated language codes.</p>
          </div>
        )}

        <div className="form-group">
          <label className="form-label">
            Min language probability ({voice.min_language_probability as number ?? 0.55})
          </label>
          <input
            className="form-input"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={(voice.min_language_probability as number) ?? 0.55}
            onChange={(e) => setVoice("min_language_probability", parseFloat(e.target.value))}
          />
        </div>

        <div className="form-group">
          <label className="form-check-label">
            <input
              type="checkbox"
              checked={(partial.enabled as boolean) ?? true}
              onChange={(e) => setPartial("enabled", e.target.checked)}
            />
            {" "}Show partial transcript while speaking
          </label>
        </div>

        {((partial.enabled as boolean) ?? true) && (
          <>
            <div className="form-group">
              <label className="form-label">Partial update interval (ms)</label>
              <input
                className="form-input"
                type="number"
                value={(partial.interval_ms as number) ?? 1600}
                onChange={(e) => setPartial("interval_ms", parseInt(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Audio window (seconds)</label>
              <input
                className="form-input"
                type="number"
                value={(partial.window_seconds as number) ?? 6}
                onChange={(e) => setPartial("window_seconds", parseFloat(e.target.value))}
              />
            </div>
          </>
        )}

        <div className="form-actions">
          <button className="form-btn form-btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    );
  };

  const renderCommands = () => {
    const cmds = (settings.commands as Record<string, unknown>) ?? {};

    const setCmd = (key: string, value: unknown) => {
      setSettings((s) => ({ ...s, commands: { ...cmds, [key]: value } }));
      updateDirty();
    };

    return (
      <div className="settings-section">
        <h3 className="settings-section-title">Commands</h3>
        <p className="settings-desc">
          The assistant can propose shell commands. You control how they run.
        </p>

        <div className="form-group">
          <label className="form-label">Command mode</label>
          <select
            className="form-select"
            value={(cmds.mode as string) ?? "ask-before-run"}
            onChange={(e) => setCmd("mode", e.target.value)}
          >
            <option value="disabled">Disabled</option>
            <option value="ask-before-run">Ask before run (safe default)</option>
            <option value="allow-all">Allow all (not recommended)</option>
          </select>
        </div>

        {(cmds.mode as string) === "allow-all" && (
          <div className="warning-box">
            Allow all will run any proposed command without confirmation.
            Blocked patterns (below) still apply.
          </div>
        )}

        <div className="form-group">
          <label className="form-label">Timeout (seconds)</label>
          <input
            className="form-input"
            type="number"
            value={(cmds.timeout_seconds as number) ?? 30}
            onChange={(e) => setCmd("timeout_seconds", parseInt(e.target.value))}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Max output characters</label>
          <input
            className="form-input"
            type="number"
            value={(cmds.max_output_chars as number) ?? 12000}
            onChange={(e) => setCmd("max_output_chars", parseInt(e.target.value))}
          />
        </div>

        <div className="form-actions">
          <button className="form-btn form-btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    );
  };

  const renderWindow = () => {
    const dw = (settings.desktop_window as Record<string, unknown>) ?? {};

    const setDw = (key: string, value: unknown) => {
      setSettings((s) => ({ ...s, desktop_window: { ...dw, [key]: value } }));
      updateDirty();
    };

    return (
      <div className="settings-section">
        <h3 className="settings-section-title">Window</h3>

        <div className="form-group">
          <label className="form-check-label">
            <input
              type="checkbox"
              checked={(dw.always_on_top as boolean) ?? true}
              onChange={(e) => setDw("always_on_top", e.target.checked)}
            />
            {" "}Always on top
          </label>
        </div>

        <div className="form-group">
          <label className="form-label">Active opacity ({dw.active_opacity as number ?? 0.98})</label>
          <input
            className="form-input"
            type="range"
            min="0.3"
            max="1"
            step="0.02"
            value={(dw.active_opacity as number) ?? 0.98}
            onChange={(e) => setDw("active_opacity", parseFloat(e.target.value))}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Inactive opacity ({dw.inactive_opacity as number ?? 0.08})</label>
          <input
            className="form-input"
            type="range"
            min="0.02"
            max="0.5"
            step="0.02"
            value={(dw.inactive_opacity as number) ?? 0.08}
            onChange={(e) => setDw("inactive_opacity", parseFloat(e.target.value))}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Fade delay (seconds)</label>
          <input
            className="form-input"
            type="number"
            value={(dw.fade_after_seconds as number) ?? 8}
            onChange={(e) => setDw("fade_after_seconds", parseInt(e.target.value))}
          />
        </div>

        <div className="form-actions">
          <button className="form-btn form-btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>
    );
  };

  const renderAdvanced = () => (
    <div className="settings-section">
      <h3 className="settings-section-title">Advanced</h3>

      <div className="form-group">
        <button className="form-btn form-btn-secondary" onClick={() => send({ type: "open_logs" })}>
          Open logs folder
        </button>
      </div>
      <div className="form-group">
        <button className="form-btn form-btn-secondary" onClick={() => send({ type: "open_config_folder" })}>
          Open config folder
        </button>
      </div>
      <div className="form-group">
        <button
          className="form-btn form-btn-danger"
          onClick={() => {
            if (confirm("Reset all settings to defaults? This cannot be undone.")) {
              send({ type: "reset_settings" });
            }
          }}
        >
          Reset settings to defaults
        </button>
      </div>
    </div>
  );

  const renderAbout = () => (
    <div className="settings-section">
      <h3 className="settings-section-title">vox2ai</h3>
      <div className="about-info">
        <p>A standalone desktop voice assistant with local STT and LLM support.</p>
        <dl>
          <dt>Version</dt>
          <dd>0.1.0</dd>
          <dt>Backend</dt>
          <dd>{settings ? "Connected" : "Disconnected"}</dd>
          <dt>STT engine</dt>
          <dd>faster-whisper</dd>
        </dl>
      </div>
    </div>
  );

  const sectionContent = () => {
    if (!settings) {
      return <div className="settings-section"><p>Loading settings…</p></div>;
    }
    switch (section) {
      case "provider": return renderProvider();
      case "voice": return renderVoice();
      case "commands": return renderCommands();
      case "window": return renderWindow();
      case "advanced": return renderAdvanced();
      case "about": return renderAbout();
    }
  };

  // Detect backend connection status.
  useEffect(() => {
    if (!ws) {
      setBackendConnected(false);
      return;
    }
    setBackendConnected(true);
    const unsub = ws.onEvent((event: { type: string }) => {
      if (event.type === "hello" || event.type === "settings") {
        setBackendConnected(true);
      }
    });
    return () => { unsub(); };
  }, [ws]);

  // Listen for backend responses.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: { type: string; [key: string]: unknown }) => {
      if (event.type === "settings_saved") {
        setSettings((event.settings as Record<string, unknown>) ?? {});
        setDirty(false);
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        onSettingsChanged();
      } else if (event.type === "provider_test_result") {
        setTestResult({ ok: event.ok as boolean, message: event.message as string });
      } else if (event.type === "provider_models") {
        setModels(event.models as { id: string; name: string }[]);
        setModelsLoading(false);
      } else if (event.type === "provider_models_error") {
        setModels([]);
        setModelsLoading(false);
      }
    };
    const unsub = ws.onEvent(handler);
    return () => { unsub(); };
  }, [ws, onSettingsChanged]);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        {!backendConnected && (
          <div className="settings-connection-error">
            Could not connect to vox2ai backend. Make sure the server is running.
          </div>
        )}
        <div className="settings-panel-inner">
          <div className="settings-sidebar">
            <div className="settings-logo">vox2ai</div>
            <nav className="settings-nav">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  className={`settings-nav-item ${section === s.id ? "active" : ""}`}
                  onClick={() => setSection(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </nav>
            <button className="settings-close-btn" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="settings-content">
            {sectionContent()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsWindow;
