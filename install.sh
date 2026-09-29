#!/usr/bin/env bash
# Install the `codexctl` launcher into ~/.local/bin (a symlink to bin/codexctl in this repo).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.local/bin"
ln -sf "$here/bin/codexctl" "$HOME/.local/bin/codexctl"
echo "installed: $HOME/.local/bin/codexctl -> $here/bin/codexctl"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "note: add $HOME/.local/bin to your PATH" ;; esac
