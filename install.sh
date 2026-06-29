#!/usr/bin/env bash
#
# Exiled Exchange 2 (KDE Wayland fork) — installer for Arch / CachyOS + KDE Plasma 6.
#
#   curl -fsSL https://raw.githubusercontent.com/pns-sh/Exiled-Exchange-2-Wayland/master/install.sh | bash
#
# Idempotent: re-run any time to update to the latest release.
# Does NOT need to be run as root — it calls sudo only for the bits that need it
# (installing fuse2 and the /dev/uinput udev rule).

set -euo pipefail

REPO="pns-sh/Exiled-Exchange-2-Wayland"
APP_DIR="$HOME/.local/share/exiled-exchange-2-wayland"
APP_PATH="$APP_DIR/EE2-Wayland.AppImage"
BIN_DIR="$HOME/.local/bin"
WRAPPER="$BIN_DIR/ee2-wayland"
DESKTOP="$HOME/.local/share/applications/exiled-exchange-2-wayland.desktop"
USER_NAME="$(id -un)"

note() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "Run as your normal user, not root — the script sudo's when it needs to."

# ---------------------------------------------------------------- environment
note "Checking environment"
command -v curl >/dev/null || die "curl is required."
command -v pacman >/dev/null || warn "pacman not found — this installer targets Arch/CachyOS."
if [ "${XDG_SESSION_TYPE:-}" != "wayland" ]; then
  warn "You are not in a Wayland session (XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-unset})."
  warn "Log out and pick 'Plasma (Wayland)' at the login screen, or the overlay won't work."
fi
printf '%s' "${XDG_CURRENT_DESKTOP:-}" | grep -qi kde \
  || warn "KDE not detected (XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-unset}); this build is KDE-only."

# ----------------------------------------------------------------- packages
note "Installing dependencies (fuse2 for AppImage)"
pkgs=()
ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2' || pkgs+=(fuse2)
if [ "${#pkgs[@]}" -gt 0 ]; then
  if command -v pacman >/dev/null; then
    sudo pacman -S --needed --noconfirm "${pkgs[@]}" \
      || warn "Could not install ${pkgs[*]}; the launcher will fall back to --appimage-extract-and-run."
  else
    warn "Missing ${pkgs[*]} and no pacman; launcher will use --appimage-extract-and-run."
  fi
fi

# ----------------------------------------------------------- /dev/uinput access
# The price-check copies items by synthesizing Ctrl+C via the bundled ydotoold,
# which must be able to write /dev/uinput. Default is root-only; fix with udev.
note "Configuring /dev/uinput access"
echo uinput | sudo tee /etc/modules-load.d/uinput.conf >/dev/null
sudo modprobe uinput 2>/dev/null || true
echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' \
  | sudo tee /etc/udev/rules.d/99-uinput.rules >/dev/null
sudo udevadm control --reload-rules 2>/dev/null || true
sudo udevadm trigger 2>/dev/null || true

REBOOT_NEEDED=0
if ! id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx input; then
  sudo usermod -aG input "$USER_NAME"
  REBOOT_NEEDED=1
fi
[ -w /dev/uinput ] || REBOOT_NEEDED=1

# --------------------------------------------------------------- download
note "Fetching the latest release of $REPO"
mkdir -p "$APP_DIR" "$BIN_DIR"
url="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oE 'https://[^"]+\.AppImage' | head -1 || true)"
[ -n "$url" ] || die "Could not find an .AppImage asset in the latest release."
echo "  $url"
curl -fL --progress-bar -o "$APP_PATH.tmp" "$url"
mv -f "$APP_PATH.tmp" "$APP_PATH"
chmod +x "$APP_PATH"

# --------------------------------------------------------------- launcher
# --no-updates is REQUIRED: the auto-updater would otherwise replace this build
# with the upstream non-Wayland one and break everything.
note "Creating launcher  $WRAPPER"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
APP="$APP_PATH"
if ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
  exec "\$APP" --no-updates "\$@"
else
  exec "\$APP" --appimage-extract-and-run --no-updates "\$@"
fi
EOF
chmod +x "$WRAPPER"

# --------------------------------------------------------------- icon
note "Installing app icon"
ICON_NAME="exiled-exchange-2"
ICON_BASE="https://raw.githubusercontent.com/$REPO/master/main/build/icons"
for s in 16 24 32 48 64 128 256 512; do
  dest="$HOME/.local/share/icons/hicolor/${s}x${s}/apps"
  mkdir -p "$dest"
  curl -fsSL -o "$dest/$ICON_NAME.png" "$ICON_BASE/${s}x${s}.png" \
    || warn "couldn't fetch ${s}x${s} icon"
done
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

# --------------------------------------------------------------- menu entry
note "Creating menu entry"
mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Exiled Exchange 2 (Wayland)
Comment=PoE2 price-check overlay for KDE Plasma Wayland
Exec=$WRAPPER
Icon=$ICON_NAME
Terminal=false
Categories=Game;Utility;
EOF
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
kbuildsycoca6 >/dev/null 2>&1 || true

# --------------------------------------------------------------- done
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — launch from the menu, or add it to PATH to use 'ee2-wayland'." ;;
esac

note "Installed."
cat <<EOF
  Launch:   ee2-wayland   (or the "Exiled Exchange 2 (Wayland)" app-menu entry)
  In PoE2:  use BORDERLESS windowed (not exclusive fullscreen), not under gamescope.
  In-game:  Ctrl+D = price check, Shift+Space = overlay toggle, Esc = close.
  Update later: just re-run this installer.
EOF
if [ "$REBOOT_NEEDED" -eq 1 ]; then
  printf '\n\033[1;33m  REBOOT before first use\033[0m — /dev/uinput access (input group + udev) needs a fresh session.\n'
fi
