#!/bin/sh
# Downloads the ambit binary for this machine from GitHub Releases and puts it on disk.
#
# Two things worth knowing:
#
#   - Windows is served only through a POSIX shell, which on that platform means Git Bash, MSYS or
#     Cygwin. A machine without one of those runs `npx @nebulab/ambit` instead, since the npm package
#     is Node and runs wherever Node does.
#   - The checksum is verified, and a machine with neither `sha256sum` nor `shasum` fails rather
#     than skipping the check. This script is run through a pipe from the network; the one thing it
#     must not do is install bytes it did not check.
#
# Environment:
#   AMBIT_VERSION      a tag like `v0.2.0`; default is the latest release
#   AMBIT_INSTALL_DIR  where to put the binary; default is `$HOME/.local/bin`
set -eu

REPO="nebulab/ambit"
VERSION="${AMBIT_VERSION:-latest}"
INSTALL_DIR="${AMBIT_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "ambit: $1" >&2
  exit 1
}

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
Darwin) os="darwin" ;;
Linux) os="linux" ;;
MINGW* | MSYS* | CYGWIN* | Windows_NT) os="windows" ;;
*) fail "no binary for $os. Use \`npx @nebulab/ambit\` instead." ;;
esac

case "$arch" in
arm64 | aarch64) arch="arm64" ;;
x86_64 | amd64) arch="x64" ;;
*) fail "no binary for $arch. Use \`npx @nebulab/ambit\` instead." ;;
esac

# Only the two Unixes ship both architectures. A Windows machine on ARM runs the x64 binary under
# emulation, which is also what `uname -m` reports there.
if [ "$os" = "windows" ] && [ "$arch" != "x64" ]; then
  fail "no binary for Windows on $arch. Use \`npx @nebulab/ambit\` instead."
fi

if [ "$os" = "windows" ]; then
  suffix=".exe"
else
  suffix=""
fi

asset="ambit-$os-$arch$suffix"

if [ "$VERSION" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

command -v curl >/dev/null 2>&1 || fail "curl is required."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "ambit: downloading $asset ($VERSION)"
curl -fsSL "$base/$asset" -o "$tmp/$asset" ||
  fail "could not download $base/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" ||
  fail "could not download $base/checksums.txt"

if command -v sha256sum >/dev/null 2>&1; then
  sum="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  sum="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
else
  fail "neither sha256sum nor shasum is available, so the download cannot be verified."
fi

expected="$(grep " $asset\$" "$tmp/checksums.txt" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "$asset is not listed in checksums.txt."
[ "$sum" = "$expected" ] || fail "checksum mismatch for $asset. Expected $expected, got $sum."

mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/ambit$suffix"

echo "ambit: installed to $INSTALL_DIR/ambit$suffix"

case ":$PATH:" in
*":$INSTALL_DIR:"*) ;;
*) echo "ambit: $INSTALL_DIR is not on your PATH. Add it, or move the binary somewhere that is." ;;
esac

"$INSTALL_DIR/ambit$suffix" --version
