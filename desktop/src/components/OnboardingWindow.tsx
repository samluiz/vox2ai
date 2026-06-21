import React, { useCallback, useEffect, useRef, useState } from "react";
import type { WebSocketClient } from "../api/websocket";
import RecordingSettings from "./RecordingSettings";
import type { RecordingActivationMode } from "../utils/shortcut";
import { useLargeOverlayWindow } from "../hooks/useLargeOverlayWindow";

interface OnboardingWindowProps {
  ws: WebSocketClient | null;
  initialSettings: Record<string, unknown> | null;
  onClose: () => void;
}

const STEPS = ["Welcome", "Provider", "Voice", "Controls", "Finish"];
const API_KEY_PLACEHOLDER = "••••••••••••••••";

const PROVIDERS: Record<string, { label: string; base_url: string; requires_key: boolean }> = {
  openai: { label: "OpenAI", base_url: "https://api.openai.com/v1", requires_key: true },
  openrouter: { label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", requires_key: true },
  lmstudio: { label: "LM Studio", base_url: "http://localhost:1234/v1", requires_key: false },
  ollama: { label: "Ollama", base_url: "http://localhost:11434", requires_key: false },
  custom: { label: "Custom OpenAI-compatible", base_url: "", requires_key: false },
};

const OnboardingWindow: React.FC<OnboardingWindowProps> = ({
  ws,
  initialSettings,
  onClose,
}) => {
  useLargeOverlayWindow();

  const assistant = (initialSettings?.assistant as Record<string, unknown>) ?? {};
  const voice = (initialSettings?.voice as Record<string, unknown>) ?? {};
  const recordingSettings = (initialSettings?.recording as Record<string, unknown>) ?? {};
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState(
    ((assistant.provider as string) || "openai").replace("openai-compatible", "openai")
  );
  const [baseUrl, setBaseUrl] = useState((assistant.base_url as string) ?? PROVIDERS.openai.base_url);
  const [model, setModel] = useState((assistant.model as string) ?? "gpt-4.1-mini");
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [languageMode, setLanguageMode] = useState((voice.language_mode as string) ?? "auto");
  const [primaryLanguage, setPrimaryLanguage] = useState((voice.primary_language as string) ?? "en");
  const [activationMode, setActivationMode] = useState<RecordingActivationMode>(
    ((recordingSettings.activation_mode as string) ?? "hold-to-talk") as RecordingActivationMode
  );
  const [shortcut, setShortcut] = useState((recordingSettings.shortcut as string) ?? "Ctrl");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const configuredKey = Boolean(assistant.api_key_configured);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!ws) return;
    const unsub = ws.onEvent((event) => {
      if (event.type === "provider_test_result") {
        setTestResult({ ok: event.ok as boolean, message: event.message as string });
      }
      if (event.type === "provider_models") {
        setModels(event.models as { id: string; name: string }[]);
        setModelsLoading(false);
      }
      if (event.type === "provider_models_error") {
        setModels([]);
        setModelsLoading(false);
      }
      if (event.type === "settings_saved") {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(onClose, 250);
      }
    });
    return () => unsub();
  }, [onClose, ws]);

  const providerRequiresKey = PROVIDERS[provider]?.requires_key ?? false;
  const canFinish = Boolean(baseUrl.trim() && model.trim() && (!providerRequiresKey || apiKey || configuredKey));

  const chooseProvider = (id: string) => {
    setProvider(id);
    setBaseUrl(PROVIDERS[id]?.base_url ?? "");
    setTestResult(null);
    setModels([]);
  };

  const testConnection = () => {
    setTestResult(null);
    ws?.send({ type: "test_provider", provider_id: provider, base_url: baseUrl, api_key: apiKey, model });
  };

  const fetchModels = () => {
    setModelsLoading(true);
    setModels([]);
    ws?.send({ type: "list_provider_models", provider_id: provider, base_url: baseUrl, api_key: apiKey });
  };

  const finish = useCallback(() => {
    if (!canFinish) return;
    ws?.send({
      type: "update_settings",
      settings: {
        assistant: {
          provider,
          base_url: baseUrl,
          model,
          ...(apiKey ? { api_key: apiKey } : {}),
        },
        voice: {
          ...voice,
          language_mode: languageMode,
          primary_language: primaryLanguage,
        },
        recording: {
          activation_mode: activationMode,
          shortcut,
        },
        onboarding: { completed: true },
      },
    });
  }, [
    activationMode,
    apiKey,
    baseUrl,
    canFinish,
    languageMode,
    model,
    primaryLanguage,
    provider,
    shortcut,
    voice,
    ws,
  ]);

  const renderStep = () => {
    if (step === 0) {
      return (
        <div className="onboarding-step">
          <h2>Set up vox2ai</h2>
          <p>Configure the assistant once, then use voice or typed prompts from the compact widget.</p>
          <div className="onboarding-checks">
            <span>Provider</span>
            <span>Model</span>
            <span>Voice language</span>
            <span>Recording shortcut</span>
          </div>
        </div>
      );
    }

    if (step === 1) {
      return (
        <div className="onboarding-step">
          <h2>Provider</h2>
          <p>Choose where responses come from. API keys are stored through the backend secret store.</p>
          <div className="form-group">
            <label className="form-label">Provider</label>
            <select className="form-select" value={provider} onChange={(event) => chooseProvider(event.target.value)}>
              {Object.entries(PROVIDERS).map(([id, item]) => (
                <option key={id} value={id}>{item.label}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Base URL</label>
            <input className="form-input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">API key</label>
            <div className="secret-input-row">
              <input
                className="form-input secret-input"
                type={showApiKey ? "text" : "password"}
                value={apiKey || (configuredKey ? API_KEY_PLACEHOLDER : "")}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={providerRequiresKey ? "Required" : "Optional"}
              />
              <button className="form-btn form-btn-ghost" type="button" onClick={() => setShowApiKey((show) => !show)}>
                {showApiKey ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Model</label>
            <div className="model-row">
              <input className="form-input" value={model} onChange={(event) => setModel(event.target.value)} list="onboarding-models" />
              <datalist id="onboarding-models">
                {models.slice(0, 30).map((item) => (
                  <option key={item.id} value={item.id} />
                ))}
              </datalist>
              <button className="form-btn form-btn-secondary" type="button" onClick={fetchModels}>
                {modelsLoading ? "Loading..." : "Fetch"}
              </button>
            </div>
          </div>
          <div className="form-actions">
            <button className="form-btn form-btn-secondary" type="button" onClick={testConnection}>Test connection</button>
          </div>
          {testResult && (
            <div className={`test-result ${testResult.ok ? "test-result-ok" : "test-result-fail"}`}>
              {testResult.message}
            </div>
          )}
        </div>
      );
    }

    if (step === 2) {
      return (
        <div className="onboarding-step">
          <h2>Voice language</h2>
          <p>Use auto detection for mixed-language work, or force a primary language.</p>
          <div className="form-group">
            <label className="form-label">Language mode</label>
            <select className="form-select" value={languageMode} onChange={(event) => setLanguageMode(event.target.value)}>
              <option value="auto">Auto detect</option>
              <option value="force">Force primary language</option>
              <option value="constrained-auto">Constrained auto</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Primary language</label>
            <input className="form-input" value={primaryLanguage} onChange={(event) => setPrimaryLanguage(event.target.value)} placeholder="en" />
          </div>
        </div>
      );
    }

    if (step === 3) {
      return (
        <div className="onboarding-step">
          <h2>Recording controls</h2>
          <RecordingSettings
            activationMode={activationMode}
            shortcut={shortcut}
            onChange={(patch) => {
              if (patch.activation_mode) setActivationMode(patch.activation_mode);
              if (patch.shortcut) setShortcut(patch.shortcut);
            }}
            onReset={() => {
              setActivationMode("hold-to-talk");
              setShortcut("Ctrl");
            }}
          />
        </div>
      );
    }

    return (
      <div className="onboarding-step">
        <h2>Ready</h2>
        <p>Review the setup, then start using vox2ai.</p>
        <div className="onboarding-summary">
          <span>Provider configured</span><strong>{provider}</strong>
          <span>Model selected</span><strong>{model || "missing"}</strong>
          <span>Transcription language</span><strong>{languageMode} / {primaryLanguage}</strong>
          <span>Shortcut configured</span><strong>{shortcut} · {activationMode}</strong>
        </div>
        {!canFinish && <div className="form-error">Provider, model, and required API key must be configured.</div>}
      </div>
    );
  };

  return (
    <div className="settings-overlay">
      <div className="onboarding-panel">
        <div className="onboarding-progress">
          {STEPS.map((label, index) => (
            <button
              key={label}
              className={`onboarding-dot ${index === step ? "active" : ""} ${index < step ? "done" : ""}`}
              type="button"
              onClick={() => setStep(index)}
            >
              <span>{index + 1}</span>
              {label}
            </button>
          ))}
        </div>
        <div className="onboarding-content">{renderStep()}</div>
        <div className="onboarding-footer">
          <button className="form-btn form-btn-secondary" type="button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>
            Back
          </button>
          {step < STEPS.length - 1 ? (
            <button className="form-btn form-btn-primary" type="button" onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}>
              Continue
            </button>
          ) : (
            <button className="form-btn form-btn-primary" type="button" onClick={finish} disabled={!canFinish}>
              Finish
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default OnboardingWindow;
