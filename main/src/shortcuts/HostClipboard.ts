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
  private initialDelay = POLL_DELAY;

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
      if (process.platform !== "linux") {
        writeClipboardText("");
      } else {
        // workaround KDE's "Prevent empty clipboard" feature (routed through
        // writeClipboardText so it uses wl-copy on native Wayland)
        // see https://github.com/SnosMe/awakened-poe-trade/issues/1790#issuecomment-4062830614
        writeClipboardText(`__EE2_FORCE_EMPTY_${Date.now()}`);
      }
    } else if (process.platform === "linux") {
      // workaround bug in Proton 10+ https://github.com/SnosMe/awakened-poe-trade/issues/1846
      writeClipboardText(`__EE2_FORCE_EMPTY_${Date.now()}`);
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
      setTimeout(poll, this.initialDelay);
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

  updateDelay(delay: number) {
    this.initialDelay = delay;
  }
}

function isPoeItem(text: string) {
  return LANGUAGE_DETECTOR.find(
    ({ firstLine, uncutSkillGemLine }) =>
      text.startsWith(firstLine) || text.startsWith(uncutSkillGemLine),
  );
}

const LANGUAGE_DETECTOR = [
  {
    lang: "en",
    firstLine: "Item Class: ",
    uncutSkillGemLine: "Rarity: ",
  },
  {
    lang: "ru",
    firstLine: "Класс предмета: ",
    uncutSkillGemLine: "Редкость: ",
  },
  {
    lang: "fr",
    firstLine: "Classe d'objet: ",
    uncutSkillGemLine: "Rareté: ",
  },
  {
    lang: "de",
    firstLine: "Gegenstandsklasse: ",
    uncutSkillGemLine: "Seltenheit: ",
  },
  {
    lang: "pt",
    firstLine: "Classe do Item: ",
    uncutSkillGemLine: "Raridade: ",
  },
  {
    lang: "es",
    firstLine: "Clase de objeto: ",
    uncutSkillGemLine: "Rareza: ",
  },
  {
    lang: "th",
    firstLine: "ชนิดไอเทม: ",
    uncutSkillGemLine: "Rarity: ",
  },
  {
    lang: "ko",
    firstLine: "아이템 종류: ",
    uncutSkillGemLine: "아이템 희귀도: ",
  },
  {
    lang: "cmn-Hant",
    firstLine: "物品種類: ",
    uncutSkillGemLine: "稀有度: ",
  },
  {
    lang: "cmn-Hans",
    firstLine: "物品类别: ",
    uncutSkillGemLine: "Rarity: ",
  },
  {
    lang: "ja",
    firstLine: "アイテムクラス: ",
    uncutSkillGemLine: "レアリティ: ",
  },
];
