#!/usr/bin/env bash
set -euo pipefail

FEDORA_PACKAGES=(gtk3-devel glib2-devel webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel pkgconf-pkg-config)
DEBIAN_PACKAGES=(libgtk-3-dev libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev pkg-config)
ARCH_PACKAGES=(gtk3 webkit2gtk-4.1 openssl libappindicator-gtk3 librsvg xdotool pkgconf)
REQUIRED_MODULES=(gdk-3.0 gobject-2.0 webkit2gtk-4.1)

usage() {
  echo "Usage: $0 [--check|--print|--install]"
  echo "  --check    Verify required pkg-config modules (default)"
  echo "  --print    Print the install command for this distribution"
  echo "  --install  Install dependencies interactively with sudo"
}

detect_family() {
  [[ -r /etc/os-release ]] || { echo "Cannot detect Linux distribution." >&2; exit 2; }
  # shellcheck disable=SC1091
  source /etc/os-release
  case "${ID:-} ${ID_LIKE:-}" in
    *fedora*|*rhel*) echo fedora ;;
    *debian*|*ubuntu*) echo debian ;;
    *arch*) echo arch ;;
    *) echo "Unsupported distribution: ${PRETTY_NAME:-${ID:-unknown}}" >&2; exit 2 ;;
  esac
}

install_command() {
  case "$1" in
    fedora) printf 'sudo dnf install -y'; printf ' %q' "${FEDORA_PACKAGES[@]}" ;;
    debian) printf 'sudo apt-get update && sudo apt-get install -y'; printf ' %q' "${DEBIAN_PACKAGES[@]}" ;;
    arch) printf 'sudo pacman -S --needed'; printf ' %q' "${ARCH_PACKAGES[@]}" ;;
  esac
  printf '\n'
}

check_dependencies() {
  command -v pkg-config >/dev/null 2>&1 || {
    echo "Missing pkg-config. Run: $(install_command "$(detect_family)")" >&2
    return 1
  }
  local missing=()
  local module
  for module in "${REQUIRED_MODULES[@]}"; do
    pkg-config --exists "$module" || missing+=("$module")
  done
  if ((${#missing[@]})); then
    echo "Missing Tauri Linux development modules: ${missing[*]}" >&2
    echo "Install them with:" >&2
    install_command "$(detect_family)" >&2
    return 1
  fi
  echo "Tauri Linux development dependencies are installed."
}

mode="${1:---check}"
case "$mode" in
  --check) check_dependencies ;;
  --print) install_command "$(detect_family)" ;;
  --install)
    command="$(install_command "$(detect_family)")"
    echo "+ $command"
    eval "$command"
    check_dependencies
    ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
