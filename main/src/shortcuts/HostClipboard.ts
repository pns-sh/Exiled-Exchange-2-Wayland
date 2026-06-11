import { spawnSync } from "child_process";
import { clipboard, Clipboard } from "electron";
import { debug } from "../debug";
import type { Logger } from "../RemoteLogger";
import { isKdeWayland } from "../windowing/WaylandTracker";
import { getBinPath, getBundledEnv } from "../linux/BundledBins";

const POLL_DELAY = 48;
const POLL_LIMIT = 1500;

// Under native KDE Wayland the overlay process is XWayland; PoE2 is native
// Wayland. Electron's clipboard.readText() reads the X11 CLIPBOARD, but
// XWayland only lazily mirrors the Wayland selection into it (usually on a
// focus change), so polling sees nothing during the action. Shell out to
// wl-paste to read the Wayland selection directly.
const USE_WL_PASTE = isKdeWayland();

function readClipboardText(): string {
  if (USE_WL_PASTE) {
    const result = spawnSync(getBinPath("wl-paste"), ["--no-newline"], {
      encoding: "utf-8",
      timeout: 100,
      env: getBundledEnv(),
    });
    if (result.status === 0 && typeof result.stdout === "string") {
      return result.stdout;
    }
    return "";
  }
  return clipboard.readText();
}

function writeClipboardText(text: string): void {
  if (USE_WL_PASTE) {
    spawnSync(getBinPath("wl-copy"), [text], {
      timeout: 100,
      env: getBundledEnv(),
    });
    return;
  }
  clipboard.writeText(text);
}

// PoE must read clipboard within this timeframe,
// after that we restore clipboard.
// If game lagged for some reason, it will read
// wrong content (= restored clipboard, potentially containing password).
const RESTORE_AFTER = 120;

export class HostClipboard {
  private pollPromise?: Promise<string>;
  private elapsed = 0;
  private shouldRestore = false;

  private isRestored = true;

  get isPolling() {
    return this.pollPromise != null;
  }

  constructor(private logger: Logger) {}

  updateOptions(restoreClipboard: boolean) {
    this.shouldRestore = restoreClipboard;
  }

  async readItemText(): Promise<string> {
    this.elapsed = 0;
    if (this.pollPromise) {
      return await this.pollPromise;
    }

    let textBefore = readClipboardText();
    if (isPoeItem(textBefore)) {
      textBefore = "";
      writeClipboardText("");
    }

    this.pollPromise = new Promise((resolve, reject) => {
      const poll = () => {
        const textAfter = readClipboardText();

        if (isPoeItem(textAfter)) {
          if (this.shouldRestore) {
            writeClipboardText(textBefore);
          }
          this.pollPromise = undefined;
          resolve(textAfter);
        } else {
          this.elapsed += POLL_DELAY;
          if (this.elapsed < POLL_LIMIT) {
            setTimeout(poll, POLL_DELAY);
          } else {
            if (this.shouldRestore) {
              writeClipboardText(textBefore);
            }
            this.pollPromise = undefined;

            if (!isPoeItem(textAfter)) {
              this.logger.write("warn [ClipboardPoller] No item text found.");
            }
            reject(new Error("Reading clipboard timed out"));
          }
        }
      };
      setTimeout(poll, POLL_DELAY);
    });

    return await this.pollPromise;
  }

  // when `shouldRestore` is false, this function continues
  // to work as a throttler for callback
  restoreShortly(cb: (clipboard: Clipboard) => void) {
    // Not only do we not overwrite the clipboard, but we don't exec callback.
    // This throttling helps against disconnects from "Too many actions".
    if (!this.isRestored) {
      return;
    }

    this.isRestored = false;
    const saved = readClipboardText();
    cb(clipboard);
    setTimeout(() => {
      if (this.shouldRestore) {
        writeClipboardText(saved);
      }
      this.isRestored = true;
    }, RESTORE_AFTER);
  }

  // Expose write for use by text-box and other callers
  writeText(text: string) {
    writeClipboardText(text);
  }

  // Expose read for use by callers that need raw clipboard access
  readText(): string {
    return readClipboardText();
  }
}

function isPoeItem(text: string) {
  return LANGUAGE_DETECTOR.find(({ firstLine }) => text.startsWith(firstLine));
}

const LANGUAGE_DETECTOR = [
  {
    lang: "en",
    firstLine: "Item Class: ",
  },
  {
    lang: "ru",
    firstLine: "\u041a\u043b\u0430\u0441\u0441 \u043f\u0440\u0435\u0434\u043c\u0435\u0442\u0430: ",
  },
  {
    lang: "fr",
    firstLine: "Classe d'objet: ",
  },
  {
    lang: "de",
    firstLine: "Gegenstandsklasse: ",
  },
  {
    lang: "pt",
    firstLine: "Classe do Item: ",
  },
  {
    lang: "es",
    firstLine: "Clase de objeto: ",
  },
  {
    lang: "th",
    firstLine: "\u0e0a\u0e19\u0e34\u0e14\u0e44\u0e2d\u0e40\u0e17\u0e21: ",
  },
  {
    lang: "ko",
    firstLine: "\uc544\uc774\ud15c \uc885\ub958: ",
  },
  {
    lang: "cmn-Hant",
    firstLine: "\u7269\u54c1\u7a2e\u985e: ",
  },
  {
    lang: "cmn-Hans",
    firstLine: "\u7269\u54c1\u7c7b\u522b: ",
  },
  {
    lang: "ja",
    firstLine: "\u30a2\u30a4\u30c6\u30e0\u30af\u30e9\u30b9: ",
  },
];
