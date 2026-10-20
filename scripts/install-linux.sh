#!/usr/bin/env bash
# ShuviX command-line installer for Linux — headless servers as well as desktops.
#
#   curl -fsSL https://github.com/wangdongdongc/ShuviX/releases/latest/download/install-linux.sh | bash -s -- [options]
#
# Debian / Ubuntu (apt): installs the release's .deb with apt-get (which pulls Electron's runtime
# libraries). Other distributions: extracts the release's AppImage into ~/.local/share/shuvix and adds a
# ~/.local/bin/shuvix launcher (no FUSE needed). Both also get a `shuvix-server` helper that runs ShuviX
# headless in the foreground; --service adds a systemd service that runs it headless as you (as root too:
# then ShuviX runs with --no-sandbox, since Electron does not start as root otherwise). Who can connect is
# decided by ShuviX's security policy network-admission: by default only the machine itself (127.0.0.1;
# reach it through an SSH tunnel). --lan and --bind <interface or address> are deprecated but still
# accepted and passed on to ShuviX, which turns them into that policy once on its first start (when the
# user has none yet).
#
# Rerunning upgrades in place. Your data (~/.config/shuvix, ~/.shuvix) is never touched, not even by
# --uninstall. The only prompt is sudo's password.
#
# For tests, these environment variables replace what the script would detect:
#   SHUVIX_INSTALL_UNAME_S, SHUVIX_INSTALL_UNAME_M   operating system / machine (uname -s / -m)
#   SHUVIX_INSTALL_PKG                               deb | appimage (instead of looking for apt-get)
#   SHUVIX_INSTALL_UID, SHUVIX_INSTALL_USER          the invoking user's id / name
#   SHUVIX_INSTALL_REPO                              owner/repo to download releases from
set -euo pipefail

usage() {
  cat <<'EOF'
Install ShuviX on Linux (Debian / Ubuntu via apt, other distributions via the AppImage).

Usage: install-linux.sh [options]
  --version <tag>   install a specific release (e.g. v0.2.12-beta.1); default: the latest release
  --service         install and start a systemd service that runs ShuviX headless as you
  --port <n>        port for the service (default 7766)
  --lan             deprecated: on its first start ShuviX writes a network-admission policy that
                    lets every device on the local network connect (no password!)
  --bind <name>     deprecated: the same for one network only — a network interface (e.g. eth1) or
                    an address of this machine; implies --lan
  --deb <file>      install a local .deb instead of downloading one (CI / offline)
  --uninstall       remove the service, the shuvix-server helper and ShuviX itself (keeps your data)
  --dry-run         print what would be done without changing anything
  -h, --help        print this help

Who can connect is decided by ShuviX's security policy network-admission. By default only this
machine (127.0.0.1) can, reachable from elsewhere through an SSH tunnel. To let other devices in, open
ShuviX through the tunnel and follow Settings → General → Network access (a prompt sets up the policy
with an agent), or write ~/.shuvix/policies/network-admission.md. If you have no such policy yet,
--lan / --bind write one once, when ShuviX first starts with them.

The service runs ShuviX as the user who runs this script: a normal user with sudo rights, or root on a
machine of its own (an isolated VM) — as root ShuviX runs with --no-sandbox, so Chromium's process
sandbox is off. Network access has no password — once the policy lets a device in, whoever uses it can
fully control this computer through ShuviX.
EOF
}

REPO="${SHUVIX_INSTALL_REPO:-wangdongdongc/ShuviX}"
SERVICE_NAME="shuvix"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
DEB_BIN="/opt/ShuviX/shuvix"
DEB_HELPER="/usr/local/bin/shuvix-server"
MARKER="# Installed by the ShuviX install-linux.sh script"
READY_PREFIX="ShuviX headless: ready — open one of: "
READY_TIMEOUT_S=120

VERSION_TAG=""
SERVICE=0
LAN=0
BIND=""
BIND_GIVEN=0
PORT=7766
DEB_FILE=""
UNINSTALL=0
DRY_RUN=0
SUDO=""
# "sudo " in the commands this script suggests, nothing when it runs as root
SUDO_HINT="sudo "
WORK_DIR=""
SERVICE_WAS_ACTIVE=0

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
usage_error() {
  printf 'error: %s\n\n' "$*" >&2
  usage >&2
  exit 2
}

# Runs a command, or prints it (shell-quoted, after "+ ") in a dry run.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

# Runs a command as root (through sudo unless already root); no dry-run handling.
as_root() {
  if [ -n "$SUDO" ]; then
    sudo "$@"
  else
    "$@"
  fi
}

