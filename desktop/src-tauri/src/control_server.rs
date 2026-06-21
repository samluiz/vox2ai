use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::control_protocol::{ControlCommand, ControlResponse};

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);

pub struct ControlServer {
    socket_path: PathBuf,
}

impl ControlServer {
    pub fn new(app_name: &str) -> Self {
        let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir());
        let socket_dir = runtime_dir.join(app_name);
        let socket_path = socket_dir.join("control.sock");
        ControlServer { socket_path }
    }

    pub fn socket_path(&self) -> &PathBuf {
        &self.socket_path
    }

    pub fn clean_stale_socket(&self) -> Result<(), String> {
        if self.socket_path.exists() {
            fs::remove_file(&self.socket_path)
                .map_err(|e| format!("Failed to remove stale socket: {e}"))?;
        }
        if let Some(parent) = self.socket_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create socket directory: {e}"))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&self.socket_path.parent().unwrap()) {
                let mut perms = meta.permissions();
                perms.set_mode(0o700);
                let _ = fs::set_permissions(&self.socket_path.parent().unwrap(), perms);
            }
        }
        Ok(())
    }

    pub fn start<F>(self, handler: Arc<F>)
    where
        F: Fn(ControlCommand) -> ControlResponse + Send + Sync + 'static,
    {
        thread::spawn(move || {
            let listener = match UnixListener::bind(&self.socket_path) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[vox2ai] control server bind failed: {e}");
                    return;
                }
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.socket_path, fs::Permissions::from_mode(0o600));
            }
            eprintln!(
                "[vox2ai] control server listening on {}",
                self.socket_path.display()
            );

            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let handler = Arc::clone(&handler);
                        thread::spawn(move || {
                            handle_connection(stream, &*handler);
                        });
                    }
                    Err(e) => {
                        eprintln!("[vox2ai] control server accept error: {e}");
                    }
                }
            }
        });
    }
}

fn handle_connection(stream: UnixStream, handler: &dyn Fn(ControlCommand) -> ControlResponse) {
    let _ = stream.set_read_timeout(Some(CONNECTION_TIMEOUT));
    let _ = stream.set_write_timeout(Some(CONNECTION_TIMEOUT));

    let write_stream = match stream.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    };

    let reader = BufReader::new(&stream);
    let mut writer = write_stream;

    for line in reader.lines().map_while(Result::ok) {
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<ControlCommand>(&trimmed) {
            Ok(cmd) => handler(cmd),
            Err(e) => ControlResponse::error(format!("Invalid command: {e}")),
        };
        let json = serde_json::to_string(&response).unwrap_or_default();
        let _ = writeln!(&mut writer, "{json}");
        let _ = writer.flush();
        if !response.ok {
            break;
        }
    }
}

pub fn send_command(socket_path: &PathBuf, command: &ControlCommand) -> Result<ControlResponse, String> {
    let stream =
        UnixStream::connect(socket_path).map_err(|e| format!("Cannot connect to vox2ai: {e}"))?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));

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
        .map_err(|e| format!("Parse response error: {e}"))
}
