#!/bin/sh
# Vedecaps installer for Linux and macOS.
#   curl -fsSL https://raw.githubusercontent.com/nxodh/vedecaps/main/install.sh | sh
#
# Environment:
#   VEDECAPS_VERSION         version to install (default: latest release), e.g. 0.1.0
#   VEDECAPS_INSTALL_DIR     where the binary goes (default: ~/.vedecaps/bin)
#   VEDECAPS_NO_MODIFY_PATH  set to 1 to leave shell profiles untouched
set -eu

REPO="nxodh/vedecaps"
BASE="${VEDECAPS_RELEASE_URL:-https://github.com/$REPO/releases}"
INSTALL_DIR="${VEDECAPS_INSTALL_DIR:-$HOME/.vedecaps/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Everything below runs inside a function so a truncated download cannot execute half a script.
main() {
  os=$(uname -s)
  case "$os" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN*) fail "on Windows, run this in PowerShell instead: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
    *) fail "unsupported operating system: $os" ;;
  esac

  arch=$(uname -m)
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "unsupported CPU architecture: $arch" ;;
  esac

  libc=""
  if [ "$os" = linux ] && { [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); }; then libc="-musl"; fi

  have tar || fail "tar is required"
  if have curl; then
    fetch() { curl -fsSL "$1" -o "$2"; }
    redirect() { curl -fsSI -o /dev/null -w '%{redirect_url}' "$1"; }
  elif have wget; then
    fetch() { wget -q "$1" -O "$2"; }
    redirect() { wget -q --max-redirect=0 -S -O /dev/null "$1" 2>&1 | sed -n 's/^ *[Ll]ocation: *//p' | tr -d '\r' | tail -n 1; }
  else
    fail "curl or wget is required"
  fi

  version="${VEDECAPS_VERSION:-}"
  if [ -z "$version" ]; then
    location=$(redirect "$BASE/latest" || true)
    version=$(printf '%s' "$location" | sed -n 's|.*/tag/v\{0,1\}\([^/?#]*\).*|\1|p')
    [ -n "$version" ] || fail "could not determine the latest version. Set VEDECAPS_VERSION, or see https://github.com/$REPO/releases"
  fi
  version=${version#v}

  asset="vedecaps-$os-$arch$libc.tar.gz"
  url="$BASE/download/v$version"
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t vedecaps)
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Downloading vedecaps $version ($os-$arch$libc)"
  fetch "$url/$asset" "$tmp/$asset" || fail "download failed: $url/$asset"
  fetch "$url/checksums.txt" "$tmp/checksums.txt" || fail "download failed: $url/checksums.txt"

  expected=$(awk -v f="$asset" '{ n = $2; sub(/^\*/, "", n); if (n == f) print $1 }' "$tmp/checksums.txt")
  [ -n "$expected" ] || fail "checksums.txt has no entry for $asset"
  if have sha256sum; then
    actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
  elif have shasum; then
    actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
  elif have openssl; then
    actual=$(openssl dgst -sha256 "$tmp/$asset" | awk '{print $NF}')
  else
    fail "cannot verify the download: none of sha256sum, shasum or openssl is available"
  fi
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $asset (expected $expected, got $actual). Nothing was installed."

  tar -xzf "$tmp/$asset" -C "$tmp"
  [ -f "$tmp/vedecaps" ] || fail "the archive did not contain the vedecaps binary"
  chmod 755 "$tmp/vedecaps"
  if ! "$tmp/vedecaps" --version >/dev/null 2>&1; then
    if [ -n "$libc" ]; then fail "musl requires libstdc++ and libgcc (Alpine: apk add --no-cache libstdc++ libgcc), then retry"; fi
    fail "the downloaded binary does not run on this system"
  fi

  mkdir -p "$INSTALL_DIR"
  # Move into place under a temporary name first so a running vedecaps is replaced atomically.
  cp "$tmp/vedecaps" "$INSTALL_DIR/.vedecaps.new"
  mv -f "$INSTALL_DIR/.vedecaps.new" "$INSTALL_DIR/vedecaps"
  say "Installed $INSTALL_DIR/vedecaps"

  add_to_path
  say ""
  say "Run 'vedecaps' in a project directory to start."
  say "First time? Connect a model provider with 'vedecaps auth login'."
}

add_to_path() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) return 0 ;;
  esac
  if [ "${VEDECAPS_NO_MODIFY_PATH:-0}" = 1 ]; then
    say "Add $INSTALL_DIR to your PATH to use it."
    return 0
  fi
  shell_name=$(basename "${SHELL:-sh}")
  line="export PATH=\"$INSTALL_DIR:\$PATH\""
  case "$shell_name" in
    zsh) profiles="$HOME/.zshrc" ;;
    bash)
      profiles="$HOME/.bashrc"
      # login shells on macOS read .bash_profile, not .bashrc
      if [ -f "$HOME/.bash_profile" ] || [ "$(uname -s)" = Darwin ]; then profiles="$profiles $HOME/.bash_profile"; fi
      ;;
    fish)
      profiles="$HOME/.config/fish/config.fish"
      line="fish_add_path \"$INSTALL_DIR\""
      ;;
    *) profiles="$HOME/.profile" ;;
  esac
  for profile in $profiles; do
    if [ -f "$profile" ] && grep -Fq "$INSTALL_DIR" "$profile"; then continue; fi
    mkdir -p "$(dirname "$profile")"
    printf '\n# vedecaps\n%s\n' "$line" >>"$profile"
    say "Added $INSTALL_DIR to PATH in $profile"
  done
  say "Open a new terminal, or run:  export PATH=\"$INSTALL_DIR:\$PATH\""
}

main "$@"
