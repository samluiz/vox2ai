pub mod activation_backend;
pub mod control_protocol;
pub mod control_server;
pub mod detection;
pub mod gnome_bridge;

use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Clone)]
pub struct SidecarState(pub Arc<Mutex<SidecarInner>>);

#[derive(Clone)]
pub struct ActivationState(pub Arc<Mutex<ActivationInner>>);

#[derive(Clone)]
pub struct WindowRuntimeState(pub Arc<Mutex<WindowRuntimeInner>>);

pub struct SidecarInner {
    child: Option<Child>,
    runtime_state: BackendRuntimeState,
    attempts: usize,
    auto_restart: bool,
    shutting_down: bool,
    generation: u64,
    current_url: Option<String>,
    last_error: Option<String>,
}

pub struct ActivationInner {
    shortcut: Option<String>,
    behavior: String,
    registration_error: Option<String>,
}

pub struct WindowRuntimeInner {
    minimize_to_tray: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum BackendRuntimeState {
    Starting,
    Running,
    Restarting,
    Stopped,
    Failed,
}

#[derive(Clone, Serialize)]
struct BackendReadyPayload {
    url: String,
}

#[derive(Clone, Serialize)]
struct BackendRuntimePayload {
    state: BackendRuntimeState,
    message: String,
    attempts: usize,
    url: Option<String>,
    log_path: String,
}

#[derive(Clone, Serialize)]
struct ActivationRuntimeStatus {
    registered: bool,
    shortcut: Option<String>,
    behavior: String,
    error: Option<String>,
    global_shortcut_supported: bool,
    platform: String,
    message: Option<String>,
    start_at_login_supported: bool,
    start_at_login_enabled: bool,
}

#[derive(Clone, Serialize)]
struct AutostartStatus {
    supported: bool,
    enabled: bool,
    message: String,
}

#[derive(Clone, Serialize)]
struct GlobalShortcutPayload {
    shortcut: String,
    behavior: String,
}

#[derive(Clone, Serialize)]
struct ActiveWindowContext {
    app: String,
    title: String,
}

#[derive(Debug, Deserialize)]
struct RuntimeSettingsPayload {
    minimize_to_tray: Option<bool>,
    start_at_login: Option<bool>,
    auto_restart_backend: Option<bool>,
    global_shortcut: Option<String>,
    shortcut_behavior: Option<String>,
}

const SRC_BINARIES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/binaries");
const BACKOFF_SECONDS: [u64; 5] = [1, 2, 5, 10, 10];

fn find_sidecar_binary(app: &AppHandle) -> Result<StdCommand, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("binaries"));
    }
    candidates.push(PathBuf::from(SRC_BINARIES_DIR));

    for dir in &candidates {
        if !dir.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("vox2ai-server") && !name_str.ends_with(".sig") {
                return Ok(StdCommand::new(entry.path()));
            }
        }
    }

    Err(format!(
        "vox2ai-server binary not found (tried: {})",
        candidates
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn log_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("vox2ai"))
        .join("vox2ai-sidecar.log")
}

fn open_log(app: &AppHandle) -> Option<File> {
    let path = log_path(app);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

fn write_log(log: &mut Option<File>, line: &str) {
    if let Some(file) = log.as_mut() {
        let _ = writeln!(file, "{line}");
    }
}

fn emit_runtime(app: &AppHandle, state: &SidecarState, message: impl Into<String>) {
    let inner = state.0.lock().unwrap();
    let payload = BackendRuntimePayload {
        state: inner.runtime_state.clone(),
        message: message.into(),
        attempts: inner.attempts,
        url: inner.current_url.clone(),
        log_path: log_path(app).display().to_string(),
    };
    let _ = app.emit("backend_runtime_state", payload);
}

fn kill_child(child: &mut Option<Child>) {
    if let Some(ref mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    *child = None;
}

fn spawn_sidecar(app: AppHandle, state: SidecarState) {
    thread::spawn(move || {
        let generation = {
            let mut inner = state.0.lock().unwrap();
            if inner.child.is_some() {
                return;
            }
            inner.generation += 1;
            inner.runtime_state = BackendRuntimeState::Starting;
            inner.current_url = None;
            inner.last_error = None;
            inner.generation
        };
        emit_runtime(&app, &state, "Backend starting...");

        let mut cmd = match find_sidecar_binary(&app) {
            Ok(c) => c,
            Err(e) => {
                handle_sidecar_failure(app, state, generation, e);
                return;
            }
        };
        cmd.args(["--host", "127.0.0.1", "--port", "0"]);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                handle_sidecar_failure(app, state, generation, format!("failed to spawn: {e}"));
                return;
            }
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        {
            let mut inner = state.0.lock().unwrap();
            if inner.generation != generation {
                let mut child_to_kill = Some(child);
                kill_child(&mut child_to_kill);
                return;
            }
            inner.child = Some(child);
        }

        if let Some(stdout) = stdout {
            let app_for_stdout = app.clone();
            let state_for_stdout = state.clone();
            thread::spawn(move || {
                read_sidecar_stdout(app_for_stdout, state_for_stdout, generation, stdout);
            });
        }

        if let Some(stderr) = stderr {
            let app_for_stderr = app.clone();
            thread::spawn(move || {
                let mut log = open_log(&app_for_stderr);
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    write_log(&mut log, &format!("[stderr] {line}"));
                }
            });
        }

        monitor_sidecar(app, state, generation);
    });
}

