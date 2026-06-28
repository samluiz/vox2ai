"""Typed WebSocket message models for the vox2ai desktop frontend-backend protocol."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, cast

# ── Backend → frontend events ───────────────────────────────────


@dataclass
class HelloEvent:
    type: Literal["hello"] = "hello"
    version: str = "0.1.0"


@dataclass
class StateEvent:
    type: Literal["state"] = "state"
    state: str = ""
    message: str = ""


@dataclass
class BackendStatusEvent:
    type: Literal["backend_status"] = "backend_status"
    status: str = "connected"
    message: str = "Ready"


@dataclass
class AudioLevelEvent:
    type: Literal["audio_level"] = "audio_level"
    rms: float = 0.0
    peak: float = 0.0
    level: float = 0.0
    speech_detected: bool = False


@dataclass
class VoiceActivityEvent:
    type: Literal["voice_activity"] = "voice_activity"
    active: bool = False
    rms: float = 0.0
    peak: float = 0.0
    speech_started: bool = False
    silence_ms: int = 0


@dataclass
class RecordingAutoStoppingEvent:
    type: Literal["recording_auto_stopping"] = "recording_auto_stopping"
    reason: str = "silence"
    silence_ms: int = 0


@dataclass
class RecordingStoppedEvent:
    type: Literal["recording_stopped"] = "recording_stopped"
    reason: str = "manual"


@dataclass
class TranscriptEvent:
    type: Literal["transcript"] = "transcript"
    text: str = ""
    raw_text: str | None = None
    source: str = "voice"


@dataclass
class PartialTranscriptEvent:
    type: Literal["partial_transcript"] = "partial_transcript"
    text: str = ""
    stable: bool = False


@dataclass
class OperationCancelledEvent:
    type: Literal["operation_cancelled"] = "operation_cancelled"
    operation: str = "recording"


@dataclass
class AnswerStartEvent:
    type: Literal["answer_start"] = "answer_start"


@dataclass
class AnswerDeltaEvent:
    type: Literal["answer_delta"] = "answer_delta"
    text: str = ""


@dataclass
class AnswerDoneEvent:
    type: Literal["answer_done"] = "answer_done"


@dataclass
class CommandApprovalEvent:
    type: Literal["command_approval"] = "command_approval"
    command: str = ""
    reason: str | None = None
    working_directory: str = ""
    risk: Literal["low", "medium", "high"] = "low"
    expected_effect: str = ""
    safe: bool = True


@dataclass
class CommandRunningEvent:
    type: Literal["command_running"] = "command_running"
    command: str = ""


@dataclass
class CommandResultEvent:
    type: Literal["command_result"] = "command_result"
    command: str = ""
    exit_code: int = 0
    stdout: str = ""
    stderr: str = ""


@dataclass
class ErrorEvent:
    type: Literal["error"] = "error"
    message: str = ""


@dataclass
class TimingEvent:
    type: Literal["timing"] = "timing"
    items: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class SettingsEvent:
    type: Literal["settings"] = "settings"
    settings: dict[str, Any] = field(default_factory=dict)


@dataclass
class SettingsSavedEvent:
    type: Literal["settings_saved"] = "settings_saved"
    settings: dict[str, Any] = field(default_factory=dict)


@dataclass
class SettingsErrorEvent:
    type: Literal["settings_error"] = "settings_error"
    field: str = ""
    message: str = ""


@dataclass
class ProviderTestResultEvent:
    type: Literal["provider_test_result"] = "provider_test_result"
    ok: bool = False
    message: str = ""


@dataclass
class ProviderModelsEvent:
    type: Literal["provider_models"] = "provider_models"
    provider_id: str = ""
    models: list[dict[str, str]] = field(default_factory=list)


@dataclass
class ProviderModelsErrorEvent:
    type: Literal["provider_models_error"] = "provider_models_error"
    provider_id: str = ""
    message: str = ""


@dataclass
class DiagnosticsEvent:
    type: Literal["diagnostics"] = "diagnostics"
    diagnostics: dict[str, Any] = field(default_factory=dict)


@dataclass
class CapabilitiesEvent:
    type: Literal["capabilities"] = "capabilities"
    capabilities: dict[str, Any] = field(default_factory=dict)
    audio: dict[str, Any] = field(default_factory=dict)
    assistant: dict[str, Any] = field(default_factory=dict)
    conversation: dict[str, Any] = field(default_factory=dict)
    screen: dict[str, Any] = field(default_factory=dict)


@dataclass
class ConversationStateEvent:
    type: Literal["conversation_state"] = "conversation_state"
    enabled: bool = False
    turn_count: int = 0
    max_turns: int = 8


@dataclass
class AudioInputTestStartedEvent:
    type: Literal["audio_input_test_started"] = "audio_input_test_started"


@dataclass
class AudioInputTestLevelEvent:
    type: Literal["audio_input_test_level"] = "audio_input_test_level"
    rms: float = 0.0
    peak: float = 0.0
    speech_detected: bool = False
    threshold: float = 0.0


@dataclass
class AudioInputTestStoppedEvent:
    type: Literal["audio_input_test_stopped"] = "audio_input_test_stopped"


@dataclass
class AudioInputTestErrorEvent:
    type: Literal["audio_input_test_error"] = "audio_input_test_error"
    message: str = ""


@dataclass
class ContextPreviewEvent:
    type: Literal["context_preview"] = "context_preview"
    clipboard_available: bool = False
    clipboard_preview: str = ""
    active_window: dict[str, str] | None = None


@dataclass
class ConversationClearedEvent:
    type: Literal["conversation_cleared"] = "conversation_cleared"


@dataclass
class ModelProfilesEvent:
    type: Literal["model_profiles"] = "model_profiles"
    profiles: list[dict[str, Any]] = field(default_factory=list)
    active: str = "fast"


@dataclass
class ModelProfileSetEvent:
    type: Literal["model_profile_set"] = "model_profile_set"
    active: str = "fast"


@dataclass
class ScreenCaptureStartedEvent:
    type: Literal["screen_capture_started"] = "screen_capture_started"
    method: str = ""


@dataclass
class ScreenCaptureDoneEvent:
    type: Literal["screen_capture_done"] = "screen_capture_done"
    context_id: str = ""
    width: int = 0
    height: int = 0
    method: str = ""


@dataclass
class ScreenContextStartedEvent:
    type: Literal["screen_context_started"] = "screen_context_started"
    mode: str = "ocr"


@dataclass
class ScreenOcrDoneEvent:
    type: Literal["screen_ocr_done"] = "screen_ocr_done"
    engine: str = ""
    text_length: int = 0
    confidence: float = 0.0


@dataclass
class ScreenContextReadyEvent:
    type: Literal["screen_context_ready"] = "screen_context_ready"
    context_id: str = ""
    mode: str = "ocr"


@dataclass
class ScreenContextErrorEvent:
    type: Literal["screen_context_error"] = "screen_context_error"
    message: str = ""
    stage: str = ""
    method: str = ""


@dataclass
class WakeListeningEvent:
    type: Literal["wake_listening"] = "wake_listening"
    model: str = ""
    threshold: float = 0.0


@dataclass
class WakeDetectedEvent:
    type: Literal["wake_detected"] = "wake_detected"
    model: str = ""


@dataclass
class WakeStoppedEvent:
    type: Literal["wake_stopped"] = "wake_stopped"


@dataclass
class GoalStartedEvent:
    type: Literal["goal_started"] = "goal_started"
    goal: str = ""


@dataclass
class GoalProgressEvent:
    type: Literal["goal_progress"] = "goal_progress"
    iteration: int = 0
    max_iterations: int = 10
    phase: str = ""  # "thinking", "tool_started", "tool_finished", "answer"
    detail: str = ""


@dataclass
class GoalToolEvent:
    type: Literal["goal_tool"] = "goal_tool"
    tool: str = ""
    args: str = ""  # JSON string
    success: bool = False
    output: str = ""


@dataclass
class GoalFinishedEvent:
    type: Literal["goal_finished"] = "goal_finished"
    answer: str = ""
    iterations: int = 0
    tools_used: int = 0


@dataclass
class GoalConfirmationEvent:
    type: Literal["goal_confirmation"] = "goal_confirmation"
    question: str = ""
    pending_tool: str = ""
    pending_args: str = ""  # JSON string


BackendEvent = (
    HelloEvent
    | StateEvent
    | BackendStatusEvent
    | AudioLevelEvent
    | VoiceActivityEvent
    | RecordingAutoStoppingEvent
    | RecordingStoppedEvent
    | TranscriptEvent
    | PartialTranscriptEvent
    | OperationCancelledEvent
    | AnswerStartEvent
    | AnswerDeltaEvent
    | AnswerDoneEvent
    | CommandApprovalEvent
    | CommandRunningEvent
    | CommandResultEvent
    | ErrorEvent
    | TimingEvent
    | SettingsEvent
    | SettingsSavedEvent
    | SettingsErrorEvent
    | ProviderTestResultEvent
    | ProviderModelsEvent
    | ProviderModelsErrorEvent
    | DiagnosticsEvent
    | CapabilitiesEvent
    | ConversationStateEvent
    | AudioInputTestStartedEvent
    | AudioInputTestLevelEvent
    | AudioInputTestStoppedEvent
    | AudioInputTestErrorEvent
    | ContextPreviewEvent
    | ConversationClearedEvent
    | ModelProfilesEvent
    | ModelProfileSetEvent
    | ScreenCaptureStartedEvent
    | ScreenCaptureDoneEvent
    | ScreenContextStartedEvent
    | ScreenOcrDoneEvent
    | ScreenContextReadyEvent
    | ScreenContextErrorEvent
    | WakeListeningEvent
    | WakeDetectedEvent
    | WakeStoppedEvent
    | GoalStartedEvent
    | GoalProgressEvent
    | GoalToolEvent
    | GoalFinishedEvent
    | GoalConfirmationEvent
)


def serialize_event(event: BackendEvent) -> str:
    """Convert a BackendEvent dataclass to a JSON string."""
    import json

    data: dict[str, Any] = {}
    for key in event.__dataclass_fields__:
        if key == "type":
            continue
        v = getattr(event, key)
        if v is not None:
            data[key] = v
    data["type"] = event.type
    return json.dumps(data, default=str)


# ── Frontend → backend commands ─────────────────────────────────


@dataclass
class PingCommand:
    type: Literal["ping"] = "ping"


@dataclass
class StartRecordingCommand:
    type: Literal["start_recording"] = "start_recording"


@dataclass
class StopRecordingCommand:
    type: Literal["stop_recording"] = "stop_recording"


@dataclass
class CancelRecordingCommand:
    type: Literal["cancel_recording"] = "cancel_recording"


@dataclass
class CancelCurrentOperationCommand:
    type: Literal["cancel_current_operation"] = "cancel_current_operation"


@dataclass
class ApproveCommandCommand:
    type: Literal["approve_command"] = "approve_command"


@dataclass
class DenyCommandCommand:
    type: Literal["deny_command"] = "deny_command"


@dataclass
class SubmitTextPromptCommand:
    type: Literal["submit_text_prompt"] = "submit_text_prompt"
    text: str = ""
    context: dict[str, Any] = field(default_factory=dict)
    conversation_mode: bool | None = None


@dataclass
class GetSettingsCommand:
    type: Literal["get_settings"] = "get_settings"


@dataclass
class UpdateSettingsCommand:
    type: Literal["update_settings"] = "update_settings"
    settings: dict[str, Any] = field(default_factory=dict)


@dataclass
class TestProviderCommand:
    type: Literal["test_provider"] = "test_provider"
    provider_id: str = ""
    base_url: str = ""
    api_key: str = ""
    model: str = ""


@dataclass
class ListProviderModelsCommand:
    type: Literal["list_provider_models"] = "list_provider_models"
    provider_id: str = ""
    base_url: str = ""
    api_key: str = ""


@dataclass
class DeleteApiKeyCommand:
    type: Literal["delete_api_key"] = "delete_api_key"


@dataclass
class OpenLogsCommand:
    type: Literal["open_logs"] = "open_logs"


@dataclass
class OpenConfigFolderCommand:
    type: Literal["open_config_folder"] = "open_config_folder"


@dataclass
class ResetSettingsCommand:
    type: Literal["reset_settings"] = "reset_settings"


@dataclass
class GetDiagnosticsCommand:
    type: Literal["get_diagnostics"] = "get_diagnostics"


@dataclass
class GetCapabilitiesCommand:
    type: Literal["get_capabilities"] = "get_capabilities"


@dataclass
class ClearConversationCommand:
    type: Literal["clear_conversation"] = "clear_conversation"


@dataclass
class GetConversationStateCommand:
    type: Literal["get_conversation_state"] = "get_conversation_state"


@dataclass
class GetContextPreviewCommand:
    type: Literal["get_context_preview"] = "get_context_preview"


@dataclass
class SetConversationModeCommand:
    type: Literal["set_conversation_mode"] = "set_conversation_mode"
    enabled: bool = False


@dataclass
class StartAudioInputTestCommand:
    type: Literal["start_audio_input_test"] = "start_audio_input_test"


@dataclass
class StopAudioInputTestCommand:
    type: Literal["stop_audio_input_test"] = "stop_audio_input_test"


@dataclass
class UpdateVoiceSettingsCommand:
    type: Literal["update_voice_settings"] = "update_voice_settings"
    settings: dict[str, Any] = field(default_factory=dict)


@dataclass
class GetModelProfilesCommand:
    type: Literal["get_model_profiles"] = "get_model_profiles"


@dataclass
class SetModelProfileCommand:
    type: Literal["set_model_profile"] = "set_model_profile"
    profile: str = ""


@dataclass
class RequestCommandApprovalCommand:
    type: Literal["request_command_approval"] = "request_command_approval"
    command: str = ""
    reason: str = ""


@dataclass
class ExplainCommandCommand:
    type: Literal["explain_command"] = "explain_command"
    command: str = ""


@dataclass
class CaptureScreenContextCommand:
    type: Literal["capture_screen_context"] = "capture_screen_context"
    mode: str = "auto"
    image_path: str = ""
    mime_type: str = "image/png"
    width: int = 0
    height: int = 0
    method: str = ""


@dataclass
class SubmitScreenQuestionCommand:
    type: Literal["submit_screen_question"] = "submit_screen_question"
    question: str = ""
    context_id: str = ""


@dataclass
class AskAboutScreenCommand:
    type: Literal["ask_about_screen"] = "ask_about_screen"
    question: str = ""
    mode: str = "auto"


@dataclass
class StartWakeWordCommand:
    type: Literal["start_wake_word"] = "start_wake_word"


@dataclass
class StopWakeWordCommand:
    type: Literal["stop_wake_word"] = "stop_wake_word"


@dataclass
class SubmitGoalCommand:
    type: Literal["submit_goal"] = "submit_goal"
    goal: str = ""
    context: str = ""


FrontendCommand = (
    PingCommand
    | StartRecordingCommand
    | StopRecordingCommand
    | CancelRecordingCommand
    | CancelCurrentOperationCommand
    | ApproveCommandCommand
    | DenyCommandCommand
    | SubmitTextPromptCommand
    | GetSettingsCommand
    | UpdateSettingsCommand
    | TestProviderCommand
    | ListProviderModelsCommand
    | DeleteApiKeyCommand
    | OpenLogsCommand
    | OpenConfigFolderCommand
    | ResetSettingsCommand
    | GetDiagnosticsCommand
    | GetCapabilitiesCommand
    | ClearConversationCommand
    | GetConversationStateCommand
    | GetContextPreviewCommand
    | SetConversationModeCommand
    | StartAudioInputTestCommand
    | StopAudioInputTestCommand
    | UpdateVoiceSettingsCommand
    | GetModelProfilesCommand
    | SetModelProfileCommand
    | RequestCommandApprovalCommand
    | ExplainCommandCommand
    | CaptureScreenContextCommand
    | SubmitScreenQuestionCommand
    | AskAboutScreenCommand
    | StartWakeWordCommand
    | StopWakeWordCommand
    | SubmitGoalCommand
)


def parse_command(raw: str) -> FrontendCommand | ErrorEvent:
    """Parse a JSON string into a FrontendCommand.

    Returns an ``ErrorEvent`` on invalid JSON or unknown type.
    """
    import json

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        return ErrorEvent(message=f"Invalid JSON: {e}")

    if not isinstance(data, dict):
        return ErrorEvent(message="Expected JSON object")

    typ = data.get("type", "")

    mapping: dict[str, type] = {
        "ping": PingCommand,
        "start_recording": StartRecordingCommand,
        "stop_recording": StopRecordingCommand,
        "cancel_recording": CancelRecordingCommand,
        "cancel_current_operation": CancelCurrentOperationCommand,
        "approve_command": ApproveCommandCommand,
        "deny_command": DenyCommandCommand,
        "submit_text_prompt": SubmitTextPromptCommand,
        "get_settings": GetSettingsCommand,
        "update_settings": UpdateSettingsCommand,
        "test_provider": TestProviderCommand,
        "list_provider_models": ListProviderModelsCommand,
        "delete_api_key": DeleteApiKeyCommand,
        "open_logs": OpenLogsCommand,
        "open_config_folder": OpenConfigFolderCommand,
        "reset_settings": ResetSettingsCommand,
        "get_diagnostics": GetDiagnosticsCommand,
        "get_capabilities": GetCapabilitiesCommand,
        "clear_conversation": ClearConversationCommand,
        "get_conversation_state": GetConversationStateCommand,
        "get_context_preview": GetContextPreviewCommand,
        "set_conversation_mode": SetConversationModeCommand,
        "start_audio_input_test": StartAudioInputTestCommand,
        "stop_audio_input_test": StopAudioInputTestCommand,
        "update_voice_settings": UpdateVoiceSettingsCommand,
        "get_model_profiles": GetModelProfilesCommand,
        "set_model_profile": SetModelProfileCommand,
        "request_command_approval": RequestCommandApprovalCommand,
        "explain_command": ExplainCommandCommand,
        "capture_screen_context": CaptureScreenContextCommand,
        "submit_screen_question": SubmitScreenQuestionCommand,
        "ask_about_screen": AskAboutScreenCommand,
        "start_wake_word": StartWakeWordCommand,
        "stop_wake_word": StopWakeWordCommand,
        "submit_goal": SubmitGoalCommand,
    }

    cls = mapping.get(typ)
    if cls is None:
        return ErrorEvent(message=f"Unknown message type: {typ}")

    return cast(FrontendCommand, cls(**{k: v for k, v in data.items() if k != "type"}))