# Runs a command as root, or prints it in a dry run.
run_root() {
  if [ -n "$SUDO" ]; then
    run sudo "$@"
  else
    run "$@"
  fi
}

# Writes a file (as root when $3 is "root"), or prints it in a dry run.
# $1 path, $2 mode, $3 owner ("root" | "user"), $4 content
write_file() {
  local path="$1" mode="$2" owner="$3" content="$4"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "would write ${path} (mode ${mode}):"
    printf '%s\n' "$content" | sed 's/^/| /'
    return 0
  fi
  if [ "$owner" = "root" ]; then
    printf '%s\n' "$content" | as_root tee "$path" >/dev/null
    as_root chmod "$mode" "$path"
  else
    printf '%s\n' "$content" >"$path"
    chmod "$mode" "$path"
  fi
}

cleanup() {
  if [ "$DRY_RUN" -eq 0 ] && [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || usage_error "--version needs a tag"; VERSION_TAG="$2"; shift 2 ;;
      --version=*) VERSION_TAG="${1#*=}"; shift ;;
      --port) [ $# -ge 2 ] || usage_error "--port needs a number"; PORT="$2"; shift 2 ;;
      --port=*) PORT="${1#*=}"; shift ;;
      --deb) [ $# -ge 2 ] || usage_error "--deb needs a file"; DEB_FILE="$2"; shift 2 ;;
      --deb=*) DEB_FILE="${1#*=}"; shift ;;
      --service) SERVICE=1; shift ;;
      --lan) LAN=1; shift ;;
      --bind) [ $# -ge 2 ] || usage_error "--bind needs a network interface or an address"; BIND="$2"; BIND_GIVEN=1; shift 2 ;;
      --bind=*) BIND="${1#*=}"; BIND_GIVEN=1; shift ;;
      --uninstall) UNINSTALL=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage_error "unknown option: $1" ;;
    esac
  done
  case "$PORT" in
    '' | *[!0-9]*) usage_error "--port must be a whole number between 1024 and 65535 (got \"$PORT\")" ;;
  esac
  if [ "${#PORT}" -gt 5 ] || [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
    usage_error "--port must be a whole number between 1024 and 65535 (got \"$PORT\")"
  fi
  if [ -n "$DEB_FILE" ] && [ -n "$VERSION_TAG" ]; then
    usage_error "use either --deb or --version, not both"
  fi
  if [ "$BIND_GIVEN" -eq 1 ]; then
    # it goes into the service file and the helper's command line: interface names and IP literals only
    # (letters spelled out rather than a range, so the check does not depend on the locale; no "%" —
    # systemd reads it as a specifier; no leading "-" — it would read as an option)
    case "$BIND" in
      '' | -* | *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-]*)
        usage_error "--bind takes a network interface name or an address (got \"$BIND\")" ;;
    esac
    [ "${#BIND}" -le 64 ] || usage_error "--bind takes a network interface name or an address (got \"$BIND\")"
    LAN=1
  fi
}

detect_platform() {
  OS_NAME="${SHUVIX_INSTALL_UNAME_S:-$(uname -s)}"
  [ "$OS_NAME" = "Linux" ] || die "this installer is for Linux (this system is $OS_NAME)"

  MACHINE="${SHUVIX_INSTALL_UNAME_M:-$(uname -m)}"
  case "$MACHINE" in
    x86_64 | amd64) DEB_ARCH="amd64"; APPIMAGE_ARCH="x86_64" ;;
    aarch64 | arm64) DEB_ARCH="arm64"; APPIMAGE_ARCH="arm64" ;;
    *) die "unsupported architecture: $MACHINE (ShuviX ships builds for x86_64 and arm64)" ;;
  esac

  if [ -n "${SHUVIX_INSTALL_PKG:-}" ]; then
    PKG="$SHUVIX_INSTALL_PKG"
  elif command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
    PKG="deb"
  else
    PKG="appimage"
  fi
  case "$PKG" in
    deb | appimage) ;;
    *) die "SHUVIX_INSTALL_PKG must be deb or appimage (got \"$PKG\")" ;;
  esac
  if [ -n "$DEB_FILE" ] && [ "$PKG" != "deb" ]; then
    die "--deb needs apt-get and dpkg (Debian / Ubuntu)"
  fi

  USER_ID="${SHUVIX_INSTALL_UID:-$(id -u)}"
  USER_NAME="${SHUVIX_INSTALL_USER:-$(id -un)}"
  USER_HOME="${HOME:-}"
  [ -n "$USER_HOME" ] || die "HOME is not set"

  if [ "$PKG" = "deb" ]; then
    SHUVIX_BIN="$DEB_BIN"
    HELPER="$DEB_HELPER"
  else
    APP_ROOT="${USER_HOME}/.local/share/shuvix"
    BIN_DIR="${USER_HOME}/.local/bin"
    SHUVIX_BIN="${BIN_DIR}/shuvix"
    HELPER="${BIN_DIR}/shuvix-server"
  fi
}