fn read_sidecar_stdout(
    app: AppHandle,
    state: SidecarState,
    generation: u64,
    stdout: std::process::ChildStdout,
) {
    let mut log = open_log(&app);
    let reader = BufReader::new(stdout);
    for line in reader.lines().map_while(Result::ok) {
        write_log(&mut log, &format!("[stdout] {line}"));
        let trimmed = line.trim();
        let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if val.get("type").and_then(|v| v.as_str()) != Some("server_ready") {
            continue;
        }
        let host = val
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("127.0.0.1");
        let port = val.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
        let url = format!("ws://{host}:{port}");
        {
            let mut inner = state.0.lock().unwrap();
            if inner.generation != generation {
                return;
            }
            inner.runtime_state = BackendRuntimeState::Running;
            inner.current_url = Some(url.clone());
            inner.attempts = 0;
            inner.last_error = None;
        }
        let _ = app.emit("backend_ready", BackendReadyPayload { url });
        emit_runtime(&app, &state, "Backend running.");
    }
}

fn monitor_sidecar(app: AppHandle, state: SidecarState, generation: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        let exit_message = {
            let mut inner = state.0.lock().unwrap();
            if inner.generation != generation {
                return;
            }
            let Some(child) = inner.child.as_mut() else {
                return;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    inner.child = None;
                    Some(format!("Backend exited with {status}."))
                }
                Ok(None) => None,
                Err(e) => {
                    inner.child = None;
                    Some(format!("Backend status check failed: {e}"))
                }
            }
        };

        if let Some(message) = exit_message {
            handle_sidecar_failure(app, state, generation, message);
            return;
        }
    });
}

fn handle_sidecar_failure(app: AppHandle, state: SidecarState, generation: u64, message: String) {
    let retry_delay = {
        let mut inner = state.0.lock().unwrap();
        if inner.generation != generation || inner.shutting_down {
            return;
        }
        inner.last_error = Some(message.clone());
        inner.child = None;
        if !inner.auto_restart || inner.attempts >= BACKOFF_SECONDS.len() {
            inner.runtime_state = BackendRuntimeState::Failed;
            None
        } else {
            inner.runtime_state = BackendRuntimeState::Restarting;
            inner.attempts += 1;
            Some(BACKOFF_SECONDS[inner.attempts - 1])
        }
    };

    let _ = app.emit("backend_error", message.clone());
    emit_runtime(&app, &state, message);

    if let Some(delay) = retry_delay {
        let app_clone = app.clone();
        let state_clone = state.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(delay));
            let should_restart = {
                let inner = state_clone.0.lock().unwrap();
                inner.generation == generation
                    && !inner.shutting_down
                    && inner.child.is_none()
                    && inner.auto_restart
            };
            if should_restart {
                spawn_sidecar(app_clone, state_clone);
            }
        });
    }
}

fn restart_backend_impl(app: AppHandle, state: SidecarState) -> Result<(), String> {
    {
        let mut inner = state
            .0
            .lock()
            .map_err(|_| "backend lock poisoned".to_string())?;
        inner.generation += 1;
        inner.shutting_down = false;
        inner.runtime_state = BackendRuntimeState::Restarting;
        inner.attempts = 0;
        inner.current_url = None;
        kill_child(&mut inner.child);
    }
    emit_runtime(&app, &state, "Restarting backend...");
    spawn_sidecar(app, state);
    Ok(())
}

