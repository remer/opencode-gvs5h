#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$config_root/plugins/gvs5h"
cp "$repo_dir/plugin/gvs5h.js" "$config_root/plugins/gvs5h.js"
cp "$repo_dir/plugin/gvs5h/engine.mjs" "$config_root/plugins/gvs5h/engine.mjs"
printf 'Installed OpenCode GVS5H plugin into %s/plugins. Restart OpenCode.\n' "$config_root"
