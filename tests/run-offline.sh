#!/usr/bin/env bash
# Plain PASS/FAIL checks. Each file gets its own disposable home and state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/pi-board-agent-offline.XXXXXXXX")"
trap 'rm -rf -- "$SUITE_TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
PASS=0
FAIL=0

# Native Node on Git Bash does not interpret /tmp or /d/... in custom env vars.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

run_check() {
  local file="$1" tmp home out line status=0 checks=0
  tmp="$(mktemp -d "$SUITE_TMP/case.XXXXXXXX")"
  mkdir -p "$tmp/home" "$tmp/tmp" "$tmp/agent/sessions" "$tmp/gh" "$tmp/xdg" "$tmp/appdata" "$tmp/npm-cache"
  tmp="$(native_path "$tmp")"
  home="$tmp/home"
  local -a loader=()
  [[ "$file" != *.ts ]] || loader=(--import tsx)
  echo "--- ${file##*/} ---"
  # An allowlist, not a token-name denylist: never inherit credentials, live Pi
  # session paths, NODE_OPTIONS preload hooks, or the user's git/npm/gh config.
  out="$(cd "$ROOT" && env -i \
    PATH="$PATH" SystemRoot="${SystemRoot:-${SYSTEMROOT:-}}" \
    WINDIR="${WINDIR:-}" COMSPEC="${COMSPEC:-}" PATHEXT="${PATHEXT:-}" \
    HOME="$home" USERPROFILE="$home" APPDATA="$tmp/appdata" LOCALAPPDATA="$tmp/appdata" \
    TMP_DIR="$tmp" TMPDIR="$tmp/tmp" TMP="$tmp/tmp" TEMP="$tmp/tmp" \
    XDG_CONFIG_HOME="$tmp/xdg" XDG_CACHE_HOME="$tmp/xdg" XDG_DATA_HOME="$tmp/xdg" \
    PI_CODING_AGENT_DIR="$tmp/agent" PI_CODING_AGENT_SESSION_DIR="$tmp/agent/sessions" \
    PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
    GH_CONFIG_DIR="$tmp/gh" GH_PROMPT_DISABLED=1 \
    GIT_CONFIG_GLOBAL="$tmp/gitconfig" GIT_CONFIG_NOSYSTEM=1 \
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never GIT_ALLOW_PROTOCOL=file \
    npm_config_userconfig="$tmp/npmrc" npm_config_globalconfig="$tmp/npmrc-global" \
    npm_config_cache="$tmp/npm-cache" npm_config_offline=true \
    npm_config_audit=false npm_config_fund=false \
    node "${loader[@]}" "$file" 2>&1)" || status=$?
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "$line" in
    PASS:*)
      echo "  PASS  ${line#PASS: }"
      PASS=$((PASS + 1))
      checks=$((checks + 1))
      ;;
    FAIL:*)
      echo "  FAIL  ${line#FAIL: }"
      FAIL=$((FAIL + 1))
      checks=$((checks + 1))
      ;;
    "") ;;
    *) echo "        $line" ;;
    esac
  done <<<"$out"
  if ((status != 0)); then
    echo "  FAIL  ${file##*/} exited $status"
    FAIL=$((FAIL + 1))
  elif ((checks == 0)); then
    echo "  FAIL  ${file##*/} produced no PASS/FAIL checks"
    FAIL=$((FAIL + 1))
  fi
  echo
}

echo "== pi-board-agent: offline tests =="
shopt -s nullglob
# Snapshot the discovered paths once; no generated files, tracked-state writes,
# or hand-maintained list that can silently omit a new subsystem regression.
if (($#)); then
  files=("$@") # Optional focused local run; CI uses discovery with no arguments.
else
  files=("$ROOT"/tests/test-*.ts "$ROOT"/tests/test-*.mjs)
fi
if ((${#files[@]} == 0)); then
  echo "FAIL: no test files discovered"
  exit 1
fi
for file in "${files[@]}"; do run_check "$file"; done

if ((FAIL)); then
  echo "pi-board-agent: $FAIL FAILED, $PASS passed"
  exit 1
fi
echo "pi-board-agent: ALL CHECKS PASSED ($PASS/$PASS)"
