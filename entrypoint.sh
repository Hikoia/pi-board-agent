#!/usr/bin/env bash
# pi-board-agent container entrypoint.
#
#  1. Authenticate gh with the runtime token (GH_TOKEN env).
#  2. Make git use gh's credentials (so the loop/builders can push branches).
#  3. Run pi headless (--print): the extension's auto_start starts the loop,
#     whose setInterval keeps the process alive indefinitely.
set -euo pipefail

if [ -n "${GH_TOKEN:-}" ]; then
  echo "${GH_TOKEN}" | gh auth login --with-token || true
  gh auth setup-git || true
  echo "gh authenticated: $(gh api user --jq .login 2>/dev/null || echo '?')"
fi

if [ ! -d .git ]; then
  echo "WARN: /workspace has no .git — the board-agent targets the repo mounted at /workspace."
fi

echo "Starting pi headless (board-agent auto_start=${BOARD_AUTO_START:-config})..."
exec pi --print "board-agent: session started."