# sudo for the root-owned steps (nothing when already root); asks for the password once, up front.
setup_sudo() {
  if [ "$USER_ID" = "0" ]; then
    SUDO=""
    SUDO_HINT=""
    return
  fi
  SUDO="sudo"
  if [ "$DRY_RUN" -eq 1 ]; then
    return
  fi
  command -v sudo >/dev/null 2>&1 || die "sudo is needed (run this script as a user with sudo rights)"
  # sudo reads the password from the terminal, not from stdin, so this works under `curl … | bash` too
  sudo -v || die "sudo did not succeed"
}

resolve_release() {
  if [ -n "$DEB_FILE" ]; then
    return
  fi
  if [ -n "$VERSION_TAG" ]; then
    case "$VERSION_TAG" in
      v*) TAG="$VERSION_TAG" ;;
      *) TAG="v$VERSION_TAG" ;;
    esac
  elif [ "$DRY_RUN" -eq 1 ]; then
    say "would look up the latest release at https://github.com/${REPO}/releases/latest"
    TAG="LATEST"
  else
    command -v curl >/dev/null 2>&1 || die "curl is needed to download ShuviX"
    local effective
    effective="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest")" ||
      die "could not look up the latest release (pass --version <tag>)"
    TAG="${effective##*/}"
    case "$TAG" in
      v[0-9]*) ;;
      *) die "could not read the latest release from ${effective} (pass --version <tag>)" ;;
    esac
  fi
  VERSION="${TAG#v}"
  if [ "$TAG" = "LATEST" ]; then VERSION="LATEST"; fi
  if [ "$PKG" = "deb" ]; then
    ASSET="shuvix-${VERSION}-${DEB_ARCH}.deb"
  else
    ASSET="shuvix-${VERSION}-${APPIMAGE_ARCH}.AppImage"
  fi
  ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
  say "ShuviX ${TAG} (${ASSET})"
}

download() {
  local url="$1" dest="$2"
  if [ "$DRY_RUN" -eq 0 ]; then
    command -v curl >/dev/null 2>&1 || die "curl is needed to download ShuviX"
  fi
  run curl -fL --retry 3 --retry-delay 2 -o "$dest" "$url" ||
    die "could not download ${url} (does release ${TAG} have this file?)"
}

install_deb() {
  local deb
  if [ -n "$DEB_FILE" ]; then
    [ -f "$DEB_FILE" ] || die "no such file: $DEB_FILE"
    deb="$(cd "$(dirname "$DEB_FILE")" && pwd)/$(basename "$DEB_FILE")"
    say "ShuviX from ${deb}"
  else
    if [ "$DRY_RUN" -eq 1 ]; then
      WORK_DIR="/tmp/shuvix-install.XXXXXX"
    else
      WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shuvix-install.XXXXXX")"
      # apt reads the file as its own unprivileged user
      chmod 755 "$WORK_DIR"
    fi
    deb="${WORK_DIR}/${ASSET}"
    download "$ASSET_URL" "$deb"
  fi
  if [ "$DRY_RUN" -eq 0 ] && command -v dpkg-query >/dev/null 2>&1; then
    local installed
    installed="$(dpkg-query -W -f='${Version}' shuvix 2>/dev/null || true)"
    if [ -n "$installed" ]; then say "upgrading from ShuviX ${installed}"; fi
  fi
  run_root env DEBIAN_FRONTEND=noninteractive apt-get update -q </dev/null ||
    warn "apt-get update failed; trying the install anyway"
  # --allow-downgrades: --version may name an older release than the one installed
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$deb" </dev/null ||
    die "apt-get could not install ${deb}"
  if [ "$DRY_RUN" -eq 0 ] && [ ! -x "$SHUVIX_BIN" ]; then
    die "the package installed, but ${SHUVIX_BIN} is missing"
  fi
}

