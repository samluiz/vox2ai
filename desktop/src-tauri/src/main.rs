use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

// ── Re-export lib types ──────────────────────────────────────
pub use vox2ai_desktop_lib::activation_backend;
pub use vox2ai_desktop_lib::control_protocol;
pub use vox2ai_desktop_lib::control_server;
pub use vox2ai_desktop_lib::detection;
pub use vox2ai_desktop_lib::gnome_bridge;

// ── Tauri commands (wrappers around lib functions) ────────────

#[tauri::command]
fn get_desktop_session() -> detection::DesktopSession {
    detection::detect_session()
}

#[tauri::command]
fn get_activation_backend_status(
    _app: AppHandle,
    _activation: tauri::State<'_, ()>,
) -> activation_backend::ActivationBackendStatus {
    let session = detection::detect_session();
    let kind = activation_backend::select_backend(&session);
    activation_backend::ActivationBackendStatus {
        kind,
        available: kind != activation_backend::ActivationBackendKind::Unsupported,
        active: false,
        session_type: format!("{:?}", session.session_type),
        desktop: format!("{:?}", session.desktop),
        shortcut: None,
        message: activation_backend::backend_message(kind, &session),
        details: if kind == activation_backend::ActivationBackendKind::GnomeShortcutBridge {
            Some("GNOME owns the keybinding. Configure via Settings → Keyboard → Custom Shortcuts.".to_string())
        } else {
            None
        },
    }
}

#[tauri::command]
fn get_gnome_bridge_status(app: AppHandle) -> Result<gnome_bridge::GnomeShortcutStatus, String> {
    let cli_path = resolve_vox2aictl_path(&app).unwrap_or_else(|_| PathBuf::from("vox2aictl"));
    let bridge = gnome_bridge::GnomeBridge::new(cli_path);
    bridge.verify()
}

#[tauri::command]
fn install_gnome_shortcut(
    app: AppHandle,
    shortcut: String,
    behavior: String,
) -> Result<gnome_bridge::GnomeShortcutStatus, String> {
    let cli_path = resolve_vox2aictl_path(&app).unwrap_or_else(|_| PathBuf::from("vox2aictl"));
    let bridge = gnome_bridge::GnomeBridge::new(cli_path);
    bridge.install(&shortcut, &behavior)
}

#[tauri::command]
fn remove_gnome_shortcut(app: AppHandle) -> Result<gnome_bridge::GnomeShortcutStatus, String> {
    let cli_path = resolve_vox2aictl_path(&app).unwrap_or_else(|_| PathBuf::from("vox2aictl"));
    let bridge = gnome_bridge::GnomeBridge::new(cli_path);
    bridge.remove()
}

#[tauri::command]
fn get_control_socket_path() -> String {
    let server = control_server::ControlServer::new("vox2ai");
    server.socket_path().display().to_string()
}

fn resolve_vox2aictl_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let sibling = parent.join("vox2aictl");
            if sibling.is_file() {
                return Ok(sibling);
            }
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("binaries").join("vox2aictl");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    for dir in &["/usr/bin", "/usr/local/bin", "/usr/lib/vox2ai"] {
        let candidate = PathBuf::from(dir).join("vox2aictl");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("vox2aictl command not found".to_string())
}

