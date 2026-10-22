#!/usr/bin/env bash
# Installs the pinned oasdiff (breaking-change checker) into contracts/.tools/, verifying its SHA-256.
# Version and hashes are pinned per TOOLCHAIN.md: oasdiff v1.33.0, released 2026-10-01 (meets the 7-day rule).
# The npm package called "oasdiff" is NOT this tool (it is a security placeholder); never install it.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=1.33.0
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  ASSET="oasdiff_${VERSION}_linux_amd64.tar.gz"; SHA=43a4e328e2d13ba1552d760aa68d2485c75c5621f309f6ff64ae895188345247 ;;
  Linux-aarch64|Linux-arm64) ASSET="oasdiff_${VERSION}_linux_arm64.tar.gz"; SHA=4ae3c362d6074d919aada2dea82d0ee84366591600384455d0bdc658ddf8f7ae ;;
  Darwin-*)      ASSET="oasdiff_${VERSION}_darwin_all.tar.gz"; SHA=2a479337c15afdcbf0b1e89c0b4d0cf0176472dbc11483358fed1f831d1e46c5 ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

DEST=".tools/oasdiff-${VERSION}"
if [ -x "$DEST/oasdiff" ]; then echo "oasdiff ${VERSION} already installed"; exit 0; fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "$WORK/$ASSET" "https://github.com/oasdiff/oasdiff/releases/download/v${VERSION}/${ASSET}"
echo "${SHA}  $WORK/$ASSET" | sha256sum -c - >/dev/null || { echo "Checksum mismatch for $ASSET" >&2; exit 1; }
mkdir -p "$DEST"
tar -xzf "$WORK/$ASSET" -C "$DEST" oasdiff
chmod 0755 "$DEST/oasdiff"
echo "Installed oasdiff ${VERSION} to contracts/$DEST"
