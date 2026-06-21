use std::path::PathBuf;
use std::process::Command;
use serde::Serialize;

const VOX2AI_BINDING_PATH: &str =
    "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/vox2ai-summon/";

#[derive(Debug, Clone, Serialize)]
pub struct GnomeShortcutStatus {
    pub installed: bool,
    pub name: String,
    pub command: String,
    pub binding: String,
    pub resolved_command: Option<String>,
    pub error: Option<String>,
}

pub struct GnomeBridge {
    pub cli_path: PathBuf,
}

impl GnomeBridge {
    pub fn new(cli_path: PathBuf) -> Self {
        GnomeBridge { cli_path }
    }

    fn gsettings_binary() -> Result<String, String> {
        for path in &["/usr/bin/gsettings", "/bin/gsettings"] {
            if std::path::Path::new(path).is_file() {
                return Ok(path.to_string());
            }
        }
        let output = Command::new("which")
            .arg("gsettings")
            .output()
            .map_err(|e| format!("Failed to find gsettings: {e}"))?;
        if output.status.success() {
            let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !found.is_empty() {
                return Ok(found);
            }
        }
        Err("gsettings not found. Install glib2-tools/glib2-devel.".to_string())
    }

    fn run(args: &[&str]) -> Result<String, String> {
        let bin = Self::gsettings_binary()?;
        let output = Command::new(&bin)
            .args(args)
            .output()
            .map_err(|e| format!("gsettings failed: {e}"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!("gsettings: {stderr}"))
        }
    }

