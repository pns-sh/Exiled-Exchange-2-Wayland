import { BrowserWindow } from "electron";
import { debug } from "../debug";

// A tiny, invisible, focusable BrowserWindow whose only job is to attract
// Wayland keyboard focus away from PoE2 when an EE2 panel is up, then
// forward each keystroke into the main overlay window.
//
// Why it exists: on KDE Wayland the main overlay BrowserWindow has to be
// constructed focusable:false so KWin will composite it above PoE2's
// fullscreen Wayland surface (focusable:true demotes us to a peer app
// and fullscreen PoE2 stacks above). focusable:false means KWin never
// routes keyboard input to us. Splitting the concerns into two windows
// keeps both working: main stays visible-and-deaf, proxy stays
// focusable-and-invisible.
//
// Forwarding model: every keyDown and keyUp the proxy receives is
// replayed as a synthetic KeyboardEvent on the main overlay's
// document.activeElement via executeJavaScript. For keyDown that is not
// preventDefault'd (i.e. the focused element does not have its own
// handler claiming the key -- see HotkeyInput.vue which does), we ALSO
// mutate the element's value: insert printable chars, run
// Backspace/Delete/Arrow/Home/End on inputs that support the selection
// API, fall back to direct value manipulation on inputs that don't
// (type=number, etc.). v-model picks up the change because we dispatch
// an 'input' event after mutation.
//
// Why not webContents.sendInputEvent: it requires the target
// BrowserWindow be focused, which our focusable:false main never is.
// Why not webContents.insertText alone: it bypasses keydown handlers
// entirely, which breaks components like HotkeyInput that need to see
// the keyup with modifier state to capture hotkey bindings.
export class InputProxy {
  private window: BrowserWindow;
  private shown = false;
  // Timestamp (ms) until which key input is ignored. When the overlay opens
  // from a price-check, the ydotool Ctrl+C copy can still be streaming as we
  // grab focus, so its tail arrives at this window. Swallow that synthesized
  // noise for a short window so it isn't forwarded into the overlay or
  // mistaken for a user keypress (e.g. an Escape that would close the panel).
  private ignoreInputUntil = 0;

