import process from "process";
import { keyTapByName, keyTapWithModsByName } from "./InputSynth";
import type { HostClipboard } from "./HostClipboard";
import type { OverlayWindow } from "../windowing/OverlayWindow";

const PLACEHOLDER_LAST = "@last";
const AUTO_CLEAR = [
  "#", // Global
  "%", // Party
  "@", // Whisper
  "$", // Trade
  "&", // Guild
  "/", // Command
];

// All key synthesis goes through InputSynth -- on Wayland uiohook's XTest
// path doesn't reach Wayland clients (PoE2 sees nothing). InputSynth
// routes through ydotool on Linux and falls back to uiohook elsewhere.
export function typeInChat(
  text: string,
  send: boolean,
  clipboard: HostClipboard,
) {
  clipboard.restoreShortly((cb) => {
    const modKey = process.platform === "darwin" ? "Meta" : "Ctrl";
    const modifiers = [modKey];

    if (text.startsWith(PLACEHOLDER_LAST)) {
      text = text.slice(`${PLACEHOLDER_LAST} `.length);
      clipboard.writeText(text);
      keyTapWithModsByName("Enter", modifiers);
    } else if (text.endsWith(PLACEHOLDER_LAST)) {
      text = text.slice(0, -PLACEHOLDER_LAST.length);
      clipboard.writeText(text);
      keyTapWithModsByName("Enter", modifiers);
      keyTapByName("Home");
      // press twice to focus input when using controller
      keyTapByName("Home");
      keyTapByName("Delete");
    } else {
      clipboard.writeText(text);
      keyTapByName("Enter");
      if (!AUTO_CLEAR.includes(text[0])) {
        keyTapWithModsByName("A", modifiers);
      }
    }

    keyTapWithModsByName("V", modifiers);

    if (send) {
      keyTapByName("Enter");
      // restore the last chat
      keyTapByName("Enter");
      keyTapByName("ArrowUp");
      keyTapByName("ArrowUp");
      keyTapByName("Escape");
    }
  });
}

export function stashSearch(
  text: string,
  clipboard: HostClipboard,
  overlay: OverlayWindow,
) {
  clipboard.restoreShortly((cb) => {
    overlay.assertGameActive();
    clipboard.writeText(text);
    keyTapWithModsByName("F", ["Ctrl"]);

    keyTapWithModsByName("V", [
      process.platform === "darwin" ? "Meta" : "Ctrl",
    ]);
    keyTapByName("Enter");
  });
}
