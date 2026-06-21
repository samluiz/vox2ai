use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Arc, Mutex};
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState(Arc::new(Mutex::new(None))))
        .setup(|app| {
            let handle = app.handle().clone();
            let child_arc = {
                let state = app.state::<SidecarState>();
                state.0.clone()
            };

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
                            if let Ok(val) =
                                serde_json::from_str::<serde_json::Value>(&trimmed)
                            {
                                if val.get("type").and_then(|v| v.as_str())
                                    == Some("server_ready")
                                {
                                    let host = val
                                        .get("host")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("127.0.0.1")
                                        .to_string();
                                    let port = val
                                        .get("port")
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(0)
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

                // Thread lives as long as the child runs.
                // When the thread exits (app shutdown), the child is dropped.
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<SidecarState>() {
                    let mut guard = state.0.lock().unwrap();
                    kill_child(&mut *guard);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