install_appimage() {
  run mkdir -p "$APP_ROOT" "$BIN_DIR"
  if [ "$DRY_RUN" -eq 1 ]; then
    WORK_DIR="${APP_ROOT}/.install.XXXXXX"
  else
    # next to the destination: the same filesystem (a cheap move) and not a noexec /tmp
    WORK_DIR="$(mktemp -d "${APP_ROOT}/.install.XXXXXX")"
  fi
  local image="${WORK_DIR}/${ASSET}"
  download "$ASSET_URL" "$image"
  run chmod +x "$image"
  # --appimage-extract needs no FUSE; it unpacks into ./squashfs-root
  if [ "$DRY_RUN" -eq 1 ]; then
    say "+ (cd ${WORK_DIR} && ./${ASSET} --appimage-extract)"
  else
    (cd "$WORK_DIR" && "./${ASSET}" --appimage-extract >/dev/null) ||
      die "could not extract ${ASSET}"
  fi
  run rm -rf "${APP_ROOT}/app.new"
  run mv "${WORK_DIR}/squashfs-root" "${APP_ROOT}/app.new"
  run rm -rf "${APP_ROOT}/app"
  run mv "${APP_ROOT}/app.new" "${APP_ROOT}/app"

  local target="${APP_ROOT}/app/shuvix"
  if [ "$DRY_RUN" -eq 0 ] && [ ! -x "$target" ]; then
    target="${APP_ROOT}/app/AppRun"
    [ -x "$target" ] || die "the extracted AppImage has neither shuvix nor AppRun"
  fi
  write_file "$SHUVIX_BIN" 0755 user "#!/bin/sh
${MARKER}
# The extracted AppImage has no setuid sandbox helper, so Chromium's sandbox is off (--no-sandbox).
exec \"${target}\" --no-sandbox \"\$@\""
  say "note: ShuviX from the AppImage runs with --no-sandbox (the extracted app has no setuid sandbox helper)"

  if [ "$DRY_RUN" -eq 0 ] && command -v ldd >/dev/null 2>&1; then
    local missing
    missing="$(ldd "${APP_ROOT}/app/shuvix" 2>/dev/null | awk '/not found/ {print $1}' | tr '\n' ' ' || true)"
    if [ -n "$missing" ]; then
      warn "these libraries are missing (install them with your package manager): ${missing}"
    fi
  fi
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *) warn "${BIN_DIR} is not on your PATH; add it to use the shuvix and shuvix-server commands" ;;
  esac
}

# The ShuviX flags for a headless run (the service and the helper): --bind / --lan only when asked for.
# Both are deprecated in ShuviX too: it still accepts them and turns them into a network-admission policy.
headless_flags() {
  if [ -n "$BIND" ]; then
    printf '%s' "--headless --bind ${BIND}"
  elif [ "$LAN" -eq 1 ]; then
    printf '%s' "--headless --lan"
  else
    printf '%s' "--headless"
  fi
}

