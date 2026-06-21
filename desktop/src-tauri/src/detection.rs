use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SessionType {
    X11,
    Wayland,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum DesktopEnvironment {
    Gnome,
    Kde,
    Sway,
    Hyprland,
    Other(String),
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesktopSession {
    pub session_type: SessionType,
    pub desktop: DesktopEnvironment,
    pub xdg_session_type: Option<String>,
    pub wayland_display: Option<String>,
    pub display: Option<String>,
    pub xdg_current_desktop: Option<String>,
    pub desktop_session: Option<String>,
    pub gnome_shell_session_mode: Option<String>,
}

pub fn detect_session() -> DesktopSession {
    let xdg_session_type = std::env::var("XDG_SESSION_TYPE").ok();
    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
    let display = std::env::var("DISPLAY").ok();
    let xdg_current_desktop = std::env::var("XDG_CURRENT_DESKTOP").ok();
    let desktop_session = std::env::var("DESKTOP_SESSION").ok();
    let gnome_shell_session_mode = std::env::var("GNOME_SHELL_SESSION_MODE").ok();

    let session_type = detect_session_type(&xdg_session_type, &wayland_display, &display);
    let desktop = detect_desktop(&xdg_current_desktop, &desktop_session, &gnome_shell_session_mode);

    DesktopSession {
        session_type,
        desktop,
        xdg_session_type,
        wayland_display,
        display,
        xdg_current_desktop,
        desktop_session,
        gnome_shell_session_mode,
    }
}

pub fn detect_session_type(
    xdg_session_type: &Option<String>,
    wayland_display: &Option<String>,
    display: &Option<String>,
) -> SessionType {
    if let Some(s) = xdg_session_type {
        if s.eq_ignore_ascii_case("wayland") {
            return SessionType::Wayland;
        }
        if s.eq_ignore_ascii_case("x11") {
            return SessionType::X11;
        }
    }
    if wayland_display.is_some() {
        return SessionType::Wayland;
    }
    if display.is_some() {
        return SessionType::X11;
    }
    SessionType::Unknown
}

pub fn detect_desktop(
    xdg_current_desktop: &Option<String>,
    desktop_session: &Option<String>,
    gnome_shell_session_mode: &Option<String>,
) -> DesktopEnvironment {
    if let Some(d) = xdg_current_desktop {
        let lower = d.to_lowercase();
        if lower.contains("gnome") {
            return DesktopEnvironment::Gnome;
        }
        if lower.contains("kde") || lower.contains("plasma") {
            return DesktopEnvironment::Kde;
        }
        if lower.contains("sway") {
            return DesktopEnvironment::Sway;
        }
        if lower.contains("hyprland") {
            return DesktopEnvironment::Hyprland;
        }
    }
    if let Some(s) = desktop_session {
        let lower = s.to_lowercase();
        if lower.contains("gnome") {
            return DesktopEnvironment::Gnome;
        }
        if lower.contains("plasma") || lower.contains("kde") {
            return DesktopEnvironment::Kde;
        }
    }
    if gnome_shell_session_mode.is_some() {
        return DesktopEnvironment::Gnome;
    }
    DesktopEnvironment::Unknown
}

pub fn is_session_wayland(session: &DesktopSession) -> bool {
    session.session_type == SessionType::Wayland
}

pub fn is_desktop_gnome(session: &DesktopSession) -> bool {
    session.desktop == DesktopEnvironment::Gnome
}