fn stop_backend(app: &AppHandle, state: &SidecarState) {
    {
        let mut inner = state.0.lock().unwrap();
        inner.shutting_down = true;
        inner.generation += 1;
        inner.runtime_state = BackendRuntimeState::Stopped;
        kill_child(&mut inner.child);
    }
    emit_runtime(app, state, "Backend stopped.");
}

fn parse_shortcut(input: &str) -> Result<Shortcut, String> {
    let mut modifiers = Modifiers::empty();
    let mut code: Option<Code> = None;

    for raw in input.split('+') {
        let part = raw.trim();
        match part {
            "Ctrl" | "Control" => modifiers |= Modifiers::CONTROL,
            "Alt" | "Option" => modifiers |= Modifiers::ALT,
            "Shift" => modifiers |= Modifiers::SHIFT,
            "Super" | "Cmd" | "Command" | "Meta" => modifiers |= Modifiers::SUPER,
            "Space" => code = Some(Code::Space),
            "F1" => code = Some(Code::F1),
            "F2" => code = Some(Code::F2),
            "F3" => code = Some(Code::F3),
            "F4" => code = Some(Code::F4),
            "F5" => code = Some(Code::F5),
            "F6" => code = Some(Code::F6),
            "F7" => code = Some(Code::F7),
            "F8" => code = Some(Code::F8),
            "F9" => code = Some(Code::F9),
            "F10" => code = Some(Code::F10),
            "F11" => code = Some(Code::F11),
            "F12" => code = Some(Code::F12),
            key if key.len() == 1 && key.chars().all(|c| c.is_ascii_alphabetic()) => {
                let upper = key.to_ascii_uppercase();
                code = Some(match upper.as_str() {
                    "A" => Code::KeyA,
                    "B" => Code::KeyB,
                    "C" => Code::KeyC,
                    "D" => Code::KeyD,
                    "E" => Code::KeyE,
                    "F" => Code::KeyF,
                    "G" => Code::KeyG,
                    "H" => Code::KeyH,
                    "I" => Code::KeyI,
                    "J" => Code::KeyJ,
                    "K" => Code::KeyK,
                    "L" => Code::KeyL,
                    "M" => Code::KeyM,
                    "N" => Code::KeyN,
                    "O" => Code::KeyO,
                    "P" => Code::KeyP,
                    "Q" => Code::KeyQ,
                    "R" => Code::KeyR,
                    "S" => Code::KeyS,
                    "T" => Code::KeyT,
                    "U" => Code::KeyU,
                    "V" => Code::KeyV,
                    "W" => Code::KeyW,
                    "X" => Code::KeyX,
                    "Y" => Code::KeyY,
                    "Z" => Code::KeyZ,
                    _ => return Err(format!("Unsupported shortcut key: {key}")),
                });
            }
            key if key.len() == 1 && key.chars().all(|c| c.is_ascii_digit()) => {
                code = Some(match key {
                    "0" => Code::Digit0,
                    "1" => Code::Digit1,
                    "2" => Code::Digit2,
                    "3" => Code::Digit3,
                    "4" => Code::Digit4,
                    "5" => Code::Digit5,
                    "6" => Code::Digit6,
                    "7" => Code::Digit7,
                    "8" => Code::Digit8,
                    "9" => Code::Digit9,
                    _ => return Err(format!("Unsupported shortcut key: {key}")),
                });
            }
            "" => {}
            other => return Err(format!("Unsupported shortcut key: {other}")),
        }
    }

    let Some(code) = code else {
        return Err("Global activation shortcut must include a non-modifier key.".to_string());
    };

    let modifiers = if modifiers.is_empty() {
        None
    } else {
        Some(modifiers)
    };
    Ok(Shortcut::new(modifiers, code))
}

