fn main() {
    let args: Vec<String> = std::env::args().collect();

    // If invoked as --ctl <subcommand>, act as vox2aictl proxy.
    // This supports AppImage: ./vox2ai.AppImage --ctl summon --record
    if args.len() >= 3 && args[1] == "--ctl" {
        let sub = &args[2];
        let sub_args: Vec<&str> = args[3..].iter().map(|s| s.as_str()).collect();
        std::process::exit(vox2aictl_proxy(sub, &sub_args));
    }

    // Normal launch: use the full lib setup (tray, sidecar, control server, etc.)
    vox2ai_desktop_lib::run();
}

fn vox2aictl_proxy(command: &str, args: &[&str]) -> i32 {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::time::Duration;

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
        _ => {
            eprintln!("error: unknown command '{command}'");
            return 1;
        }
    };

    let request = match (cmd, behavior) {
        ("summon", Some(b)) => serde_json::json!({
            "type": "summon",
            "behavior": b
        }),
        ("toggle", _) => serde_json::json!({
            "type": "summon",
            "behavior": "toggle_widget"
        }),
        ("status", _) => serde_json::json!({"type": "status"}),
        (other, _) => serde_json::json!({"type": other}),
    };

    let stream = match UnixStream::connect(&socket_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: cannot connect to vox2ai: {e}");
            return 1;
        }
    };
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok();
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok();

    let write_stream = match stream.try_clone() {
        Ok(c) => c,
        Err(_) => return 1,
    };
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
            if cmd == "status" {
                if let Some(status) = resp.get("status") {
                    println!("ok: vox2ai is running");
                    if let Some(backend) = status.get("backend").and_then(|v| v.as_str()) {
                        println!("  backend: {backend}");
                    }
                    if let Some(connected) = status.get("connected").and_then(|v| v.as_bool()) {
                        println!("  connected: {connected}");
                    }
                }
            } else if let Some(msg) = resp.get("message").and_then(|v| v.as_str()) {
                println!("ok: {msg}");
            } else {
                println!("ok");
            }
            return 0;
        } else if let Some(err) = resp.get("error").and_then(|v| v.as_str()) {
            eprintln!("error: {err}");
            return 1;
        }
    }

    eprintln!("error: invalid response");
    1
}
