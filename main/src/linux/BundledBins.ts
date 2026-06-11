import path from "path";
import { app } from "electron";

// Resolves the path to a bundled binary. In a packaged AppImage the
// binaries live in a `bin/` directory next to the Electron executable.
// In dev mode we fall through to the system PATH so the developer does
// not need to run the collection script for every change.
export function getBinPath(name: string): string {
  if (app.isPackaged) {
    return path.join(path.dirname(process.execPath), "bin", name);
  }
  return name;
}

// Returns the path to the bundled shared libraries directory. Used to
// set LD_LIBRARY_PATH so the bundled binaries find their deps inside
// the AppImage instead of relying on system-installed versions.
export function getLibPath(): string {
  return path.join(path.dirname(process.execPath), "bin", "lib");
}

// Builds an env object that includes LD_LIBRARY_PATH pointing at the
// bundled libs. Pass this to spawn/spawnSync when launching bundled
// binaries.
export function getBundledEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (app.isPackaged) {
    const libPath = getLibPath();
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${libPath}:${env.LD_LIBRARY_PATH}`
      : libPath;
  }
  return env;
}
