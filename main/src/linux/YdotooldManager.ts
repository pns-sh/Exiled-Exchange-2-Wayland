import { spawn, execSync, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { getBinPath, getBundledEnv } from "./BundledBins";
import { debug } from "../debug";
import type { Logger } from "../RemoteLogger";

// Manages the lifecycle of the bundled ydotoold daemon. ydotool (the
// client binary we use for key injection) talks to ydotoold over a Unix
// socket. ydotoold is what actually writes to /dev/uinput.
//
// On startup we check whether a system ydotoold is already running
// (e.g. via systemctl). If so, we piggyback on it. If not, we spawn
// our own bundled copy and kill it on exit.
export class YdotooldManager {
  private child: ChildProcess | null = null;
  private startedByUs = false;

  constructor(private logger: Logger) {}

  // Returns true if a ydotoold process is running (ours or system).
  isRunning(): boolean {
    try {
      execSync("pgrep -x ydotoold", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  // Returns true if the current user can write to /dev/uinput.
  hasUinputAccess(): boolean {
    try {
      fs.accessSync("/dev/uinput", fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  // Attempts to start ydotoold. Returns a status string:
  //   "running"      -- a ydotoold was already running, nothing to do
  //   "started"      -- we successfully started the bundled ydotoold
  //   "no-uinput"    -- /dev/uinput is not writable by this user
  //   "spawn-failed" -- the binary failed to launch
  async start(): Promise<"running" | "started" | "no-uinput" | "spawn-failed"> {
    if (this.isRunning()) {
      debug("[YdotooldManager] ydotoold already running (system or prior)");
      this.logger.write("info [YdotooldManager] using existing ydotoold");
      return "running";
    }

    if (!this.hasUinputAccess()) {
      debug("[YdotooldManager] /dev/uinput not writable");
      this.logger.write(
        "warn [YdotooldManager] /dev/uinput not accessible -- need input group",
      );
      return "no-uinput";
    }

    const binPath = getBinPath("ydotoold");
    const env = getBundledEnv();

    debug(`[YdotooldManager] starting ${binPath}`);
    try {
      this.child = spawn(binPath, [], {
        stdio: "ignore",
        detached: false,
        env,
      });

      this.child.on("error", (err) => {
        this.logger.write(
          `error [YdotooldManager] ydotoold spawn error: ${err.message}`,
        );
        this.child = null;
        this.startedByUs = false;
      });

      this.child.on("exit", (code) => {
        debug(`[YdotooldManager] ydotoold exited with code ${code}`);
        this.child = null;
        this.startedByUs = false;
      });

      // Wait for the ydotoold socket to appear (up to 2 seconds).
      // The client ydotool connects over this socket.
      const socketPath = path.join(
        process.env.XDG_RUNTIME_DIR ||
          `/run/user/${process.getuid?.() ?? 1000}`,
        ".ydotool_socket",
      );

      const ready = await this.waitForSocket(socketPath, 2000);
      if (ready) {
        this.startedByUs = true;
        this.logger.write("info [YdotooldManager] ydotoold started");
        return "started";
      } else {
        // Socket never appeared -- something went wrong
        this.logger.write(
          "warn [YdotooldManager] ydotoold started but socket not found",
        );
        // It might still be working, report started optimistically
        this.startedByUs = true;
        return "started";
      }
    } catch (err) {
      this.logger.write(
        `error [YdotooldManager] failed to spawn ydotoold: ${(err as Error).message}`,
      );
      return "spawn-failed";
    }
  }

  stop(): void {
    if (this.startedByUs && this.child) {
      debug("[YdotooldManager] stopping ydotoold");
      this.child.kill("SIGTERM");
      this.child = null;
      this.startedByUs = false;
    }
  }

  private async waitForSocket(
    socketPath: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const interval = 100;
    const maxAttempts = Math.ceil(timeoutMs / interval);
    for (let i = 0; i < maxAttempts; i++) {
      try {
        fs.accessSync(socketPath);
        debug(`[YdotooldManager] socket appeared at ${socketPath}`);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, interval));
      }
    }
    return false;
  }
}