    fn get_custom_bindings() -> Result<Vec<String>, String> {
        let out = Self::run(&[
            "get",
            "org.gnome.settings-daemon.plugins.media-keys",
            "custom-keybindings",
        ])?;
        if out.trim().is_empty() || out.trim() == "@as []" {
            return Ok(Vec::new());
        }
        let trimmed = out.trim();
        let inner = trimmed
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .unwrap_or(trimmed);
        if inner.is_empty() {
            return Ok(Vec::new());
        }
        Ok(inner
            .split(',')
            .map(|s| s.trim().trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }

    fn set_custom_bindings(paths: &[String]) -> Result<(), String> {
        let list: String = paths
            .iter()
            .map(|p| format!("'{}'", p))
            .collect::<Vec<_>>()
            .join(", ");
        Self::run(&[
            "set",
            "org.gnome.settings-daemon.plugins.media-keys",
            "custom-keybindings",
            &format!("[{}]", list),
        ])?;
        Ok(())
    }

    pub fn install(&self, shortcut: &str, behavior: &str) -> Result<GnomeShortcutStatus, String> {
        let command = self.build_command(behavior);
        let gnome_accel = to_gnome_accelerator(shortcut)?;

        let mut paths = Self::get_custom_bindings()?;
        let vp = VOX2AI_BINDING_PATH.trim_end_matches('/').to_string();
        if !paths.contains(&vp) {
            paths.push(vp);
        }
        Self::set_custom_bindings(&paths)?;

        let base = format!(
            "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{}",
            VOX2AI_BINDING_PATH
        );

        Self::run(&["set", &base, "name", "vox2ai"])?;
        Self::run(&["set", &base, "command", &command])?;
        Self::run(&["set", &base, "binding", &gnome_accel])?;

        self.verify()
    }

    pub fn remove(&self) -> Result<GnomeShortcutStatus, String> {
        let mut paths = Self::get_custom_bindings()?;
        let vp = VOX2AI_BINDING_PATH.trim_end_matches('/').to_string();
        paths.retain(|p| p != &vp);
        Self::set_custom_bindings(&paths)?;
        Ok(GnomeShortcutStatus {
            installed: false,
            name: String::new(),
            command: String::new(),
            binding: String::new(),
            resolved_command: None,
            error: None,
        })
    }

    pub fn verify(&self) -> Result<GnomeShortcutStatus, String> {
        let paths = Self::get_custom_bindings()?;
        let vp = VOX2AI_BINDING_PATH.trim_end_matches('/').to_string();
        if !paths.contains(&vp) {
            return Ok(GnomeShortcutStatus {
                installed: false,
                name: String::new(),
                command: String::new(),
                binding: String::new(),
                resolved_command: None,
                error: None,
            });
        }
        let base = format!(
            "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{}",
            VOX2AI_BINDING_PATH
        );
        let name = Self::run(&["get", &base, "name"]).unwrap_or_default();
        let cmd = Self::run(&["get", &base, "command"]).unwrap_or_default();
        let binding = Self::run(&["get", &base, "binding"]).unwrap_or_default();

        let name = name.trim_matches('\'').to_string();
        let command = cmd.trim_matches('\'').to_string();
        let binding = binding.trim_matches('\'').to_string();

        let error = if name != "vox2ai" {
            Some(format!("Expected name 'vox2ai', got '{name}'"))
        } else if command.is_empty() {
            Some("Command is empty.".to_string())
        } else if binding.is_empty() {
            Some("Binding is empty.".to_string())
        } else {
            None
        };

        Ok(GnomeShortcutStatus {
            installed: true,
            name,
            command,
            binding,
            resolved_command: Some(self.cli_path.display().to_string()),
            error,
        })
    }

    fn build_command(&self, behavior: &str) -> String {
        let cli = self.cli_path.display().to_string();
        match behavior {
            "show-and-record" => format!("{cli} summon --record"),
            "show-and-focus-input" => format!("{cli} summon --focus-input"),
            "toggle-widget" => format!("{cli} toggle"),
            _ => format!("{cli} summon"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NormalizedShortcut {
    pub modifiers: Vec<String>,
    pub key: String,
}

pub fn normalize_shortcut(input: &str) -> Result<NormalizedShortcut, String> {
    let parts: Vec<&str> = input.split('+').collect();
    if parts.is_empty() {
        return Err("Shortcut cannot be empty.".to_string());
    }

    let mut modifiers: Vec<String> = Vec::new();
    let mut key: Option<String> = None;

    fn add_mod(modifiers: &mut Vec<String>, m: &str) {
        let m = m.to_string();
        if !modifiers.contains(&m) {
            modifiers.push(m);
        }
    }

    for raw in &parts {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        match part {
            "Ctrl" | "Control" | "control" | "ctrl" => add_mod(&mut modifiers, "Ctrl"),
            "Alt" | "alt" | "Option" | "option" => add_mod(&mut modifiers, "Alt"),
            "Shift" | "shift" => add_mod(&mut modifiers, "Shift"),
            "Super" | "super" | "Meta" | "meta" | "Cmd" | "cmd" | "Command" | "command" => {
                add_mod(&mut modifiers, "Super");
            }
            "Esc" | "Escape" | "escape" => {
                return Err("Escape cannot be an activation shortcut.".to_string());
            }
            k => {
                if key.is_some() {
                    return Err(format!("Multiple keys in shortcut: {} and {}", key.as_ref().unwrap(), k));
                }
                // Normalize to lowercase for known named keys (space, tab, etc.)
                // and single alpha keys. Keep function keys uppercased.
                key = Some(k.to_lowercase());
            }
        }
    }

    let key = key.ok_or_else(|| {
        "Shortcut must include a non-modifier key (e.g. Space, A, F1).".to_string()
    })?;

    let has_mod = !modifiers.is_empty();
    let is_fn = matches!(key.as_str(), "f1" | "f2" | "f3" | "f4" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10" | "f11" | "f12");
    if !has_mod && !is_fn {
        return Err(
            "Activation shortcut needs a modifier (Ctrl, Alt, Super).".to_string(),
        );
    }

    Ok(NormalizedShortcut { modifiers, key })
}

pub fn to_gnome_accelerator(input: &str) -> Result<String, String> {
    let ns = normalize_shortcut(input)?;
    let mut result = String::new();
    for m in &ns.modifiers {
        let g = match m.as_str() {
            "Ctrl" => "<Control>",
            "Alt" => "<Alt>",
            "Shift" => "<Shift>",
            "Super" => "<Super>",
            _ => return Err(format!("Unknown modifier: {m}")),
        };
        result.push_str(g);
    }
    let has_mod = !ns.modifiers.is_empty();
    let gnome_key = match ns.key.as_str() {
        "space" => "space",
        "tab" => "Tab",
        "return" => "Return",
        "escape" => "Escape",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        k if k.len() == 1 && k.chars().all(|c| c.is_alphabetic()) => {
            if !has_mod {
                return Err("Alpha keys need a modifier.".to_string());
            }
            k
        }
        k => k,
    };
    result.push_str(gnome_key);
    Ok(result)
}

pub fn from_gnome_accelerator(binding: &str) -> Result<NormalizedShortcut, String> {
    let mut input = binding.to_string();
    let mut modifiers: Vec<String> = Vec::new();
    let mut key: Option<String> = None;

    while let Some(start) = input.find('<') {
        let end = input.find('>').ok_or_else(|| {
            format!("Malformed GNOME accelerator: unmatched '<' in {binding}")
        })?;
        let mod_str = &input[start + 1..end];
        let m = match mod_str {
            "Control" => "Ctrl",
            "Alt" => "Alt",
            "Shift" => "Shift",
            "Super" => "Super",
            other => return Err(format!("Unknown GNOME modifier: {other}")),
        };
        modifiers.push(m.to_string());
        input = input[end + 1..].to_string();
    }

    if !input.is_empty() {
        let k = match input.as_str() {
            "space" | "tab" | "return" | "escape" | "up" | "down" | "left" | "right" => {
                input.to_lowercase()
            }
            s => s.to_string(),
        };
        key = Some(k);
    }

    let key = key.ok_or_else(|| format!("No key in GNOME accelerator: {binding}"))?;
    Ok(NormalizedShortcut { modifiers, key })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_ctrl_space() {
        let ns = normalize_shortcut("Ctrl+Space").unwrap();
        assert_eq!(ns.modifiers, vec!["Ctrl"]);
        assert_eq!(ns.key, "space");
    }

    #[test]
    fn test_normalize_super_space() {
        let ns = normalize_shortcut("Super+Space").unwrap();
        assert_eq!(ns.modifiers, vec!["Super"]);
        assert_eq!(ns.key, "space");
    }

    #[test]
    fn test_normalize_ctrl_alt_v() {
        let ns = normalize_shortcut("Ctrl+Alt+V").unwrap();
        assert_eq!(ns.modifiers, vec!["Ctrl", "Alt"]);
        assert_eq!(ns.key, "v");
    }

    #[test]
    fn test_normalize_f8() {
        let ns = normalize_shortcut("F8").unwrap();
        assert!(ns.modifiers.is_empty());
        assert_eq!(ns.key, "f8");
    }

    #[test]
    fn test_normalize_alt_f9() {
        let ns = normalize_shortcut("Alt+F9").unwrap();
        assert_eq!(ns.modifiers, vec!["Alt"]);
        assert_eq!(ns.key, "f9");
    }

    #[test]
    fn test_normalize_rejects_escape() {
        assert!(normalize_shortcut("Escape").is_err());
        assert!(normalize_shortcut("Ctrl+Escape").is_err());
    }

    #[test]
    fn test_normalize_rejects_modifier_only() {
        assert!(normalize_shortcut("Ctrl").is_err());
        assert!(normalize_shortcut("Ctrl+Alt").is_err());
    }

    #[test]
    fn test_normalize_rejects_bare_alpha() {
        assert!(normalize_shortcut("A").is_err());
    }

    #[test]
    fn test_gnome_accel_ctrl_space() {
        assert_eq!(to_gnome_accelerator("Ctrl+Space").unwrap(), "<Control>space");
    }

    #[test]
    fn test_gnome_accel_ctrl_alt_v() {
        assert_eq!(to_gnome_accelerator("Ctrl+Alt+V").unwrap(), "<Control><Alt>v");
    }

    #[test]
    fn test_gnome_accel_super_space() {
        assert_eq!(to_gnome_accelerator("Super+Space").unwrap(), "<Super>space");
    }

    #[test]
    fn test_gnome_accel_f8() {
        assert_eq!(to_gnome_accelerator("F8").unwrap(), "f8");
    }

    #[test]
    fn test_gnome_roundtrip() {
        let inputs = ["Ctrl+Space", "Ctrl+Alt+V", "Super+Space", "Alt+F9"];
        for input in inputs {
            let accel = to_gnome_accelerator(input).unwrap();
            let back = from_gnome_accelerator(&accel).unwrap();
            let reconstructed = if back.modifiers.is_empty() {
                back.key.clone()
            } else {
                format!("{}+{}", back.modifiers.join("+"), back.key)
            };
            assert_eq!(reconstructed.to_lowercase(), input.to_lowercase(),
                "Roundtrip failed for {input}");
        }
    }

    #[test]
    fn test_from_gnome_ctrl_space() {
        let ns = from_gnome_accelerator("<Control>space").unwrap();
        assert_eq!(ns.modifiers, vec!["Ctrl"]);
        assert_eq!(ns.key, "space");
    }

    #[test]
    fn test_rejects_empty() {
        assert!(normalize_shortcut("").is_err());
    }
}
