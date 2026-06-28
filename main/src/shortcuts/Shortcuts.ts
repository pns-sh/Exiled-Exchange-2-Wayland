import { screen, globalShortcut } from "electron";
import { uIOhook, UiohookKey, UiohookWheelEvent } from "uiohook-napi";
import {
  isModKey,
  KeyToElectron,
  mergeTwoHotkeys,
} from "../../../ipc/KeyToCode";
import {
  keyTapByName,
  keyToggleByName,
  keyTapWithModsByName,
} from "./InputSynth";
import { debug } from "../debug";
import { typeInChat, stashSearch } from "./text-box";
import { WidgetAreaTracker } from "../windowing/WidgetAreaTracker";
import { isKdeWayland } from "../windowing/WaylandTracker";
import { HostClipboard } from "./HostClipboard";
import { OcrWorker } from "../vision/link-main";
import type { ShortcutAction } from "../../../ipc/types";
import type { Logger } from "../RemoteLogger";
import type { OverlayWindow } from "../windowing/OverlayWindow";
import type { GameWindow } from "../windowing/GameWindow";
import type { GameConfig } from "../host-files/GameConfig";
import type { ServerEvents } from "../server";

type UiohookKeyT = keyof typeof UiohookKey;
const UiohookToName = Object.fromEntries(
  Object.entries(UiohookKey).map(([k, v]) => [v, k]),
);

// On Linux we dispatch from the WaylandTracker's KWin script (via DBus),
// which calls `registerShortcut(...)` at the compositor level. That is the
// only way Ctrl+letter combos reach the app under KDE Wayland -- KWin filters
// them out of the XWayland pipeline otherwise. Electron's globalShortcut
// (XGrabKey-based) sees nothing. Side-effect: PoE2 does not see the key
// either, since KWin treats it as a compositor-claimed shortcut.
const USE_COMPOSITOR_HOTKEYS = process.platform === "linux";

// Convert Qt format shortcuts ("Ctrl+D") to internal format ("Ctrl + D")
function electronToInternal(shortcut: string): string {
  return shortcut
    .split("+")
    .map((s) => s.trim())
    .join(" + ");
}

export class Shortcuts {
  private actions: ShortcutAction[] = [];
  private actionByShortcut = new Map<string, ShortcutAction>();
  private stashScroll = false;
  private logKeys = false;
  private areaTracker: WidgetAreaTracker;
  private clipboard: HostClipboard;
  // KDE Wayland re-entrancy guard for the price-check copy. KWin delivers a
  // held global hotkey (Ctrl+D) as an auto-repeat stream. The first fire
  // copies the item and opens the overlay (which grabs keyboard focus via the
  // InputProxy); a second fire arriving before that settles synthesizes
  // another Ctrl+C that now lands on the focused InputProxy instead of PoE2 --
  // diverting the copy and bouncing focus so the panel "opens then vanishes".
  // While a copy is in flight we drop further copy triggers.
  private copyItemInFlight = false;

  static async create(
    logger: Logger,
    overlay: OverlayWindow,
    poeWindow: GameWindow,
    gameConfig: GameConfig,
    server: ServerEvents,
  ) {
    const ocrWorker = await OcrWorker.create();
    const shortcuts = new Shortcuts(
      logger,
      overlay,
      poeWindow,
      gameConfig,
      server,
      ocrWorker,
    );
    return shortcuts;
  }

