import path from "path";
import { BrowserWindow, dialog, shell, Menu } from "electron";
import { OVERLAY_WINDOW_OPTS } from "electron-overlay-window";
import type { ServerEvents } from "../server";
import type { Logger } from "../RemoteLogger";
import type { GameWindow } from "./GameWindow";
import { InputProxy } from "./InputProxy";

export class OverlayWindow {
  public isInteractable = false;
  public wasUsedRecently = true;
  private window?: BrowserWindow;
  // KDE Wayland only. See InputProxy for the rationale; in short, the main
  // window is focusable:false (needed for visibility above PoE2's fullscreen
  // Wayland surface), so we can't receive keyboard input directly. The proxy
  // is an invisible focusable window that grabs Wayland keyboard focus on
  // our behalf and forwards keystrokes into the main window via executeJavaScript.
  private inputProxy?: InputProxy;
  private overlayKey: string = "Shift + Space";
  private isOverlayKeyUsed = false;

  constructor(
    private server: ServerEvents,
    private logger: Logger,
    private poeWindow: GameWindow,
  ) {
    this.server.onEventAnyClient(
      "OVERLAY->MAIN::focus-game",
      this.assertGameActive,
    );
    this.poeWindow.on("active-change", this.handlePoeWindowActiveChange);
    this.poeWindow.onAttach(this.handleOverlayAttached);

    this.server.onEventAnyClient("CLIENT->MAIN::used-recently", (e) => {
      this.wasUsedRecently = e.isOverlay;
    });

    if (process.argv.includes("--no-overlay")) return;

    // On KDE Wayland, electron-overlay-window's default Linux options leave
    // the BrowserWindow focusable + with shadow + in taskbar. KWin appears
    // to treat such windows as normal app windows and skips compositing
    // them entirely when setIgnoreMouseEvents(true) is set. Match the
    // settings the standalone wayland-probe used (which DID render visibly
    // with click-through enabled) -- focusable:false, skipTaskbar:true,
    // hasShadow:false.
    const isLinux = process.platform === "linux";
    this.window = new BrowserWindow({
      icon: path.join(__dirname, process.env.STATIC!, "icon.png"),
      ...OVERLAY_WINDOW_OPTS,
      ...(isLinux
        ? {
            focusable: false,
            skipTaskbar: true,
            hasShadow: false,
          }
        : {}),
      width: 800,
      height: 600,
      webPreferences: {
        allowRunningInsecureContent: false,
        webviewTag: true,
        spellcheck: false,
      },
    });

    this.window.setMenu(
      Menu.buildFromTemplate([
        { role: "editMenu" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ]),
    );

    // Create InputProxy for KDE Wayland keyboard input forwarding
    if (isLinux && this.poeWindow.isWayland) {
      this.inputProxy = new InputProxy(this.window, this.assertGameActive);
    }

    this.window.webContents.on("before-input-event", this.handleExtraCommands);
    this.window.webContents.on(
      "did-attach-webview",
      (_, webviewWebContents) => {
        webviewWebContents.on("before-input-event", this.handleExtraCommands);
      },
    );

    this.window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: "deny" };
    });

    // Surface renderer-side warnings/errors into the main log so they are
    // diagnosable without attaching devtools. The console-message signature
    // differs across Electron versions: old = (event, level, message, line,
    // sourceId); new (Electron 36+) = (details) with {level, message,
    // lineNumber, sourceId}. Handle both.
    this.window.webContents.on("console-message", (...args: any[]) => {
      let level: any, message: string, line: any, sourceId: any;
      if (args.length === 1 && args[0] && typeof args[0] === "object") {
        ({ level, message, lineNumber: line, sourceId } = args[0]);
      } else {
        [, level, message, line, sourceId] = args;
      }
      const isErr =
        level === "error" ||
        level === "warning" ||
        level === 2 ||
        level === 3;
      if (isErr) {
        this.logger.write(
          `error [renderer:${level}] ${message} (${sourceId}:${line})`,
        );
      }
    });
  }

  loadAppPage(port: number) {
    const url =
      process.env.VITE_DEV_SERVER_URL || `http://localhost:${port}/index.html`;

    if (!this.window) {
      shell.openExternal(url);
      return;
    }

    if (process.env.VITE_DEV_SERVER_URL) {
      this.window.loadURL(url);
      this.window.webContents.openDevTools({ mode: "detach", activate: false });
    } else {
      this.window.loadURL(url);
    }
  }

  assertOverlayActive = () => {
    if (!this.isInteractable) {
      this.isInteractable = true;
      this.poeWindow.activateOverlay();
      this.poeWindow.isActive = false;
      // Show InputProxy so we can receive keyboard input on Wayland
      this.inputProxy?.show();
      // Pause KWin shortcut grabs so keys reach InputProxy for UI input
      this.poeWindow.pauseShortcuts();
    }
  };

  assertGameActive = () => {
    if (this.isInteractable) {
      this.isInteractable = false;
      // Hide InputProxy first
      this.inputProxy?.hide();
      this.poeWindow.focusTarget();
      this.poeWindow.isActive = true;
      // Resume KWin shortcut grabs
      this.poeWindow.resumeShortcuts();
    }
  };

  toggleActiveState = () => {
    this.isOverlayKeyUsed = true;
    if (this.isInteractable) {
      this.assertGameActive();
    } else {
      this.assertOverlayActive();
    }
  };

  updateOpts(overlayKey: string, windowTitle: string) {
    this.overlayKey = overlayKey;
    this.poeWindow.attach(this.window, windowTitle);
  }

  private handleExtraCommands = (
    event: Electron.Event,
    input: Electron.Input,
  ) => {
    if (input.type !== "keyDown") return;

    let { code, control: ctrlKey, shift: shiftKey, alt: altKey } = input;

    if (code.startsWith("Key")) {
      code = code.slice("Key".length);
    } else if (code.startsWith("Digit")) {
      code = code.slice("Digit".length);
    }

    if (shiftKey && altKey) code = `Shift + Alt + ${code}`;
    else if (ctrlKey && shiftKey) code = `Ctrl + Shift + ${code}`;
    else if (ctrlKey && altKey) code = `Ctrl + Alt + ${code}`;
    else if (altKey) code = `Alt + ${code}`;
    else if (ctrlKey) code = `Ctrl + ${code}`;
    else if (shiftKey) code = `Shift + ${code}`;

    switch (code) {
      case "Escape":
      case "Ctrl + W": {
        event.preventDefault();
        process.nextTick(this.assertGameActive);
        break;
      }
      case this.overlayKey: {
        event.preventDefault();
        process.nextTick(this.toggleActiveState);
        break;
      }
    }
  };

  private handleOverlayAttached = (hasAccess?: boolean) => {
    if (hasAccess === false) {
      this.logger.write(
        "error [Overlay] PoE2 is running with administrator rights",
      );

      dialog.showErrorBox(
        "PoE2 window - No access",
        // ----------------------
        "Path of Exile 2 is running with administrator rights.\n" +
          "\n" +
          "You need to restart Exiled Exchange 2 with administrator rights.",
      );
    } else {
      this.server.sendEventTo("broadcast", {
        name: "MAIN->OVERLAY::overlay-attached",
        payload: undefined,
      });
    }
  };

  private handlePoeWindowActiveChange = (isActive: boolean) => {
    if (isActive && this.isInteractable) {
      this.isInteractable = false;
      // PoE2 reclaimed focus by other means (e.g. user clicked game area).
      // Hide InputProxy if it was showing.
      this.inputProxy?.hide();
      // Resume KWin shortcut grabs
      this.poeWindow.resumeShortcuts();
    }
    this.server.sendEventTo("broadcast", {
      name: "MAIN->OVERLAY::focus-change",
      payload: {
        game: isActive,
        overlay: this.isInteractable,
        usingHotkey: this.isOverlayKeyUsed,
      },
    });
    this.isOverlayKeyUsed = false;
  };
}
