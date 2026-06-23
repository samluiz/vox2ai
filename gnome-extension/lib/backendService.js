// Backend service control via systemctl --user (Gio.Subprocess)

import Gio from "gi://Gio";

const SERVICE_NAME = "vox2ai.service";

function run(args) {
  return new Promise((resolve) => {
    const argv = ["systemctl", "--user", ...args];
    const proc = new Gio.Subprocess({
      argv,
      flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    proc.init(null);
    proc.communicate_utf8_async(null, null, (sub, res) => {
      try {
        const [, stdout, stderr] = sub.communicate_utf8_finish(res);
        const exitCode = sub.get_exit_status();
        resolve({
          ok: exitCode === 0,
          stdout: (stdout || "").trim(),
          stderr: (stderr || "").trim(),
          exitCode,
        });
      } catch (e) {
        resolve({
          ok: false,
          stdout: "",
          stderr: String(e),
          exitCode: -1,
        });
      }
    });
  });
}

export const BackendService = {
  async isActive() {
    return run(["is-active", SERVICE_NAME]);
  },

  async isInstalled() {
    const result = await run(["list-unit-files", SERVICE_NAME]);
    return result.ok && result.stdout.includes(SERVICE_NAME);
  },

  async start() {
    return run(["start", SERVICE_NAME]);
  },

  async restart() {
    return run(["restart", SERVICE_NAME]);
  },

  async stop() {
    return run(["stop", SERVICE_NAME]);
  },

  async status() {
    return run(["status", SERVICE_NAME, "--no-pager"]);
  },
};
