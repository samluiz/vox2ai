use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

struct SidecarState(Arc<Mutex<Option<Child>>>);

#[derive(Clone, Serialize)]
struct BackendReadyPayload {
    url: String,
}

/// Compile-time path to the source binaries directory (used as fallback in dev).
const SRC_BINARIES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/binaries");

fn find_sidecar_binary(app: &AppHandle) -> Result<StdCommand, String> {
    // Candidate paths to search for the sidecar binary.
    // 1. Resource dir (production bundle).
    // 2. Source tree (dev mode).
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    if let Ok(resource) = app.path().resource_dir() {
        candidates.push(resource.join("binaries"));
    }
    candidates.push(std::path::PathBuf::from(SRC_BINARIES_DIR));

    for dir in &candidates {
        if !dir.is_dir() {
            continue;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
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

fn kill_child(child: &mut Option<Child>) {
    if let Some(ref mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
}

fn spawn_sidecar(handle: AppHandle, child_arc: Arc<Mutex<Option<Child>>>) {
    std::thread::spawn(move || {
        // 1. Build the sidecar command.
        let mut cmd = match find_sidecar_binary(&handle) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[vox2ai] sidecar error: {e}");
                let _ = handle.emit("backend_error", e);
                return;
            }
        };
        cmd.args(["--host", "127.0.0.1", "--port", "0"]);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::inherit());

        // 2. Spawn.
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[vox2ai] failed to spawn sidecar: {e}");
                let _ = handle.emit("backend_error", format!("failed to spawn: {e}"));
                return;
            }
        };

        // 3. Store child immediately so we can kill it later.
        {
            let mut guard = child_arc.lock().unwrap();
            *guard = Some(child);
        }

        // 4. Re-borrow the child from the Arc to read stdout.
        //    We must not hold the lock while reading (blocking).
        let ready = {
            let mut guard = child_arc.lock().unwrap();
            let child_ref = guard.as_mut().unwrap();

            (|| -> Result<(String, u16), String> {
                let stdout = child_ref
                    .stdout
                    .as_mut()
                    .ok_or("sidecar stdout not captured")?;
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let line = line.map_err(|e| format!("read error: {e}"))?;
                    let trimmed = line.trim().to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&trimmed) {
                        if val.get("type").and_then(|v| v.as_str()) == Some("server_ready") {
                            let host = val
                                .get("host")
                                .and_then(|v| v.as_str())
                                .unwrap_or("127.0.0.1")
                                .to_string();
                            let port = val.get("port").and_then(|v| v.as_u64()).unwrap_or(0)
                                as u16;
                            return Ok((host, port));
                        }
                    }
                }
                Err("sidecar exited before sending server_ready".to_string())
            })()
        };

        match ready {
            Ok((host, port)) => {
                let url = format!("ws://{host}:{port}");
                eprintln!("[vox2ai] backend ready at {url}");
                let _ = handle.emit("backend_ready", BackendReadyPayload { url });
            }
            Err(e) => {
                // Clean up child on failure.
                {
                    let mut guard = child_arc.lock().unwrap();
                    kill_child(&mut *guard);
                }
                eprintln!("[vox2ai] sidecar ready failed: {e}");
                let _ = handle.emit("backend_error", e);
            }
        }
    });
}

fn restart_backend_impl(app: AppHandle, child_arc: Arc<Mutex<Option<Child>>>) -> Result<(), String> {
    {
        let mut guard = child_arc.lock().map_err(|_| "backend lock poisoned".to_string())?;
        kill_child(&mut *guard);
    }
    spawn_sidecar(app, child_arc);
    Ok(())
}

#[tauri::command]
fn restart_backend(app: AppHandle, state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    restart_backend_impl(app, state.0.clone())
}

#[tauri::command]
fn show_widget(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
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
    {
        let mut guard = state.0.lock().map_err(|_| "backend lock poisoned".to_string())?;
        kill_child(&mut *guard);
    }
    app.exit(0);
    Ok(())
}

#[derive(Clone, Serialize)]
struct ActiveWindowContext {
    app: String,
    title: String,
}

#[tauri::command]
fn get_active_window_context() -> Result<Option<ActiveWindowContext>, String> {
    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            restart_backend,
            show_widget,
            hide_widget,
            quit_app,
            get_active_window_context
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let child_arc = {
                let state = app.state::<SidecarState>();
                state.0.clone()
            };

            spawn_sidecar(handle, child_arc);

            let show = MenuItem::with_id(app, "show_widget", "Show widget", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide_widget", "Hide widget", true, None::<&str>)?;
            let settings =
                MenuItem::with_id(app, "open_settings", "Open Settings", true, None::<&str>)?;
            let diagnostics =
                MenuItem::with_id(app, "open_diagnostics", "Open Diagnostics", true, None::<&str>)?;
            let restart =
                MenuItem::with_id(app, "restart_backend", "Restart backend", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit vox2ai", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show, &hide, &settings, &diagnostics, &restart, &quit],
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
                    "show_widget" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide_widget" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "open_settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("tray_open_settings", ());
                    }
                    "open_diagnostics" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("tray_open_diagnostics", ());
                    }
                    "restart_backend" => {
                        let child_arc = {
                            let state = app.state::<SidecarState>();
                            state.0.clone()
                        };
                        let _ = app.emit("backend_restarting", ());
                        let _ = restart_backend_impl(app.clone(), child_arc);
                    }
                    "quit" => {
                        if let Some(state) = app.try_state::<SidecarState>() {
                            let mut guard = state.0.lock().unwrap();
                            kill_child(&mut *guard);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Destroyed => {
                    if let Some(state) = window.try_state::<SidecarState>() {
                        let mut guard = state.0.lock().unwrap();
                        kill_child(&mut *guard);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