install_helper() {
  if [ "$PKG" = "deb" ]; then
    # the deb's helper is shared by every user of the machine: whoever runs it as root needs --no-sandbox
    write_file "$HELPER" 0755 root "#!/bin/sh
${MARKER}
# Runs ShuviX headless in the foreground (stop it with Ctrl+C). Options: --port <n>.
# Electron does not start as root unless Chromium's sandbox is off.
if [ \"\$(id -u)\" = 0 ]; then set -- --no-sandbox \"\$@\"; fi
exec \"${SHUVIX_BIN}\" $(headless_flags) --ozone-platform=headless --disable-gpu \"\$@\""
  else
    # the AppImage launcher already passes --no-sandbox
    write_file "$HELPER" 0755 user "#!/bin/sh
${MARKER}
# Runs ShuviX headless in the foreground (stop it with Ctrl+C). Options: --port <n>.
exec \"${SHUVIX_BIN}\" $(headless_flags) --ozone-platform=headless --disable-gpu \"\$@\""
  fi
}

# --no-sandbox for a service that runs as root from the deb (the AppImage launcher already passes it).
root_flags() {
  if [ "$USER_ID" = "0" ] && [ "$PKG" = "deb" ]; then
    printf '%s' " --no-sandbox"
  fi
}

install_service() {
  write_file "$SERVICE_FILE" 0644 root "${MARKER}
[Unit]
Description=ShuviX (headless)
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=~
Environment=SHUVIX_HEADLESS=1
ExecStart=${SHUVIX_BIN} $(headless_flags) --port ${PORT} --ozone-platform=headless --disable-gpu$(root_flags)
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target"
  run_root systemctl daemon-reload
  run_root systemctl enable "${SERVICE_NAME}.service"
  # restart rather than start: a rerun (upgrade) must pick up the new version
  run_root systemctl restart "${SERVICE_NAME}.service"
}

# Waits for the service's ready line in the journal and prints the addresses.
wait_for_service() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "would wait up to ${READY_TIMEOUT_S}s for \"${READY_PREFIX%% — *}\" in journalctl -u ${SERVICE_NAME}"
    return 0
  fi
  local invocation logs line waited=0
  invocation="$(as_root systemctl show -p InvocationID --value "${SERVICE_NAME}.service" 2>/dev/null || true)"
  while [ "$waited" -lt "$READY_TIMEOUT_S" ]; do
    if [ -n "$invocation" ]; then
      logs="$(as_root journalctl --no-pager -o cat "_SYSTEMD_INVOCATION_ID=${invocation}" 2>/dev/null || true)"
    else
      logs="$(as_root journalctl --no-pager -o cat -u "${SERVICE_NAME}" -n 200 2>/dev/null || true)"
    fi
    line="$(printf '%s\n' "$logs" | grep -F "$READY_PREFIX" | tail -n 1 || true)"
    if [ -n "$line" ]; then
      READY_URLS="${line#*"$READY_PREFIX"}"
      return 0
    fi
    case "$logs" in
      *"ShuviX headless: cannot listen"* | *"ShuviX desktop app is already running"*)
        break
        ;;
    esac
    sleep 2
    waited=$((waited + 2))
  done
  warn "ShuviX did not report ready; the service log ends with:"
  as_root journalctl --no-pager -u "${SERVICE_NAME}" -n 30 >&2 || true
  die "the ${SERVICE_NAME} service did not start (see: ${SUDO_HINT}journalctl -u ${SERVICE_NAME})"
}

# The deprecated --lan / --bind: what ShuviX does with them now (printed before anything is installed).
deprecation_note() {
  local option="--lan"
  if [ -n "$BIND" ]; then option="--bind ${BIND}"; fi
  say "note: ${option} is deprecated — who can connect is now the security policy network-admission; on its first start ShuviX writes ~/.shuvix/policies/network-admission.md from ${option}, if you have no such policy yet"
}

# How to reach ShuviX: the policy written from --bind / --lan, or (by default) through an SSH tunnel.
access_hint() {
  if [ -n "$BIND" ]; then
    firewall_hint
    say "On its first start ShuviX writes the network-admission policy from --bind ${BIND}: only this machine and the network of ${BIND} can connect (if you have such a policy already, yours decides)."
    say "Network access has no password: anyone on that network who opens the address can fully control this computer through ShuviX."
  elif [ "$LAN" -eq 1 ]; then
    firewall_hint
    say "On its first start ShuviX writes the network-admission policy from --lan: every device on the local network can connect (if you have such a policy already, yours decides)."
    say "Network access has no password: anyone on the same network who opens the address can fully control this computer through ShuviX."
  else
    say "ShuviX only accepts connections from this machine (127.0.0.1). From another computer, open an SSH tunnel:"
    say "  ssh -L ${PORT}:127.0.0.1:${PORT} ${USER_NAME}@<this machine's address>"
    say "and open http://127.0.0.1:${PORT}/ there. To let other devices in, follow Settings → General → Network access"
    say "in that browser (a prompt sets up the policy network-admission with an agent), or write ~/.shuvix/policies/network-admission.md."
    say "Network access has no password: anyone who can reach port ${PORT} on this machine (other users on it, or through a tunnel) can fully control it through ShuviX."
  fi
}

firewall_hint() {
  if [ "$DRY_RUN" -eq 1 ] || ! command -v ufw >/dev/null 2>&1; then
    return 0
  fi
  local status
  status="$(as_root ufw status 2>/dev/null || true)"
  case "$status" in
    *"Status: active"*) say "ufw is active; to reach ShuviX from other devices: ${SUDO_HINT}ufw allow ${PORT}/tcp" ;;
  esac
}

# An upgrade must not replace files under a running ShuviX: stop the service first (started again below).
stop_running_service() {
  if [ "$DRY_RUN" -eq 1 ] || ! command -v systemctl >/dev/null 2>&1 || [ ! -f "$SERVICE_FILE" ]; then
    return 0
  fi
  if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    SERVICE_WAS_ACTIVE=1
    say "stopping the running ${SERVICE_NAME} service for the upgrade"
    run_root systemctl stop "${SERVICE_NAME}.service"
  fi
}

