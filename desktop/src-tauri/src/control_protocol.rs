use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SummonBehavior {
    ShowWidget,
    ShowAndRecord,
    ShowAndFocusInput,
    ToggleWidget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlCommand {
    Summon {
        behavior: SummonBehavior,
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "snake_case")]
    OpenSettings {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "snake_case")]
    OpenDiagnostics {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "snake_case")]
    StartRecording {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "snake_case")]
    StopRecording {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "snake_case")]
    Cancel {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "snake_case")]
    RestartBackend {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
    #[serde(rename_all = "snake_case")]
    Status {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub status: Option<AppStatusPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppStatusPayload {
    pub app: String,
    pub backend: String,
    pub connected: bool,
    pub recording: bool,
    pub visible: bool,
    pub activation_backend: String,
}

impl ControlResponse {
    pub fn ok(message: impl Into<String>) -> Self {
        ControlResponse {
            ok: true,
            message: Some(message.into()),
            error: None,
            status: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        ControlResponse {
            ok: false,
            message: None,
            error: Some(message.into()),
            status: None,
        }
    }

    pub fn status(status: AppStatusPayload) -> Self {
        ControlResponse {
            ok: true,
            message: Some("ok".to_string()),
            error: None,
            status: Some(status),
        }
    }
}

impl std::fmt::Display for ControlCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ControlCommand::Summon { behavior, .. } => match behavior {
                SummonBehavior::ShowWidget => write!(f, "summon"),
                SummonBehavior::ShowAndRecord => write!(f, "summon --record"),
                SummonBehavior::ShowAndFocusInput => write!(f, "summon --focus-input"),
                SummonBehavior::ToggleWidget => write!(f, "toggle"),
            },
            ControlCommand::OpenSettings { .. } => write!(f, "open-settings"),
            ControlCommand::OpenDiagnostics { .. } => write!(f, "open-diagnostics"),
            ControlCommand::StartRecording { .. } => write!(f, "start-recording"),
            ControlCommand::StopRecording { .. } => write!(f, "stop-recording"),
            ControlCommand::Cancel { .. } => write!(f, "cancel"),
            ControlCommand::RestartBackend { .. } => write!(f, "restart-backend"),
            ControlCommand::Status { .. } => write!(f, "status"),
        }
    }
}
