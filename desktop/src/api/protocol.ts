export interface BackendEvent {
  type: string;
  [key: string]: unknown;
}

export interface HelloEvent extends BackendEvent {
  type: "hello";
  version: string;
}

export interface StateEvent extends BackendEvent {
  type: "state";
  state: string;
  message: string;
}

export interface BackendStatusEvent extends BackendEvent {
  type: "backend_status";
  status: string;
  message: string;
}

export interface AudioLevelEvent extends BackendEvent {
  type: "audio_level";
  rms: number;
  peak: number;
}

export interface TranscriptEvent extends BackendEvent {
  type: "transcript";
  text: string;
  raw_text?: string | null;
  source?: string;
}

export interface PartialTranscriptEvent extends BackendEvent {
  type: "partial_transcript";
  text: string;
  stable: boolean;
}

export interface OperationCancelledEvent extends BackendEvent {
  type: "operation_cancelled";
  operation: string;
}

export interface AnswerStartEvent extends BackendEvent {
  type: "answer_start";
}

export interface AnswerDeltaEvent extends BackendEvent {
  type: "answer_delta";
  text: string;
}

export interface AnswerDoneEvent extends BackendEvent {
  type: "answer_done";
}

export interface CommandApprovalEvent extends BackendEvent {
  type: "command_approval";
  command: string;
  reason?: string | null;
  working_directory?: string;
  risk?: "low" | "medium" | "high";
  expected_effect?: string;
}

export interface CommandRunningEvent extends BackendEvent {
  type: "command_running";
  command: string;
}

export interface CommandResultEvent extends BackendEvent {
  type: "command_result";
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface DiagnosticsEvent extends BackendEvent {
  type: "diagnostics";
  diagnostics: Record<string, unknown>;
}

export interface ConversationClearedEvent extends BackendEvent {
  type: "conversation_cleared";
}

export interface ErrorEvent extends BackendEvent {
  type: "error";
  message: string;
}

export interface TimingEvent extends BackendEvent {
  type: "timing";
  items: { name: string; ms: number }[];
}

export interface SettingsEvent extends BackendEvent {
  type: "settings";
  settings: Record<string, unknown>;
}

export interface SettingsSavedEvent extends BackendEvent {
  type: "settings_saved";
  settings: Record<string, unknown>;
}

export interface ProviderTestResultEvent extends BackendEvent {
  type: "provider_test_result";
  ok: boolean;
  message: string;
}

export interface ProviderModelsEvent extends BackendEvent {
  type: "provider_models";
  provider_id: string;
  models: { id: string; name: string }[];
}

export interface ProviderModelsErrorEvent extends BackendEvent {
  type: "provider_models_error";
  provider_id: string;
  message: string;
}

export interface SettingsErrorEvent extends BackendEvent {
  type: "settings_error";
  field: string;
  message: string;
}

export type FrontendCommand =
  | { type: "ping" }
  | { type: "start_recording" }
  | { type: "stop_recording" }
  | { type: "cancel_recording" }
  | { type: "cancel_current_operation" }
  | { type: "approve_command" }
  | { type: "deny_command" }
  | { type: "submit_text_prompt"; text: string; context?: Record<string, unknown> }
  | { type: "get_settings" }
  | { type: "update_settings"; settings: Record<string, unknown> }
  | { type: "test_provider"; provider_id: string; base_url: string; api_key: string; model: string }
  | { type: "list_provider_models"; provider_id: string; base_url: string; api_key: string }
  | { type: "delete_api_key" }
  | { type: "open_logs" }
  | { type: "open_config_folder" }
  | { type: "reset_settings" }
  | { type: "get_diagnostics" }
  | { type: "clear_conversation" }
  | { type: "get_context_preview" };
