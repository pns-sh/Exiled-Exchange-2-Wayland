import { screen, type BrowserWindow, type Rectangle } from "electron";
import { EventEmitter } from "events";
import { OverlayController, AttachEvent } from "electron-overlay-window";
import { WaylandTracker, isKdeWayland, Bounds } from "./WaylandTracker";
import { debug } from "../debug";
import type { Logger } from "../RemoteLogger";

export interface GameWindow {
  on: (event: "active-change", listener: (isActive: boolean) => void) => this;
}

const ZERO_BOUNDS: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

export class GameWindow extends EventEmitter {
  private _isActive = false;
  private _isTracking = false;
  private _trackedWindow: BrowserWindow | undefined;
  private _waylandTracker: WaylandTracker | null = null;
  private _attachCbs: Array<(hasAccess: boolean | undefined) => void> = [];

  constructor(private logger?: Logger) {
    super();
    const kdeWayland = isKdeWayland();
    debug(
      `[GameWindow] isKdeWayland=${kdeWayland} ` +
        `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? "<unset>"} ` +
        `XDG_CURRENT_DESKTOP=${process.env.XDG_CURRENT_DESKTOP ?? "<unset>"}`,
    );
    if (kdeWayland && this.logger) {
      this._waylandTracker = new WaylandTracker(this.logger);
      this.logger.write(
        "info [GameWindow] KDE Wayland detected, using WaylandTracker backend",
      );
    }
  }

  get bounds(): Rectangle {
    if (this._waylandTracker) {
      return this._waylandTracker.bounds ?? ZERO_BOUNDS;
    }
    return OverlayController.targetBounds;
  }

  get isActive() {
    return this._isActive;
  }

  set isActive(active: boolean) {
    if (this.isActive !== active) {
      this._isActive = active;
      this.emit("active-change", this._isActive);
    }
  }

  get uiSidebarWidth() {
    // sidebar is 370px at 800x600
    const ratio = 370 / 600;
    return Math.round(this.bounds.height * ratio);
  }

  attach(window: BrowserWindow | undefined, title: string) {
    if (this._isTracking) return;
    this._isTracking = true;
    this._trackedWindow = window;

    if (this._waylandTracker) {
      debug(`[GameWindow] attach() title="${title}", starting WaylandTracker`);
      // electron-overlay-window normally handles initial show, click-through,
      // and alwaysOnTop in its attachByTitle path. We do them explicitly here.
      window?.setIgnoreMouseEvents(true);
      window?.setAlwaysOnTop(true, "screen-saver");
      window?.showInactive();

      this._waylandTracker.on("focus", (focused: boolean) => {
        debug(`[GameWindow] wayland focus=${focused}`);
        this.isActive = focused;
      });

      this._waylandTracker.on("geometry", (bounds: Bounds) => {
        // Resize overlay to match PoE2 window
        if (window && !window.isDestroyed()) {
          window.setBounds({
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
          });
        }
      });

      this._waylandTracker.start().then(() => {
        debug("[GameWindow] WaylandTracker started");
        // Fire attach callbacks -- on Wayland we always have access
        for (const cb of this._attachCbs) {
          cb(true);
        }
      });
    } else {
      OverlayController.events.on("focus", () => {
        this.isActive = true;
      });
      OverlayController.events.on("blur", () => {
        this.isActive = false;
      });
      OverlayController.attachByTitle(window, title, {
        hasTitleBarOnMac: true,
      });
    }
  }

  onAttach(cb: (hasAccess: boolean | undefined) => void) {
    if (this._waylandTracker) {
      this._attachCbs.push(cb);
    } else {
      OverlayController.events.on("attach", (e: AttachEvent) => {
        cb(e.hasAccess);
      });
    }
  }

  screenshot() {
    if (this._waylandTracker) {
      // Screenshot is only used by the win32-gated heist OCR feature.
      // Return empty buffer on Wayland.
      return Buffer.alloc(0);
    }
    return OverlayController.screenshot();
  }

  // --- Wayland-specific focus management ---
  // Called by OverlayWindow to activate/deactivate the overlay

  activateOverlay() {
    if (this._waylandTracker && this._trackedWindow) {
      // Make the overlay interactable: focusable + clickable
      this._trackedWindow.setFocusable(true);
      this._trackedWindow.setIgnoreMouseEvents(false);
      this._trackedWindow.focus();
      debug("[GameWindow] activateOverlay (wayland)");
    } else {
      OverlayController.activateOverlay();
    }
  }

  focusTarget() {
    if (this._waylandTracker && this._trackedWindow) {
      // Return to click-through overlay mode
      this._trackedWindow.setIgnoreMouseEvents(true);
      this._trackedWindow.setFocusable(false);
      debug("[GameWindow] focusTarget (wayland)");
    } else {
      OverlayController.focusTarget();
    }
  }

  // --- Wayland-specific shortcut/hotkey/cursor APIs ---

  async setShortcuts(shortcuts: string[]): Promise<void> {
    if (this._waylandTracker) {
      await this._waylandTracker.setShortcuts(shortcuts);
    }
  }

  onHotkey(cb: (shortcut: string) => void) {
    if (this._waylandTracker) {
      this._waylandTracker.onHotkey(cb);
    }
  }

  getCursorPoint(): { x: number; y: number } | null {
    if (this._waylandTracker) {
      return this._waylandTracker.cursor;
    }
    return null;
  }

  async pauseShortcuts(): Promise<void> {
    if (this._waylandTracker) {
      await this._waylandTracker.pauseShortcuts();
    }
  }

  async resumeShortcuts(): Promise<void> {
    if (this._waylandTracker) {
      await this._waylandTracker.resumeShortcuts();
    }
  }

  get isWayland(): boolean {
    return this._waylandTracker !== null;
  }
}
