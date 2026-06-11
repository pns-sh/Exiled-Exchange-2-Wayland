import { spawn } from "child_process";
import { uIOhook, UiohookKey } from "uiohook-napi";
import { debug } from "../debug";
import { isKdeWayland } from "../windowing/WaylandTracker";
import { getBinPath, getBundledEnv } from "../linux/BundledBins";

const WAYLAND = isKdeWayland();

// Linux input event codes (from /usr/include/linux/input-event-codes.h).
// Names match the strings used in the app's shortcut format (Ctrl, Shift, A,
// F1, ArrowRight, etc.) so we can take the same string identifiers the rest
// of the code already produces.
const NAME_TO_EVDEV: Record<string, number> = {
  Ctrl: 29,
  Shift: 42,
  Alt: 56,
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23,
  J: 36, K: 37, L: 38, M: 50, N: 49, O: 24, P: 25, Q: 16, R: 19,
  S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
  "0": 11, "1": 2, "2": 3, "3": 4, "4": 5,
  "5": 6, "6": 7, "7": 8, "8": 9, "9": 10,
  Space: 57, Enter: 28, Escape: 1, Backspace: 14, Tab: 15,
  ArrowLeft: 105, ArrowRight: 106, ArrowUp: 103, ArrowDown: 108,
  Home: 102, End: 107, Delete: 111, Insert: 110,
  PageUp: 104, PageDown: 109,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64,
  F7: 65, F8: 66, F9: 67, F10: 68, F11: 87, F12: 88,
  F13: 183, F14: 184, F15: 185, F16: 186, F17: 187, F18: 188,
  F19: 189, F20: 190, F21: 191, F22: 192, F23: 193, F24: 194,
  Meta: 125,
};

export interface KeyEvent {
  name: string;
  state: "down" | "up";
}

type UiohookKeyT = keyof typeof UiohookKey;

function uiohookKey(name: string): number | undefined {
  return (UiohookKey as unknown as Record<string, number>)[name];
}

function spawnYdotool(args: string[]) {
  const binPath = getBinPath("ydotool");
  debug(`[InputSynth] ${binPath} ${args.join(" ")}`);
  try {
    const child = spawn(binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: getBundledEnv(),
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        console.error(
          `[InputSynth] ydotool exited ${code}, stderr=${stderr.trim()}`,
        );
      }
    });
    child.on("error", (err) => {
      console.error(`[InputSynth] ydotool spawn error: ${err.message}`);
    });
  } catch (err) {
    console.error(
      `[InputSynth] failed to launch ydotool: ${(err as Error).message}`,
    );
  }
}

// Batch all synthesis calls made within a single JS tick into one ydotool
// invocation. This solves two problems:
// 1. Ordering -- two concurrent ydotool child processes can race on the
//    ydotoold socket.
// 2. Atomicity -- PoE2 only recognises Ctrl+Alt+C as the advanced-copy
//    combo if the modifiers and C arrive as one clean event sequence.
let waylandQueue: KeyEvent[] = [];
let flushScheduled = false;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  process.nextTick(() => {
    flushScheduled = false;
    const events = waylandQueue;
    waylandQueue = [];
    if (events.length === 0) return;

    // Convert to ydotool key arguments: each event is "<evdev_code>:<state>"
    // where state is 1 for down and 0 for up.
    const args = ["key", "--key-delay", "30"];
    for (const ev of events) {
      const code = NAME_TO_EVDEV[ev.name];
      if (code === undefined) {
        debug(`[InputSynth] unknown key name: ${ev.name}, skipping`);
        continue;
      }
      const state = ev.state === "down" ? 1 : 0;
      args.push(`${code}:${state}`);
    }

    if (args.length > 3) {
      spawnYdotool(args);
    }
  });
}

function enqueueWayland(name: string, state: "down" | "up") {
  waylandQueue.push({ name, state });
  scheduleFlush();
}

// --- Public API ---

export function keyTapByName(name: string) {
  if (WAYLAND) {
    enqueueWayland(name, "down");
    enqueueWayland(name, "up");
  } else {
    const code = uiohookKey(name);
    if (code !== undefined) {
      uIOhook.keyTap(code);
    }
  }
}

export function keyToggleByName(name: string, state: "down" | "up") {
  if (WAYLAND) {
    enqueueWayland(name, state);
  } else {
    const code = uiohookKey(name);
    if (code !== undefined) {
      uIOhook.keyToggle(code, state);
    }
  }
}

// Taps a key while a set of modifiers is held. On Wayland this expands to
// the ordered mods-down -> key-down/up -> mods-up-reverse sequence and
// pushes it through the same batching queue. On other backends it passes
// through to uIOhook.keyTap(key, [modCodes]).
export function keyTapWithModsByName(name: string, modifiers: string[]) {
  if (WAYLAND) {
    for (const mod of modifiers) {
      enqueueWayland(mod, "down");
    }
    enqueueWayland(name, "down");
    enqueueWayland(name, "up");
    for (let i = modifiers.length - 1; i >= 0; i--) {
      enqueueWayland(modifiers[i], "up");
    }
  } else {
    const code = uiohookKey(name);
    if (code !== undefined) {
      const modCodes = modifiers
        .map((m) => uiohookKey(m))
        .filter((c): c is number => c !== undefined);
      uIOhook.keyTap(code, modCodes);
    }
  }
}

// Taps a sequence of key names in order. Each key is pressed and released
// before the next one starts.
export function keySequenceByName(names: string[]) {
  for (const name of names) {
    keyTapByName(name);
  }
}
