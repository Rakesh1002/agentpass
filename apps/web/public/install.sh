#!/bin/sh
# AgentPass installer: curl -fsSL https://agentpass.sh/install | sh
set -eu

REPO=Rakesh1002/agentpass
API_URL=${AGENTPASS_API_URL:-https://api.github.com/repos/$REPO}
DOWNLOAD_URL=${AGENTPASS_DOWNLOAD_URL:-https://github.com/$REPO/releases/download}
INSTALL_DIR=${AGENTPASS_INSTALL_DIR:-$HOME/.agentpass/bin}

fail() {
  echo "agentpass install: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is required"
fi

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN* | Windows*) fail "Windows is not supported yet; AgentPass runs on macOS and Linux" ;;
  *) fail "unsupported OS: $(uname -s); AgentPass runs on macOS and Linux" ;;
esac
case $(uname -m) in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported architecture: $(uname -m); AgentPass supports arm64 and x64" ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/agentpass.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' INT TERM

if [ -n "${AGENTPASS_VERSION:-}" ]; then
  case $AGENTPASS_VERSION in
    v*) tag=$AGENTPASS_VERSION ;;
    *) tag=v$AGENTPASS_VERSION ;;
  esac
else
  # /releases/latest skips prereleases, so take the newest of all releases
  curl -fsSL "$API_URL/releases?per_page=1" -o "$tmp/releases.json" || fail "could not list releases from $API_URL"
  tag=$(sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' "$tmp/releases.json" | head -n 1)
  if [ -z "$tag" ]; then
    echo "No AgentPass release has been published yet. Watch https://github.com/$REPO/releases" >&2
    exit 1
  fi
fi

asset=agentpass-$os-$arch
echo "Downloading AgentPass $tag ($os-$arch)..."
curl -fsSL "$DOWNLOAD_URL/$tag/$asset" -o "$tmp/$asset" || fail "could not download $asset for $tag"
curl -fsSL "$DOWNLOAD_URL/$tag/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download SHA256SUMS for $tag"

expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS for $tag has no entry for $asset"
if [ "$(sha256 "$tmp/$asset")" != "$expected" ]; then
  rm -f "$tmp/$asset"
  fail "checksum mismatch for $asset; nothing was installed"
fi

mkdir -p "$INSTALL_DIR"
chmod 755 "$tmp/$asset"
mv -f "$tmp/$asset" "$INSTALL_DIR/agentpass"

echo "Installed AgentPass $("$INSTALL_DIR/agentpass" version) to $INSTALL_DIR/agentpass"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "$INSTALL_DIR is not on your PATH. Add this line to your shell profile:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
echo
echo "Next steps:"
echo "  agentpass init"
echo "  eval \"\$(agentpass hook zsh)\""
echo "  agentpass up"