  private constructor(
    private logger: Logger,
    private overlay: OverlayWindow,
    private poeWindow: GameWindow,
    private gameConfig: GameConfig,
    private server: ServerEvents,
    private ocrWorker: OcrWorker,
  ) {
    this.areaTracker = new WidgetAreaTracker(server, overlay);
    this.clipboard = new HostClipboard(logger);

    this.poeWindow.on("active-change", (isActive) => {
      process.nextTick(() => {
        if (isActive === this.poeWindow.isActive) {
          if (isActive) {
            this.register();
          } else {
            this.unregister();
          }
        }
      });
    });

    this.server.onEventAnyClient("CLIENT->MAIN::user-action", (e) => {
      if (e.action === "stash-search") {
        stashSearch(e.text, this.clipboard, this.overlay);
      }
    });

    uIOhook.on("keydown", (e) => {
      if (!this.logKeys) return;
      const pressed = eventToString(e);
      this.logger.write(`debug [Shortcuts] Keydown ${pressed}`);
    });

    if (USE_COMPOSITOR_HOTKEYS) {
      const lastHotkeyAt = new Map<string, number>();
      this.poeWindow.onHotkey((shortcut) => {
        // KWin emits the shortcut in Qt format ("Ctrl+D"); our action map is
        // keyed on the app's internal format ("Ctrl + D").
        const internal = electronToInternal(shortcut);
        debug(
          `[Shortcuts] kwin-hotkey shortcut="${shortcut}" internal="${internal}" isActive=${this.poeWindow.isActive} hit=${this.actionByShortcut.has(internal)}`,
        );
        if (!this.poeWindow.isActive) return;
        // SAFETY/debounce: KWin can deliver a held global shortcut as a rapid
        // repeat stream. Every fire synthesizes modifier keys via ydotool;
        // unthrottled, overlapping batches previously latched a stuck modifier
        // that locked the whole keyboard. Ignore repeats of the same shortcut
        // within 350ms so a held combo fires at most once.
        const now = Date.now();
        if (now - (lastHotkeyAt.get(internal) ?? 0) < 350) return;
        lastHotkeyAt.set(internal, now);
        const entry = this.actionByShortcut.get(internal);
        if (!entry || entry.action.type === "test-only") return;
        this.runAction(entry);
      });
    }

    uIOhook.on("keyup", (e) => {
      if (!this.logKeys) return;
      this.logger.write(
        `debug [Shortcuts] Keyup ${
          UiohookToName[e.keycode] || "not_supported_key"
        }`,
      );
    });

    uIOhook.on("wheel", (e) => {
      if (!e.ctrlKey || !this.poeWindow.isActive || !this.stashScroll) return;

      if (!isStashArea(e, this.poeWindow)) {
        if (e.rotation > 0) {
          keyTapByName("ArrowRight");
        } else if (e.rotation < 0) {
          keyTapByName("ArrowLeft");
        }
      }
    });
  }

  updateDelay(delay: number) {
    this.clipboard.updateDelay(delay);
  }

  updateActions(
    actions: ShortcutAction[],
    stashScroll: boolean,
    logKeys: boolean,
    restoreClipboard: boolean,
    language: string,
  ) {
    this.stashScroll = stashScroll;
    this.logKeys = logKeys;
    this.clipboard.updateOptions(restoreClipboard);
    this.ocrWorker.updateOptions(language);

    const copyItemShortcut = mergeTwoHotkeys(
      "Ctrl + C",
      this.gameConfig.showModsKey,
    );
    if (copyItemShortcut !== "Ctrl + C") {
      actions.push({
        shortcut: copyItemShortcut,
        action: { type: "test-only" },
      });
    }

    const allShortcuts = new Set([
      "Ctrl + C",
      "Ctrl + V",
      "Ctrl + A",
      "Ctrl + F",
      "Ctrl + Enter",
      "Home",
      "Delete",
      "Enter",
      "ArrowUp",
      "ArrowRight",
      "ArrowLeft",
      copyItemShortcut,
    ]);

    for (const action of actions) {
      if (
        allShortcuts.has(action.shortcut) &&
        action.action.type !== "test-only"
      ) {
        this.logger.write(
          `error [Shortcuts] Hotkey "${action.shortcut}" reserved by the game will not be registered.`,
        );
      }
    }
    actions = actions.filter((action) => !allShortcuts.has(action.shortcut));

    const duplicates = new Set<string>();
    for (const action of actions) {
      if (allShortcuts.has(action.shortcut)) {
        this.logger.write(
          `error [Shortcuts] It is not possible to use the same hotkey "${action.shortcut}" for multiple actions.`,
        );
        duplicates.add(action.shortcut);
      } else {
        allShortcuts.add(action.shortcut);
      }
    }
    this.actions = actions.filter(
      (action) =>
        !duplicates.has(action.shortcut) ||
        action.action.type === "toggle-overlay",
    );

    // Build the lookup map for compositor hotkey dispatch
    this.actionByShortcut.clear();
    for (const entry of this.actions) {
      this.actionByShortcut.set(entry.shortcut, entry);
    }
  }

