use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process;
use std::time::Duration;

use vox2ai_desktop_lib::control_protocol::{ControlCommand, ControlResponse, SummonBehavior};

fn socket_path() -> PathBuf {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    runtime_dir.join("vox2ai").join("control.sock")
}

fn send(command: &ControlCommand) -> Result<ControlResponse, String> {
    let path = socket_path();
    let stream =
        UnixStream::connect(&path).map_err(|e| format!("Cannot connect to vox2ai: {e}"))?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    let write_stream = stream.try_clone().map_err(|e| format!("Clone error: {e}"))?;
    let mut reader = BufReader::new(&stream);
    let mut writer = write_stream;

    let json =
        serde_json::to_string(command).map_err(|e| format!("Serialize error: {e}"))?;
    writeln!(&mut writer, "{json}").map_err(|e| format!("Write error: {e}"))?;
    writer.flush().map_err(|e| format!("Flush error: {e}"))?;

    let mut response = String::new();
    reader
        .read_line(&mut response)
        .map_err(|e| format!("Read error: {e}"))?;

    serde_json::from_str::<ControlResponse>(response.trim())
        .map_err(|e| format!("Parse error: {e}"))
}

fn print_response(response: &ControlResponse) {
    if response.ok {
        if let Some(status) = &response.status {
            println!("ok: vox2ai is running");
            println!("  backend: {}", status.backend);
            println!("  connected: {}", status.connected);
            println!("  recording: {}", status.recording);
            println!("  visible: {}", status.visible);
            println!("  activation_backend: {}", status.activation_backend);
        } else if let Some(msg) = &response.message {
            println!("ok: {msg}");
        } else {
            println!("ok");
        }
    } else if let Some(err) = &response.error {
        eprintln!("error: {err}");
    } else {
        eprintln!("error: unknown");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: vox2aictl <command> [options]");
        eprintln!();
        eprintln!("Commands:");
        eprintln!("  status                    Show vox2ai status");
        eprintln!("  summon                    Show widget");
        eprintln!("  summon --record           Show widget and start recording");
        eprintln!("  summon --focus-input      Show widget and focus input");
        eprintln!("  toggle                    Toggle widget visibility");
        eprintln!("  open-settings             Open settings panel");
        eprintln!("  open-diagnostics          Open diagnostics panel");
        eprintln!("  start-recording           Start recording");
        eprintln!("  stop-recording            Stop recording");
        eprintln!("  cancel                    Cancel current operation");
        eprintln!("  restart-backend           Restart backend sidecar");
        process::exit(1);
    }

    let command = match args[1].as_str() {
        "status" => ControlCommand::Status { request_id: None },
        "summon" => {
            let behavior = if args.contains(&"--record".to_string()) {
                SummonBehavior::ShowAndRecord
            } else if args.contains(&"--focus-input".to_string()) {
                SummonBehavior::ShowAndFocusInput
            } else {
                SummonBehavior::ShowWidget
            };
            ControlCommand::Summon {
                behavior,
                request_id: None,
            }
        }
        "toggle" => ControlCommand::Summon {
            behavior: SummonBehavior::ToggleWidget,
            request_id: None,
        },
        "open-settings" => ControlCommand::OpenSettings { request_id: None },
        "open-diagnostics" => ControlCommand::OpenDiagnostics { request_id: None },
        "start-recording" => ControlCommand::StartRecording { request_id: None },
        "stop-recording" => ControlCommand::StopRecording { request_id: None },
        "cancel" => ControlCommand::Cancel { request_id: None },
        "restart-backend" => ControlCommand::RestartBackend { request_id: None },
        other => {
            eprintln!("error: unknown command '{other}'");
            process::exit(1);
        }
    };

    match send(&command) {
        Ok(response) => {
            if response.ok {
                print_response(&response);
                process::exit(0);
            } else {
                print_response(&response);
                process::exit(1);
            }
        }
        Err(e) => {
            eprintln!("error: {e}");
            process::exit(1);
        }
    }
}
