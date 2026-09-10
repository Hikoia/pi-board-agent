#!/usr/bin/env bash
# Interactive setup; only reads GitHub metadata and writes local config.
# Usage: bash scripts/setup.sh [--non-interactive]
# Non-interactive overrides: PROJECT_OWNER, PROJECT_NUMBER, STATUS_FIELD,
# PLAN_FIELD, TYPE_FIELD, READY_COL, DONE_COL. Requires Bash 4+, Node 22.19+, git, gh.
set -euo pipefail

NON_INTERACTIVE=false
case "${1:-}" in
  "") ;;
  --non-interactive) NON_INTERACTIVE=true ;;
  *) printf 'Usage: bash scripts/setup.sh [--non-interactive]\n' >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { printf 'Too many arguments\n' >&2; exit 1; }
err() { printf 'Error: %s\n' "$1" >&2; exit 1; }
warn() { printf 'Warning: %s\n' "$1" >&2; }
ask() {
  local val=""
  if [[ "$NON_INTERACTIVE" == false && -t 0 ]]; then
    read -rp "$1 [$2]: " val
  fi
  printf '%s\n' "${val:-$2}"
}

echo 'pi-board-agent setup (0.2.0)'
for tool in node git gh; do
  command -v "$tool" >/dev/null 2>&1 || err "Missing prerequisite: $tool"
done
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>22 || (major===22 && minor>=19) ? 0 : 1)' || err 'Node 22.19.0 or newer is required.'

REMOTE="$(git remote get-url origin 2>/dev/null)" || err 'Set a GitHub origin remote first.'
IDENTITY="$(node -e '
const match = process.argv[1].match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+?)(?:\.git)?$/i);
if (!match || match[2] === "." || match[2] === "..") process.exit(1);
console.log(match[1], match[2]);
' "$REMOTE")" || err 'origin must be a GitHub HTTPS or SSH remote with exactly owner/repository.'
read -r OWNER REPO <<< "$IDENTITY"
printf 'Target repository: %s/%s\n' "$OWNER" "$REPO"

PROJECT_OWNER="$(ask 'Project owner' "${PROJECT_OWNER:-$OWNER}")"
PROJECT_NUMBER="$(ask 'Project number' "${PROJECT_NUMBER:-1}")"
node -e '
if (!/^[a-z0-9][a-z0-9-]*$/i.test(process.argv[1]) || !/^[1-9][0-9]*$/.test(process.argv[2]) || Number(process.argv[2]) > 2147483647) process.exit(1);
' "$PROJECT_OWNER" "$PROJECT_NUMBER" || err 'Project owner must be a GitHub login; Project number must be an integer from 1 to 2147483647.'

gh auth status >/dev/null 2>&1 || err 'gh is not authenticated. Run: gh auth login'
if ! gh auth status 2>&1 | grep -q 'project'; then
  # Never refresh credentials or launch an interactive flow from unattended setup.
  err "Project scope was not detected. Run: gh auth refresh -s project; then rerun setup."
fi

printf 'Project fields for %s/#%s:\n' "$PROJECT_OWNER" "$PROJECT_NUMBER"
if FIELDS_JSON="$(gh project field-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json)"; then
  printf '%s' "$FIELDS_JSON" | node -e '
const fields = JSON.parse(require("node:fs").readFileSync(0, "utf8")).fields;
if (!Array.isArray(fields)) process.exit(1);
for (const field of fields) {
  console.log("  " + JSON.stringify(field.name) + (Array.isArray(field.options) ? ": " + field.options.map(o => JSON.stringify(o.name)).join(", ") : ""));
}
' || warn 'Could not parse project fields; configure them manually.'
else
  warn 'Could not read project fields; configure them manually.'
fi

STATUS_FIELD="$(ask 'Status field name' "${STATUS_FIELD:-Status}")"
PLAN_FIELD="$(ask 'Plan field name' "${PLAN_FIELD:-Plan}")"
TYPE_FIELD="$(ask 'Type field name' "${TYPE_FIELD:-Kind}")"
READY_COL="$(ask 'Ready column name' "${READY_COL:-Ready}")"
DONE_COL="$(ask 'Done column name' "${DONE_COL:-Done}")"
node -e '
const names = process.argv.slice(1);
if (names.some(s => !s || s.trim() !== s || /[\x00-\x1f\x7f]/.test(s))) process.exit(1);
const statuses = [names[3], names[4], "Backlog", "In Progress", "Needs Design", "Needs Human", "Review"].map(s => s.toLowerCase());
if (new Set(statuses).size !== statuses.length) process.exit(1);
' "$STATUS_FIELD" "$PLAN_FIELD" "$TYPE_FIELD" "$READY_COL" "$DONE_COL" || err 'Use non-empty single-line field names and seven distinct status names.'

CONFIG_PATH="$PWD/.pi/board-agent.yml"
[[ ! -L "$PWD/.pi" && ! -L "$CONFIG_PATH" ]] || err 'Refusing a symlinked config path.'
if [[ -e "$CONFIG_PATH" ]]; then
  [[ "$(ask "Overwrite $CONFIG_PATH? (y/n)" n)" == y ]] || { echo 'Setup aborted; existing config unchanged.'; exit 0; }
fi
umask 077
mkdir -p "$PWD/.pi"
TEMP_CONFIG="$(mktemp "$PWD/.pi/.board-agent-XXXXXX")"
trap 'rm -f "$TEMP_CONFIG"' EXIT
# JSON is a YAML 1.2 mapping. Native serialization safely preserves quotes,
# backslashes, Unicode and YAML-looking text without a second YAML dependency.
node -e '
const [owner, number, status_field, plan_field, type_field, ready, done] = process.argv.slice(1);
console.log(JSON.stringify({
  project: { owner, number: Number(number) },
  columns: { backlog: "Backlog", ready, building: "In Progress", needs_design: "Needs Design", needs_human: "Needs Human", review: "Review", done },
  status_field, plan_field, type_field,
  builder_timeout_ms: 21600000,
  watchdog: { respond_to_mentions: false },
  auto_start: false
}, null, 2));
' "$PROJECT_OWNER" "$PROJECT_NUMBER" "$STATUS_FIELD" "$PLAN_FIELD" "$TYPE_FIELD" "$READY_COL" "$DONE_COL" > "$TEMP_CONFIG"
mv -f "$TEMP_CONFIG" "$CONFIG_PATH"
printf 'Config written: %s (YAML-compatible JSON; omitted keys use package defaults)\n' "$CONFIG_PATH"
echo 'Next steps (replace the placeholder with a reviewed, full 40-character Git SHA):'
echo '  pi install "git:github.com/Hikoia/pi-board-agent@<FULL_40_CHARACTER_GIT_SHA>"'
echo '  Restart Pi in this repository, then /board-agent lint and /board-agent run.'
echo '  Keep the normal Pi session open; --print exits and is not a daemon.'
