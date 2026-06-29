# ![Perfect Jewelers Orb](./renderer/public/images/jeweler.png) Exiled Exchange 2

[![GitHub Downloads (specific asset, latest release)](https://img.shields.io/github/downloads/kvan7/exiled-exchange-2/latest/Exiled-Exchange-2-Setup-0.15.8.exe?style=plastic&link=https%3A%2F%2Ftooomm.github.io%2Fgithub-release-stats%2F%3Fusername%3Dkvan7%26repository%3DExiled-Exchange-2)](https://tooomm.github.io/github-release-stats/?username=kvan7&repository=Exiled-Exchange-2)
[![GitHub Tag](https://img.shields.io/github/v/tag/kvan7/exiled-exchange-2?style=plastic&label=latest%20version)](https://github.com/Kvan7/Exiled-Exchange-2/releases/latest)
[![GitHub commits since latest release (branch)](https://img.shields.io/github/commits-since/kvan7/exiled-exchange-2/latest/dev?style=plastic)](https://github.com/Kvan7/Exiled-Exchange-2/commits/dev/)
[![Translation status](https://translate.codeberg.org/widget/exiled-exchange-2/svg-badge.svg)](https://translate.codeberg.org/engage/exiled-exchange-2/)

Path of Exile 2 overlay program for price checking items, among many other loved features.

Fork of [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade).

The ONLY official download sites are <https://kvan7.github.io/Exiled-Exchange-2/download> or <https://github.com/Kvan7/Exiled-Exchange-2/releases>, any other locations are not official and may be malicious.

## KDE Wayland fork (this repo)

This fork adds **native KDE Plasma 6 Wayland** support, where the stock build's
global hotkeys and overlay do not work (uiohook/XGrabKey never sees the keys).
It is built on top of [`coreydeli/Exiled-Exchange-2-Wayland`](https://github.com/coreydeli/Exiled-Exchange-2-Wayland)
and merged up to upstream `Kvan7` v0.15.8.

What it does differently on Linux/Wayland:

- **Global hotkeys** are registered through a generated **KWin script over D-Bus**
  (`registerShortcut`) — the only way `Ctrl`+letter combos reach the app under KDE
  Wayland.
- **Input synthesis** (the price-check copy) goes through bundled **ydotool/ydotoold**
  (uinput); clipboard via bundled **wl-clipboard**.
- A **KWin script positions/keeps the overlay above PoE2** (Wayland forbids a client
  positioning its own window) and reactivates PoE2 on close.
- A focusable **1×1 InputProxy window** grabs keyboard focus on the overlay's behalf
  (the main overlay must be `focusable:false` to composite above the game).

### Price-check reliability fixes (0.15.8-1)

The price-check panel used to "open then vanish" / need several `Ctrl+D` presses on
KDE Wayland. Root causes and fixes:

- **Serialize ydotool** — overlapping invocations interleaved on the single uinput
  device and corrupted `Ctrl+C` into a bare `C` (opened the Character panel, copied
  nothing).
- **Clipboard "nudge"** — PoE2's Wayland clipboard copy stayed masked behind our own
  `wl-copy` placeholder for seconds; re-writing the placeholder mid-poll flushes the
  pending copy into the readable selection in ~tens of ms.
- **Copy re-entrancy guard + InputProxy grace window** — a held `Ctrl+D` can no longer
  synthesize a copy into the focused overlay, and the synth's key tail can't bounce the
  panel closed.

### Quick install (Arch / CachyOS + KDE Plasma)

```sh
curl -fsSL https://raw.githubusercontent.com/pns-sh/Exiled-Exchange-2-Wayland/master/install.sh | bash
```

The installer downloads the latest release AppImage, installs `fuse2`, sets up
`/dev/uinput` access (udev rule + `input` group, needed for the price-check key
synthesis), and creates an `ee2-wayland` launcher + app-menu entry that always
passes `--no-updates`. Re-run it any time to update. A **reboot** is required
after the first run if it had to add you to the `input` group.

### Requirements & usage

- PoE2 in **Borderless windowed** (not exclusive fullscreen), **not** under gamescope.
- Build from source (`main/`): `rm -rf dist && npm run build && npm run package`; the
  AppImage lands in `main/dist/`.
- Usage: hover an item + **Ctrl+D** = price check, **Shift+Space** = overlay toggle,
  **Esc** = close & refocus the game.

## Moving from POE1/Awakened PoE Trade

1. Download latest release from [releases](https://github.com/Kvan7/exiled-exchange-2/releases)
2. Run installer
3. Run Exiled Exchange 2
4. Launch PoE2 to generate correct files
5. Quit PoE2 and EE2 after seeing the banner popup that EE2 loaded
6. Copy `apt-data` from `%APPDATA%\awakened-poe-trade` to `%APPDATA%\exiled-exchange-2` to copy your previous settings
  - Resulting directory structure should look like this:
  - `%APPDATA%\exiled-exchange-2\apt-data\`
    - `config.json`
7. Edit `config.json` and change the value of "windowTitle": "Path of Exile" to instead be "Path of Exile 2", otherwise it will open only for poe1
8. Start Exiled Exchange 2 and PoE2

## FAQ

<https://kvan7.github.io/Exiled-Exchange-2/faq>

## Tool showcase

| Gem                                                | Rare                                                 | Unique                                                   | Currency                                                     |
| -------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| ![Gem Check](./docs/reference-images/GemCheck.png) | ![Rare Check](./docs/reference-images/RareCheck.png) | ![Unique Check](./docs/reference-images/UniqueCheck.png) | ![Currency Check](./docs/reference-images/CurrencyCheck.png) |

### Development

See [DEVELOPING.md](./DEVELOPING.md)

### Acknowledgments

- [awakened-poe-trade](https://github.com/SnosMe/awakened-poe-trade)
- [libuiohook](https://github.com/kwhat/libuiohook)
- [RePoE](https://github.com/brather1ng/RePoE)
- [poeprices.info](https://www.poeprices.info/)
- [poe.ninja](https://poe.ninja/)

![graph](https://i.imgur.com/MATqhv7.png)