  private runAction(entry: ShortcutAction) {
    if (this.logKeys) {
      this.logger.write(
        `debug [Shortcuts] Action type: ${entry.action.type}`,
      );
    }

    if (entry.keepModKeys) {
      const nonModKey = entry.shortcut
        .split(" + ")
        .filter((key) => !isModKey(key))[0];
      keyToggleByName(nonModKey, "up");
    } else {
      entry.shortcut
        .split(" + ")
        .reverse()
        .forEach((key) => {
          keyToggleByName(key, "up");
        });
    }

    if (entry.action.type === "toggle-overlay") {
      this.areaTracker.removeListeners();
      this.overlay.toggleActiveState();
    } else if (entry.action.type === "paste-in-chat") {
      typeInChat(entry.action.text, entry.action.send, this.clipboard);
    } else if (entry.action.type === "trigger-event") {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->CLIENT::widget-action",
        payload: { target: entry.action.target },
      });
    } else if (entry.action.type === "stash-search") {
      stashSearch(entry.action.text, this.clipboard, this.overlay);
    } else if (entry.action.type === "copy-item") {
      const { action } = entry;

      // KDE Wayland re-entrancy guards (see copyItemInFlight field comment):
      //   1. If the overlay already holds keyboard focus, the game can't
      //      receive a synthesized Ctrl+C -- it would land on our InputProxy
      //      and bounce focus. This is a stable state check, not a timer.
      //   2. While a copy is still polling the clipboard, drop overlapping
      //      triggers (held-key auto-repeat) so we don't fire redundant synths.
      if (isKdeWayland()) {
        if (this.overlay.isInteractable || this.copyItemInFlight) return;
        this.copyItemInFlight = true;
      }
      const releaseCopyLock = () => {
        this.copyItemInFlight = false;
      };

      // On Wayland, screen.getCursorScreenPoint() returns frozen coords.
      // Use the WaylandTracker's cursor position instead.
      const pressPosition =
        this.poeWindow.getCursorPoint() ?? screen.getCursorScreenPoint();

      // Set once the clipboard yields an item, so the auto-retry below stops.
      let copied = false;

      this.clipboard
        .readItemText()
        .then((clipboard) => {
          copied = true;
          this.areaTracker.removeListeners();
          this.server.sendEventTo("last-active", {
            name: "MAIN->CLIENT::item-text",
            payload: {
              target: action.target,
              clipboard,
              position: pressPosition,
              focusOverlay: Boolean(action.focusOverlay),
            },
          });
          if (isKdeWayland()) {
            // On KDE Wayland the overlay window is only actually visible while
            // it's active; a click-through overlay doesn't render its panel.
            // The original gate (focusOverlay && wasUsedRecently) is false when
            // the price-check is triggered from the game, so the panel stayed
            // hidden until the user manually toggled the overlay (Shift+Space).
            // Activate it here so the price-check shows immediately.
            this.overlay.assertOverlayActive();
          } else if (action.focusOverlay && this.overlay.wasUsedRecently) {
            this.overlay.assertOverlayActive();
          }
        })
        .catch(() => {})
        .finally(releaseCopyLock);

      const pressedModKeys = entry.keepModKeys
        ? entry.shortcut.split(" + ").filter((key) => isModKey(key))
        : undefined;

      if (isKdeWayland()) {
        // The synthesized Ctrl+C occasionally doesn't land on PoE2 on the
        // first try (focus/timing right after a previous overlay close), so
        // the clipboard stays empty and the panel never opens -- the user
        // learned to "press Ctrl+D a few times". Do those retries ourselves:
        // re-synth the copy until the clipboard yields an item (copied) or the
        // overlay has taken focus, up to a handful of tries. The interval must
        // exceed one ydotool batch (~600ms, now serialized) so a retry never
        // queues behind an in-flight batch; a successful copy lands and
        // resolves well before the first interval elapses, so this only ever
        // fires again when a copy genuinely missed.
        const COPY_RETRIES = 3;
        const COPY_RETRY_MS = 650;
        const trySynthCopy = (attempt: number) => {
          if (copied || this.overlay.isInteractable) return;
          pressKeysToCopyItemText(pressedModKeys, this.gameConfig.showModsKey);
          if (attempt + 1 < COPY_RETRIES) {
            setTimeout(() => trySynthCopy(attempt + 1), COPY_RETRY_MS);
          }
        };
        trySynthCopy(0);
      } else {
        pressKeysToCopyItemText(pressedModKeys, this.gameConfig.showModsKey);
      }
    } else if (
      entry.action.type === "ocr-text" &&
      entry.action.target === "heist-gems"
    ) {
      if (process.platform !== "win32") return;

      const { action } = entry;
      const pressTime = Date.now();
      const imageData = this.poeWindow.screenshot();
      this.ocrWorker
        .findHeistGems({
          width: this.poeWindow.bounds.width,
          height: this.poeWindow.bounds.height,
          data: imageData,
        })
        .then((result) => {
          this.server.sendEventTo("last-active", {
            name: "MAIN->CLIENT::ocr-text",
            payload: {
              target: action.target,
              pressTime,
              ocrTime: result.elapsed,
              paragraphs: result.recognized.map((p) => p.text),
            },
          });
        })
        .catch(() => {});
    }
  }

  private register() {
    if (USE_COMPOSITOR_HOTKEYS) {
      // On Linux, register shortcuts via KWin compositor
      const shortcutStrings = this.actions
        .map((entry) => shortcutToElectron(entry.shortcut))
        .filter((s) => s.length > 0);
      this.poeWindow.setShortcuts(shortcutStrings);
      return;
    }

    for (const entry of this.actions) {
      const isOk = globalShortcut.register(
        shortcutToElectron(entry.shortcut),
        () => {
          this.runAction(entry);
        },
      );

      if (!isOk) {
        this.logger.write(
          `error [Shortcuts] Failed to register a shortcut "${entry.shortcut}". It is already registered by another application.`,
        );
      }

      if (entry.action.type === "test-only") {
        globalShortcut.unregister(shortcutToElectron(entry.shortcut));
      }
    }
  }

  private unregister() {
    if (USE_COMPOSITOR_HOTKEYS) {
      this.poeWindow.setShortcuts([]);
      return;
    }
    globalShortcut.unregisterAll();
  }
}

