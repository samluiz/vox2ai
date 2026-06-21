use serde::Serialize;
use crate::detection::{DesktopSession, SessionType, DesktopEnvironment};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ActivationBackendKind {
    X11GlobalHotkey,
    GnomeShortcutBridge,
    XdgPortalGlobalShortcuts,
    Unsupported,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivationBackendStatus {
    pub kind: ActivationBackendKind,
    pub available: bool,
    pub active: bool,
    pub session_type: String,
    pub desktop: String,
    pub shortcut: Option<String>,
    pub message: String,
    pub details: Option<String>,
}

pub trait ActivationBackend: Send + Sync {
    fn kind(&self) -> ActivationBackendKind;
    fn probe(&self) -> ActivationBackendStatus;
    fn update_shortcut(&self, shortcut: &str) -> Result<ActivationBackendStatus, String>;
    fn disable(&self) -> Result<ActivationBackendStatus, String>;
    fn verify(&self) -> Result<ActivationBackendStatus, String>;
}

pub fn select_backend(session: &DesktopSession) -> ActivationBackendKind {
    match session.session_type {
        SessionType::X11 => ActivationBackendKind::X11GlobalHotkey,
        SessionType::Wayland => {
            if session.desktop == DesktopEnvironment::Gnome {
                ActivationBackendKind::GnomeShortcutBridge
            } else {
                ActivationBackendKind::Unsupported
            }
        }
        SessionType::Unknown => {
            if session.desktop == DesktopEnvironment::Gnome {
                ActivationBackendKind::GnomeShortcutBridge
            } else {
                ActivationBackendKind::Unsupported
            }
        }
    }
}

pub fn backend_message(kind: ActivationBackendKind, session: &DesktopSession) -> String {
    match kind {
        ActivationBackendKind::X11GlobalHotkey => {
            "Direct global shortcut active.".to_string()
        }
        ActivationBackendKind::GnomeShortcutBridge => {
            "Wayland session detected. Use GNOME Shortcut Bridge for global shortcuts.".to_string()
        }
        ActivationBackendKind::XdgPortalGlobalShortcuts => {
            "XDG GlobalShortcuts portal available (experimental).".to_string()
        }
        ActivationBackendKind::Unsupported => {
            if session.session_type == SessionType::Wayland {
                format!(
                    "Global shortcuts are not available on {} Wayland. \
                     Use a GNOME session or configure a system-level shortcut manually.",
                    match &session.desktop {
                        DesktopEnvironment::Unknown => "this".to_string(),
                        d => format!("{}", serde_json::to_string(d).unwrap_or_default()),
                    }
                )
            } else {
                "Global shortcut backend unavailable.".to_string()
            }
        }
    }
}