fn global_shortcut_platform_status() -> (bool, String, Option<String>) {
    #[cfg(target_os = "linux")]
    {
        let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| {
            if std::env::var_os("WAYLAND_DISPLAY").is_some() {
                "wayland".to_string()
            } else if std::env::var_os("DISPLAY").is_some() {
                "x11".to_string()
            } else {
                "unknown".to_string()
            }
        });
        let platform = format!("linux/{session}");
        if session.eq_ignore_ascii_case("wayland") {
            return (
                false,
                platform,
                Some(
                    "Global shortcuts are not available in this build on Wayland. Use an X11 session or configure a desktop-level shortcut.".to_string(),
                ),
            );
        }
        if std::env::var_os("DISPLAY").is_none() {
            return (
                false,
                platform,
                Some("Global shortcuts need an X11 DISPLAY on Linux.".to_string()),
            );
        }
        return (true, platform, None);
    }

    #[cfg(not(target_os = "linux"))]
    {
        (true, std::env::consts::OS.to_string(), None)
    }
}

fn apply_global_shortcut(
    app: &AppHandle,
    activation: &ActivationState,
    shortcut: String,
    behavior: String,
) -> ActivationRuntimeStatus {
    let manager = app.global_shortcut();
    let (supported, _platform, platform_message) = global_shortcut_platform_status();
    let previous_shortcut = {
        let inner = activation.0.lock().unwrap();
        inner.shortcut.clone()
    };
    if let Some(previous) = previous_shortcut {
        if let Ok(parsed) = parse_shortcut(&previous) {
            let _ = manager.unregister(parsed);
        }
    }

    let mut inner = activation.0.lock().unwrap();
    inner.behavior = behavior.clone();

    if !supported {
        inner.shortcut = None;
        inner.registration_error = platform_message.clone();
        return activation_status(app, activation);
    }

    match parse_shortcut(&shortcut) {
        Ok(parsed) => match manager.register(parsed) {
            Ok(()) if manager.is_registered(parsed) => {
                eprintln!("[vox2ai] registered global shortcut: {shortcut}");
                inner.shortcut = Some(shortcut.clone());
                inner.registration_error = None;
            }
            Ok(()) => {
                inner.shortcut = None;
                inner.registration_error = Some(
                    "Shortcut registration did not fail, but the shortcut is not active."
                        .to_string(),
                );
            }
            Err(error) => {
                inner.shortcut = None;
                inner.registration_error = Some(error.to_string());
            }
        },
        Err(error) => {
            inner.shortcut = None;
            inner.registration_error = Some(error);
        }
    };

    activation_status(app, activation)
}

fn activation_status(app: &AppHandle, activation: &ActivationState) -> ActivationRuntimeStatus {
    let inner = activation.0.lock().unwrap();
    let (supported, platform, platform_message) = global_shortcut_platform_status();
    let message = platform_message.or_else(|| {
        if inner.registration_error.is_none() && inner.shortcut.is_some() {
            Some(format!(
                "Listening for {} on {platform}.",
                inner.shortcut.as_deref().unwrap_or("")
            ))
        } else {
            None
        }
    });
    ActivationRuntimeStatus {
        registered: inner.shortcut.is_some() && inner.registration_error.is_none(),
        shortcut: inner.shortcut.clone(),
        behavior: inner.behavior.clone(),
        error: inner.registration_error.clone(),
        global_shortcut_supported: supported,
        platform,
        message,
        start_at_login_supported: cfg!(target_os = "linux"),
        start_at_login_enabled: autostart_enabled(app).unwrap_or(false),
    }
}

fn show_widget(app: &AppHandle, focus: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        if focus {
            let _ = window.set_focus();
        }
    }
}

fn handle_global_shortcut(app: &AppHandle) {
    let (shortcut, behavior) = {
        let Some(state) = app.try_state::<ActivationState>() else {
            return;
        };
        let inner = state.0.lock().unwrap();
        (
            inner
                .shortcut
                .clone()
                .unwrap_or_else(|| "Ctrl+Space".to_string()),
            inner.behavior.clone(),
        )
    };

    if behavior == "toggle-widget" {
        if let Some(window) = app.get_webview_window("main") {
            let visible = window.is_visible().unwrap_or(false);
            if visible {
                let _ = window.hide();
            } else {
                show_widget(app, true);
            }
        }
    } else {
        show_widget(app, behavior != "show-and-record");
    }

    let _ = app.emit(
        "global_shortcut_pressed",
        GlobalShortcutPayload { shortcut, behavior },
    );
}

fn xdg_autostart_path() -> Option<PathBuf> {
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(config_home.join("autostart").join("vox2ai.desktop"))
}