// ── Main ─────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();

    if args.len() >= 3 && args[1] == "--ctl" {
        let sub = &args[2];
        let sub_args: Vec<&str> = args[3..].iter().map(|s| s.as_str()).collect();
        std::process::exit(vox2aictl_proxy(sub, &sub_args));
    }

    tauri::Builder::default()
        .manage(())
        .invoke_handler(tauri::generate_handler![
            get_desktop_session,
            get_activation_backend_status,
            get_gnome_bridge_status,
            install_gnome_shortcut,
            remove_gnome_shortcut,
            get_control_socket_path,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Control server
            let handler = Arc::new(move |cmd: control_protocol::ControlCommand| {
                let res = control_protocol::ControlResponse::error("not implemented");
                if let Some(w) = handle.get_webview_window("main") {
                    match &cmd {
                        control_protocol::ControlCommand::Summon { behavior, .. } => {
                            use control_protocol::SummonBehavior;
                            match behavior {
                                SummonBehavior::ShowWidget => {
                                    let _ = w.show(); let _ = w.set_focus();
                                }
                                SummonBehavior::ShowAndRecord => {
                                    let _ = w.show(); let _ = w.set_focus();
                                    let _ = handle.emit("tray_start_recording", ());
                                }
                                SummonBehavior::ShowAndFocusInput => {
                                    let _ = w.show(); let _ = w.set_focus();
                                    let _ = handle.emit("control_focus_input", ());
                                }
                                SummonBehavior::ToggleWidget => {
                                    let vis = w.is_visible().unwrap_or(false);
                                    if vis { let _ = w.hide(); } else { let _ = w.show(); let _ = w.set_focus(); }
                                }
                            }
                        }
                        control_protocol::ControlCommand::OpenSettings { .. } => {
                            let _ = w.show(); let _ = w.set_focus();
                            let _ = handle.emit("tray_open_settings", ());
                        }
                        control_protocol::ControlCommand::OpenDiagnostics { .. } => {
                            let _ = w.show(); let _ = w.set_focus();
                            let _ = handle.emit("tray_open_diagnostics", ());
                        }
                        _ => {}
                    }
                }
                res
            });
            let server = control_server::ControlServer::new("vox2ai");
            let _ = server.clean_stale_socket();
            server.start(handler);

            // Tray icon — non-fatal on Wayland
            let _: Result<(), Box<dyn std::error::Error>> = (|| {
                let show = MenuItem::with_id(app, "show_widget", "Show widget", true, None::<&str>)?;
                let hide = MenuItem::with_id(app, "hide_widget", "Hide widget", true, None::<&str>)?;
                let record = MenuItem::with_id(app, "start_recording", "Start recording", true, None::<&str>)?;
                let settings = MenuItem::with_id(app, "open_settings", "Open Settings", true, None::<&str>)?;
                let diagnostics = MenuItem::with_id(app, "open_diagnostics", "Open Diagnostics", true, None::<&str>)?;
                let restart = MenuItem::with_id(app, "restart_backend", "Restart backend", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit vox2ai", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &hide, &record, &settings, &diagnostics, &restart, &quit])?;
                if let Some(icon) = app.default_window_icon().cloned() {
                    TrayIconBuilder::new().menu(&menu).icon(icon).show_menu_on_left_click(true)
                        .on_menu_event(|app, event| match event.id().as_ref() {
                            "show_widget" => {
                                if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
                            }
                            "hide_widget" => {
                                if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
                            }
                            "start_recording" => {
                                if let Some(w) = app.get_webview_window("main") { let _ = w.show(); }
                                let _ = app.emit("tray_start_recording", ());
                            }
                            "open_settings" => {
                                if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
                                let _ = app.emit("tray_open_settings", ());
                            }
                            "open_diagnostics" => {
                                if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
                                let _ = app.emit("tray_open_diagnostics", ());
                            }
                            "restart_backend" => {
                                let _ = app.emit("backend_restarting", ());
                            }
                            "quit" => { app.exit(0); }
                            _ => {}
                        }).build(app)?;
                }
                Ok(())
            })();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── vox2aictl proxy (for AppImage --ctl mode) ────────────────

fn vox2aictl_proxy(command: &str, args: &[&str]) -> i32 {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let socket_path = runtime_dir.join("vox2ai").join("control.sock");

    let (cmd, behavior) = match (command, args.contains(&"--record"), args.contains(&"--focus-input")) {
        ("status", _, _) => ("status", None),
        ("summon", true, _) => ("summon", Some("show-and-record")),
        ("summon", _, true) => ("summon", Some("show-and-focus-input")),
        ("summon", _, _) => ("summon", Some("show-widget")),
        ("toggle", _, _) => ("toggle", Some("toggle-widget")),
        ("open-settings", _, _) => ("open-settings", None),
        ("open-diagnostics", _, _) => ("open-diagnostics", None),
        ("start-recording", _, _) => ("start-recording", None),
        ("stop-recording", _, _) => ("stop-recording", None),
        ("cancel", _, _) => ("cancel", None),
        ("restart-backend", _, _) => ("restart-backend", None),
        _ => { eprintln!("error: unknown command '{command}'"); return 1; }
    };

    let request = match (cmd, behavior) {
        ("summon", Some(b)) => serde_json::json!({"type": "summon", "behavior": b}),
        ("toggle", _) => serde_json::json!({"type": "summon", "behavior": "toggle_widget"}),
        ("status", _) => serde_json::json!({"type": "status"}),
        (other, _) => serde_json::json!({"type": other}),
    };

    let stream = match UnixStream::connect(&socket_path) {
        Ok(s) => s,
        Err(e) => { eprintln!("error: cannot connect to vox2ai: {e}"); return 1; }
    };
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    let write_stream = match stream.try_clone() { Ok(c) => c, Err(_) => return 1 };
    let mut reader = BufReader::new(&stream);
    let mut writer = write_stream;

    let json = serde_json::to_string(&request).unwrap_or_default();
    let _ = writeln!(&mut writer, "{json}");
    let _ = writer.flush();

    let mut response = String::new();
    if reader.read_line(&mut response).is_err() {
        eprintln!("error: no response from vox2ai");
        return 1;
    }

    if let Ok(resp) = serde_json::from_str::<serde_json::Value>(response.trim()) {
        if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            if let Some(msg) = resp.get("message").and_then(|v| v.as_str()) {
                println!("ok: {msg}");
            } else { println!("ok"); }
            return 0;
        } else if let Some(err) = resp.get("error").and_then(|v| v.as_str()) {
            eprintln!("error: {err}");
            return 1;
        }
    }
    eprintln!("error: invalid response");
    1
}