do_install() {
  if [ "$SERVICE" -eq 1 ] && [ "$DRY_RUN" -eq 0 ] && ! command -v systemctl >/dev/null 2>&1; then
    die "--service needs systemd (systemctl was not found); use shuvix-server instead"
  fi
  if [ "$LAN" -eq 1 ]; then deprecation_note; fi
  setup_sudo
  resolve_release
  stop_running_service
  if [ "$PKG" = "deb" ]; then
    install_deb
  else
    install_appimage
  fi
  install_helper
  if [ "$DRY_RUN" -eq 1 ]; then
    say "would install: ${SHUVIX_BIN} and ${HELPER}"
  else
    say "installed: ${SHUVIX_BIN} and ${HELPER}"
  fi
  if [ "$USER_ID" = "0" ] && [ "$PKG" = "deb" ]; then
    say "note: as root, ShuviX runs with --no-sandbox (Electron does not start as root otherwise), so Chromium's process sandbox is off; on a machine other people use, install as a normal user with sudo rights instead"
  fi

  if [ "$SERVICE" -eq 1 ]; then
    install_service
    wait_for_service
    say ""
    if [ "$DRY_RUN" -eq 1 ]; then
      say "would run ShuviX headless as the systemd service \"${SERVICE_NAME}\" (user ${USER_NAME}, port ${PORT})."
    else
      say "ShuviX is running headless as the systemd service \"${SERVICE_NAME}\" (user ${USER_NAME}, port ${PORT})."
      say "Open one of: ${READY_URLS}"
    fi
    say "Manage it with: ${SUDO_HINT}systemctl status|restart|stop ${SERVICE_NAME} · logs: journalctl -u ${SERVICE_NAME} -f"
    access_hint
  elif [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then
    run_root systemctl start "${SERVICE_NAME}.service"
    wait_for_service
    say ""
    say "The ${SERVICE_NAME} service runs the new version. Open one of: ${READY_URLS}"
  else
    say ""
    say "Run ShuviX headless in the foreground with: shuvix-server [--port <n>]"
    say "or install it as a service: rerun this script with --service"
    access_hint
  fi
}

# A file we wrote (it carries our marker line), or anything in a dry run.
ours() {
  [ "$DRY_RUN" -eq 1 ] || { [ -f "$1" ] && grep -qF "$MARKER" "$1"; }
}

do_uninstall() {
  setup_sudo
  if [ "$DRY_RUN" -eq 1 ] || [ -f "$SERVICE_FILE" ]; then
    run_root systemctl disable --now "${SERVICE_NAME}.service" || true
    run_root rm -f "$SERVICE_FILE"
    run_root systemctl daemon-reload
  fi
  if ours "$DEB_HELPER"; then run_root rm -f "$DEB_HELPER"; fi
  local user_bin="${USER_HOME}/.local/bin"
  if ours "${user_bin}/shuvix-server"; then run rm -f "${user_bin}/shuvix-server"; fi
  if ours "${user_bin}/shuvix"; then run rm -f "${user_bin}/shuvix"; fi
  if [ "$DRY_RUN" -eq 1 ] || [ -d "${USER_HOME}/.local/share/shuvix" ]; then
    run rm -rf "${USER_HOME}/.local/share/shuvix"
  fi
  # purge, not remove: a removed package stays known to dpkg ("config-files") — also cleans up after an older remove
  local pkg_status=""
  if [ "$DRY_RUN" -eq 0 ] && command -v dpkg-query >/dev/null 2>&1; then
    pkg_status="$(dpkg-query -W -f='${Status}' shuvix 2>/dev/null || true)"
  fi
  case "$pkg_status" in
    *" installed" | *" config-files") pkg_status="present" ;;
  esac
  if [ "$DRY_RUN" -eq 1 ] || [ "$pkg_status" = "present" ]; then
    run_root env DEBIAN_FRONTEND=noninteractive apt-get purge -y shuvix </dev/null
  fi
  say "ShuviX is removed. Your data is kept: ~/.config/shuvix and ~/.shuvix (delete them yourself to remove it too)."
}

main() {
  parse_args "$@"
  detect_platform
  trap cleanup EXIT
  if [ "$DRY_RUN" -eq 1 ]; then
    say "dry run: nothing is changed (${PKG}, ${MACHINE}, user ${USER_NAME})"
  fi
  if [ "$UNINSTALL" -eq 1 ]; then
    do_uninstall
  else
    do_install
  fi
}

# Everything runs from main, so `curl … | bash` has read the whole script before any command can read stdin.
main "$@"
