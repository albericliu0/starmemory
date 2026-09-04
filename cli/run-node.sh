#!/bin/sh
# Locate a node binary without assuming it is on PATH, then exec it with our
# script. Claude Code spawns MCP servers and hooks with a minimal PATH that
# excludes Homebrew, nvm and fnm, so a bare `command: "node"` fails with
# `ENOENT: node` on most real installs. This shim is the command instead:
# `sh` itself lives in /bin and is always on the default PATH, and from here we
# find node ourselves. First match wins.
find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for n in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME/.local/bin/node"; do
    [ -x "$n" ] && { printf '%s\n' "$n"; return 0; }
  done
  # Version managers keep node under a per-version directory; take the newest.
  for base in \
    "$HOME/.nvm/versions/node" \
    "$HOME/Library/Application Support/fnm/node-versions" \
    "$HOME/.fnm/node-versions" \
    "$HOME/n/versions/node" \
    "$HOME/.asdf/installs/nodejs"; do
    [ -d "$base" ] || continue
    for v in $(ls -1 "$base" 2>/dev/null | sort -rV); do
      for cand in "$base/$v/bin/node" "$base/$v/installation/bin/node"; do
        [ -x "$cand" ] && { printf '%s\n' "$cand"; return 0; }
      done
    done
  done
  return 1
}

NODE=$(find_node) || {
  echo "starmemory: could not find a node executable (looked on PATH, Homebrew, nvm, fnm, n, asdf)" >&2
  exit 127
}
exec "$NODE" "$@"
