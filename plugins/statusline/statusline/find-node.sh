#!/bin/sh
# Locates node binary across nvm/fnm/Homebrew/system installs and execs with passed args.
NODE_BIN=""
if command -v node >/dev/null 2>&1; then NODE_BIN="node"; fi
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  for _p in "$HOME/.nvm/versions/node/"*/bin/node; do [ -x "$_p" ] && NODE_BIN="$_p"; done
fi
if [ -z "$NODE_BIN" ]; then
  for _b in "$HOME/.fnm/node-versions" "$HOME/Library/Application Support/fnm/node-versions" "$HOME/.local/share/fnm/node-versions"; do
    [ -d "$_b" ] || continue
    for _p in "$_b/"*/installation/bin/node; do [ -x "$_p" ] && NODE_BIN="$_p"; done
    [ -n "$NODE_BIN" ] && break
  done
fi
if [ -z "$NODE_BIN" ]; then
  for _p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$_p" ] && NODE_BIN="$_p" && break
  done
fi
if [ -z "$NODE_BIN" ]; then exit 0; fi
exec "$NODE_BIN" "$@"