function pressKeysToCopyItemText(
  pressedModKeys: string[] = [],
  showModsKey: string,
) {
  // PoE2 copies the full item (including mod tiers) with a plain Ctrl+C. Unlike
  // PoE1 it has no Ctrl+Alt+C "advanced copy" -- merging the show-mods key (Alt)
  // yields a combo PoE2 doesn't treat as copy, so nothing reaches the clipboard
  // and the price-check stays empty. Use a plain Ctrl+C.
  void showModsKey;
  let keys = ["Ctrl", "C"];
  keys = keys.filter((key) => key !== "C");
  if (process.platform !== "darwin" && !isKdeWayland()) {
    // On non-Mac platforms, don't toggle keys that are already being pressed.
    //
    // For unknown reasons, we need to toggle pressed keys on Mac for advanced
    // mod descriptions to be copied. You can test this by setting the shortcut
    // to "Alt + any letter". They'll work with this line, but not if it's
    // commented out.
    //
    // EXCEPTION (KDE Wayland): the hotkey arrives via a KWin global shortcut,
    // which consumes the physical key combo -- so the held modifier (e.g. Ctrl)
    // is NOT reliably down when we synthesize the copy. Keep all modifiers so
    // we emit a complete Ctrl(+Alt)+C ourselves via ydotool; the InputSynth
    // batch holds them across the C tap and releases them at the batch end.
    keys = keys.filter((key) => !pressedModKeys.includes(key));
  }

  for (const key of keys) {
    keyToggleByName(key, "down");
  }

  // finally press `C` to copy text
  keyTapByName("C");

  // Timeout to enforce release of keys
  // Game was dropping the release inputs for some reason
  setTimeout(() => {
    keys.reverse();
    for (const key of keys) {
      keyToggleByName(key, "up");
    }
  }, 10);
}

function isStashArea(mouse: UiohookWheelEvent, poeWindow: GameWindow): boolean {
  if (
    !poeWindow.bounds ||
    mouse.x > poeWindow.bounds.x + poeWindow.uiSidebarWidth
  )
    return false;

  return (
    mouse.y > poeWindow.bounds.y + (poeWindow.bounds.height * 154) / 1600 &&
    mouse.y < poeWindow.bounds.y + (poeWindow.bounds.height * 1192) / 1600
  );
}

function eventToString(e: {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  const { ctrlKey, shiftKey, altKey } = e;

  let code = UiohookToName[e.keycode];
  if (!code) return "not_supported_key";

  if (code === "Shift" || code === "Alt" || code === "Ctrl") return code;

  if (ctrlKey && shiftKey && altKey) code = `Ctrl + Shift + Alt + ${code}`;
  else if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
  else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
  else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
  else if (altKey) code = `Alt + ${code}`;
  else if (ctrlKey) code = `Ctrl + ${code}`;
  else if (shiftKey) code = `Shift + ${code}`;

  return code;
}

function shortcutToElectron(shortcut: string) {
  return shortcut
    .split(" + ")
    .map((k) => KeyToElectron[k as keyof typeof KeyToElectron])
    .join("+");
}