fn autostart_desktop_entry(_app: &AppHandle) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exec = exe
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace(' ', "\\ ");
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=vox2ai\nComment=Desktop voice assistant\nExec={exec}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
    ))
}

fn autostart_enabled(_app: &AppHandle) -> Result<bool, String> {
    if !cfg!(target_os = "linux") {
        return Ok(false);
    }
    let Some(path) = xdg_autostart_path() else {
        return Ok(false);
    };
    Ok(path.is_file())
}

fn set_autostart(app: &AppHandle, enabled: bool) -> AutostartStatus {
    if !cfg!(target_os = "linux") {
        return AutostartStatus {
            supported: false,
            enabled: false,
            message: "Start at login is currently implemented for Linux/XDG autostart.".to_string(),
        };
    }
    let Some(path) = xdg_autostart_path() else {
        return AutostartStatus {
            supported: false,
            enabled: false,
            message: "Could not resolve XDG config directory.".to_string(),
        };
    };
    if enabled {
        if let Some(parent) = path.parent() {
            if let Err(e) = fs::create_dir_all(parent) {
                return AutostartStatus {
                    supported: true,
                    enabled: false,
                    message: format!("Could not create autostart directory: {e}"),
                };
            }
        }
        match autostart_desktop_entry(app)
            .and_then(|entry| fs::write(&path, entry).map_err(|e| e.to_string()))
        {
            Ok(()) => AutostartStatus {
                supported: true,
                enabled: true,
                message: "vox2ai will start when you sign in.".to_string(),
            },
            Err(error) => AutostartStatus {
                supported: true,
                enabled: false,
                message: error,
            },
        }
    } else {
        let _ = fs::remove_file(&path);
        AutostartStatus {
            supported: true,
            enabled: false,
            message: "vox2ai will not start at login.".to_string(),
        }
    }
}

#[tauri::command]
fn restart_backend(app: AppHandle, state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    restart_backend_impl(app, state.inner().clone())
}

#[tauri::command]
fn show_widget_command(app: AppHandle) -> Result<(), String> {
    show_widget(&app, true);
    Ok(())
}