  constructor(
    private target: BrowserWindow,
    private onEscape: () => void,
  ) {
    this.window = new BrowserWindow({
      focusable: true,
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      hasShadow: false,
      width: 1,
      height: 1,
      x: 0,
      y: 0,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      webPreferences: {
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    // Empty page is fine -- we never render anything, we just need a
    // webContents so before-input-event has somewhere to fire.
    this.window.loadURL("data:text/html,<html><body></body></html>");

    this.window.webContents.on("before-input-event", (event, input) => {
      event.preventDefault();
      // Electron's before-input-event fires for keyDown events. Under our
      // invisible focusable proxy on KDE Wayland it only fires for keyDown.
      // To keep handlers like HotkeyInput.vue (which listens on @keyup)
      // working, we dispatch BOTH keydown and keyup synthetic events on
      // each Electron keyDown. The synthetic pair is back-to-back so the
      // key appears "tapped" from the perspective of the main window's DOM.

      if (input.type !== "keyDown") return;

      // Swallow synthesized key noise (the ydotool copy tail) that races the
      // focus grab right after the panel opens. Without this, a stray Ctrl+C
      // gets forwarded into the overlay and a stray Escape would close it.
      if (Date.now() < this.ignoreInputUntil) {
        return;
      }

      // Escape closes the overlay panel
      if (input.key === "Escape" && !input.control && !input.alt && !input.shift) {
        this.onEscape();
        return;
      }

      const key = input.key;
      const code = input.code;
      const ctrlKey = input.control;
      const shiftKey = input.shift;
      const altKey = input.alt;
      const metaKey = input.meta;

      // Build the JS to execute in the main overlay's context
      const js = this._buildForwardingScript(key, code, ctrlKey, shiftKey, altKey, metaKey);
      this.target.webContents.executeJavaScript(js).catch(() => {
        // Ignore errors from executeJavaScript (e.g. if page navigated)
      });
    });
  }

  private _buildForwardingScript(
    key: string,
    code: string,
    ctrlKey: boolean,
    shiftKey: boolean,
    altKey: boolean,
    metaKey: boolean,
  ): string {
    // Escape special chars for embedding in a JS string literal
    const safeKey = JSON.stringify(key);
    const safeCode = JSON.stringify(code);

    return `(function() {
  var el = document.activeElement;
  if (!el) return;

  var opts = {
    key: ${safeKey},
    code: ${safeCode},
    ctrlKey: ${ctrlKey},
    shiftKey: ${shiftKey},
    altKey: ${altKey},
    metaKey: ${metaKey},
    bubbles: true,
    cancelable: true
  };

  // Dispatch keydown
  var downEvt = new KeyboardEvent("keydown", opts);
  var downPrevented = !el.dispatchEvent(downEvt);

  // If keydown was not prevented and this is a printable char or
  // editing key, mutate the element's value
  if (!downPrevented && el.tagName && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
    var key = ${safeKey};
    try {
      if (key.length === 1 && !${ctrlKey} && !${altKey} && !${metaKey}) {
        // Printable character -- insert at cursor
        if (typeof el.selectionStart === "number") {
          var start = el.selectionStart;
          var end = el.selectionEnd;
          el.value = el.value.slice(0, start) + key + el.value.slice(end);
          el.selectionStart = el.selectionEnd = start + 1;
        } else {
          el.value += key;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (key === "Backspace") {
        if (typeof el.selectionStart === "number") {
          var start = el.selectionStart;
          var end = el.selectionEnd;
          if (start === end && start > 0) {
            el.value = el.value.slice(0, start - 1) + el.value.slice(end);
            el.selectionStart = el.selectionEnd = start - 1;
          } else if (start !== end) {
            el.value = el.value.slice(0, start) + el.value.slice(end);
            el.selectionStart = el.selectionEnd = start;
          }
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (key === "Delete") {
        if (typeof el.selectionStart === "number") {
          var start = el.selectionStart;
          var end = el.selectionEnd;
          if (start === end && end < el.value.length) {
            el.value = el.value.slice(0, start) + el.value.slice(end + 1);
            el.selectionStart = el.selectionEnd = start;
          } else if (start !== end) {
            el.value = el.value.slice(0, start) + el.value.slice(end);
            el.selectionStart = el.selectionEnd = start;
          }
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (key === "Home" && typeof el.selectionStart === "number") {
        el.selectionStart = el.selectionEnd = 0;
      } else if (key === "End" && typeof el.selectionStart === "number") {
        el.selectionStart = el.selectionEnd = el.value.length;
      } else if (key === "ArrowLeft" && typeof el.selectionStart === "number") {
        var pos = Math.max(0, el.selectionStart - 1);
        el.selectionStart = el.selectionEnd = pos;
      } else if (key === "ArrowRight" && typeof el.selectionStart === "number") {
        var pos = Math.min(el.value.length, el.selectionEnd + 1);
        el.selectionStart = el.selectionEnd = pos;
      }
    } catch(e) { /* ignore selection API errors on some input types */ }
  }

  // Dispatch keyup
  var upEvt = new KeyboardEvent("keyup", opts);
  el.dispatchEvent(upEvt);
})();`;
  }

  show() {
    if (this.shown) return;
    this.shown = true;
    // Briefly ignore inbound keys so the in-flight copy synth's tail can't
    // bounce us closed. 250ms comfortably covers a ydotool batch drain.
    this.ignoreInputUntil = Date.now() + 250;
    debug("[InputProxy] show");
    this.window.showInactive();
    // Small delay before focusing to let KWin process the show
    setTimeout(() => {
      if (this.shown) {
        this.window.focus();
      }
    }, 50);
  }

  hide() {
    if (!this.shown) return;
    this.shown = false;
    debug("[InputProxy] hide");
    this.window.hide();
  }

  destroy() {
    this.window.destroy();
  }
}