#[tauri::command]
fn hide_widget(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle, state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    stop_backend(&app, state.inner());
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn configure_runtime_settings(
    app: AppHandle,
    sidecar: tauri::State<'_, SidecarState>,
    activation: tauri::State<'_, ActivationState>,
    window_runtime: tauri::State<'_, WindowRuntimeState>,
    settings: RuntimeSettingsPayload,
) -> ActivationRuntimeStatus {
    if let Some(minimize_to_tray) = settings.minimize_to_tray {
        let mut inner = window_runtime.0.lock().unwrap();
        inner.minimize_to_tray = minimize_to_tray;
    }
    if let Some(auto_restart) = settings.auto_restart_backend {
        let mut inner = sidecar.0.lock().unwrap();
        inner.auto_restart = auto_restart;
    }
    if let Some(start_at_login) = settings.start_at_login {
        let _ = set_autostart(&app, start_at_login);
    }
    if let Some(shortcut) = settings.global_shortcut {
        let behavior = settings
            .shortcut_behavior
            .unwrap_or_else(|| activation.0.lock().unwrap().behavior.clone());
        apply_global_shortcut(&app, activation.inner(), shortcut, behavior)
    } else {
        if let Some(behavior) = settings.shortcut_behavior {
            activation.0.lock().unwrap().behavior = behavior;
        }
        activation_status(&app, activation.inner())
    }
}

#[tauri::command]
fn get_activation_runtime_status(
    app: AppHandle,
    activation: tauri::State<'_, ActivationState>,
) -> ActivationRuntimeStatus {
    activation_status(&app, activation.inner())
}

#[tauri::command]
fn get_backend_runtime_status(
    app: AppHandle,
    sidecar: tauri::State<'_, SidecarState>,
) -> BackendRuntimePayload {
    let inner = sidecar.0.lock().unwrap();
    BackendRuntimePayload {
        state: inner.runtime_state.clone(),
        message: inner
            .last_error
            .clone()
            .unwrap_or_else(|| "Backend runtime state.".to_string()),
        attempts: inner.attempts,
        url: inner.current_url.clone(),
        log_path: log_path(&app).display().to_string(),
    }
}

#[tauri::command]
fn set_start_at_login(app: AppHandle, enabled: bool) -> AutostartStatus {
    set_autostart(&app, enabled)
}

#[tauri::command]
fn get_active_window_context() -> Result<Option<ActiveWindowContext>, String> {
    Ok(None)
}

// Command implementations are in main.rs to avoid macro conflicts
// with multiple #[tauri::command] functions of the same name.

pub fn handle_control_command(
    app: &AppHandle,
    command: &control_protocol::ControlCommand,
) -> control_protocol::ControlResponse {
    use control_protocol::{ControlCommand as Cmd, SummonBehavior};

    match command {
        Cmd::Summon { behavior, .. } => {
            match behavior {
                SummonBehavior::ShowWidget => {
                    show_widget(app, true);
                    control_protocol::ControlResponse::ok("shown")
                }
                SummonBehavior::ShowAndRecord => {
                    show_widget(app, true);
                    let _ = app.emit("tray_start_recording", ());
                    control_protocol::ControlResponse::ok("summoned and recording")
                }
                SummonBehavior::ShowAndFocusInput => {
                    show_widget(app, true);
                    let _ = app.emit("control_focus_input", ());
                    control_protocol::ControlResponse::ok("summoned and focused input")
                }
                SummonBehavior::ToggleWidget => {
                    if let Some(window) = app.get_webview_window("main") {
                        let visible = window.is_visible().unwrap_or(false);
                        if visible {
                            let _ = window.hide();
                            control_protocol::ControlResponse::ok("hidden")
                        } else {
                            show_widget(app, true);
                            control_protocol::ControlResponse::ok("shown")
                        }
                    } else {
                        control_protocol::ControlResponse::error("No window")
                    }
                }
            }
        }
        Cmd::OpenSettings { .. } => {
            show_widget(app, true);
            let _ = app.emit("tray_open_settings", ());
            control_protocol::ControlResponse::ok("opened settings")
        }
        Cmd::OpenDiagnostics { .. } => {
            show_widget(app, true);
            let _ = app.emit("tray_open_diagnostics", ());
            control_protocol::ControlResponse::ok("opened diagnostics")
        }
        Cmd::StartRecording { .. } => {
            show_widget(app, false);
            let _ = app.emit("tray_start_recording", ());
            control_protocol::ControlResponse::ok("recording")
        }
        Cmd::StopRecording { .. } => {
            let _ = app.emit("control_stop_recording", ());
            control_protocol::ControlResponse::ok("stopped")
        }
        Cmd::Cancel { .. } => {
            let _ = app.emit("control_cancel", ());
            control_protocol::ControlResponse::ok("cancelled")
        }
        Cmd::RestartBackend { .. } => {
            if let Some(state) = app.try_state::<SidecarState>() {
                let _ = app.emit("backend_restarting", ());
                match restart_backend_impl(app.clone(), state.inner().clone()) {
                    Ok(()) => control_protocol::ControlResponse::ok("restarting backend"),
                    Err(e) => control_protocol::ControlResponse::error(e),
                }
            } else {
                control_protocol::ControlResponse::error("Backend state unavailable")
            }
        }
        Cmd::Status { .. } => {
            let backend_state = app
                .try_state::<SidecarState>()
                .map(|s| {
                    let inner = s.0.lock().unwrap();
                    format!("{:?}", inner.runtime_state)
                })
                .unwrap_or_else(|| "unknown".to_string());
            let connected = backend_state == "Running";
            let recording = false; // frontend tracks this; best-effort
            let visible = app
                .get_webview_window("main")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            let activation_kind = {
                let session = detection::detect_session();
                let kind = activation_backend::select_backend(&session);
                format!("{:?}", kind)
            };
            control_protocol::ControlResponse::status(
                control_protocol::AppStatusPayload {
                    app: "running".to_string(),
                    backend: backend_state,
                    connected,
                    recording,
                    visible,
                    activation_backend: activation_kind,
                },
            )
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        handle_global_shortcut(app);
                    }
                })
                .build(),
        )
        .manage(SidecarState(Arc::new(Mutex::new(SidecarInner {
            child: None,
            runtime_state: BackendRuntimeState::Stopped,
            attempts: 0,
            auto_restart: true,
            shutting_down: false,
            generation: 0,
            current_url: None,
            last_error: None,
        }))))
        .manage(ActivationState(Arc::new(Mutex::new(ActivationInner {
            shortcut: None,
            behavior: "show-and-record".to_string(),
            registration_error: None,
        }))))
        .manage(WindowRuntimeState(Arc::new(Mutex::new(
            WindowRuntimeInner {
                minimize_to_tray: true,
            },
        ))))
        .invoke_handler(tauri::generate_handler![
            restart_backend,
            show_widget_command,
            hide_widget,
            quit_app,
            configure_runtime_settings,
            get_activation_runtime_status,
            get_backend_runtime_status,
            set_start_at_login,
            get_active_window_context
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let sidecar = app.state::<SidecarState>().inner().clone();
            spawn_sidecar(handle.clone(), sidecar);

            let activation = app.state::<ActivationState>().inner().clone();
            let _ = apply_global_shortcut(
                &handle,
                &activation,
                "Ctrl+Space".to_string(),
                "show-and-record".to_string(),
            );

            {
                let app_handle = app.handle().clone();
                let handler = Arc::new(move |cmd: control_protocol::ControlCommand| -> control_protocol::ControlResponse {
                    handle_control_command(&app_handle, &cmd)
                });
                let server = control_server::ControlServer::new("vox2ai");
                let _ = server.clean_stale_socket();
                server.start(handler);
            }

            // Tray icon setup — non-fatal on Wayland/GNOME.
            // If it fails (no system tray available), the app still works
            // via global shortcut or the control channel.
            let tray_result: Result<(), Box<dyn std::error::Error>> = (|| {
                let show = MenuItem::with_id(app, "show_widget", "Show widget", true, None::<&str>)?;
                let hide = MenuItem::with_id(app, "hide_widget", "Hide widget", true, None::<&str>)?;
                let record = MenuItem::with_id(
                    app,
                    "start_recording",
                    "Start recording",
                    true,
                    None::<&str>,
                )?;
                let settings =
                    MenuItem::with_id(app, "open_settings", "Open Settings", true, None::<&str>)?;
                let diagnostics = MenuItem::with_id(
                    app,
                    "open_diagnostics",
                    "Open Diagnostics",
                    true,
                    None::<&str>,
                )?;
                let restart = MenuItem::with_id(
                    app,
                    "restart_backend",
                    "Restart backend",
                    true,
                    None::<&str>,
                )?;
                let quit = MenuItem::with_id(app, "quit", "Quit vox2ai", true, None::<&str>)?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &show,
                        &hide,
                        &record,
                        &settings,
                        &diagnostics,
                        &restart,
                        &quit,
                    ],
                )?;
                let tray_icon = app
                    .default_window_icon()
                    .cloned()
                    .ok_or("missing default window icon")?;
                TrayIconBuilder::new()
                    .menu(&menu)
                    .icon(tray_icon)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show_widget" => show_widget(app, true),
                        "hide_widget" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                        "start_recording" => {
                            show_widget(app, false);
                            let _ = app.emit("tray_start_recording", ());
                        }
                        "open_settings" => {
                            show_widget(app, true);
                            let _ = app.emit("tray_open_settings", ());
                        }
                        "open_diagnostics" => {
                            show_widget(app, true);
                            let _ = app.emit("tray_open_diagnostics", ());
                        }
                        "restart_backend" => {
                            if let Some(state) = app.try_state::<SidecarState>() {
                                let _ = app.emit("backend_restarting", ());
                                let _ = restart_backend_impl(app.clone(), state.inner().clone());
                            }
                        }
                        "quit" => {
                            if let Some(state) = app.try_state::<SidecarState>() {
                                stop_backend(app, state.inner());
                            }
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .build(app)?;
                Ok(())
            })();
            if let Err(e) = tray_result {
                eprintln!("[vox2ai] tray icon setup failed (non-fatal): {e}");
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let minimize_to_tray = window
                    .try_state::<WindowRuntimeState>()
                    .map(|state| state.0.lock().unwrap().minimize_to_tray)
                    .unwrap_or(true);
                if minimize_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    if let Some(state) = window.try_state::<SidecarState>() {
                        stop_backend(&window.app_handle(), state.inner());
                    }
                }
            }
            tauri::WindowEvent::Destroyed => {
                if let Some(state) = window.try_state::<SidecarState>() {
                    stop_backend(&window.app_handle(), state.inner());
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
