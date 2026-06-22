#!/usr/bin/env bash
# scripts/setup.sh
#
# Interactive project setup wizard for pi-board-agent.
#  - Checks prerequisites: gh auth, gh project scope, git origin
#  - Scans the GitHub Project (v2) for Status / Plan fields
#  - Writes .pi/board-agent.yml with the detected values
#
# Usage:
#   bash scripts/setup.sh [--non-interactive]
#
# Requirements: bash >= 4, gh CLI, git

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CWD="${PWD}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()  { echo -e "${GREEN}✓${NC} $1"; }
warn(){ echo -e "${YELLOW}⚠${NC} $1"; }
err() { echo -e "${RED}✗${NC} $1"; exit 1; }
ask() {
  local prompt="$1"; local default="$2"
  if [[ -t 0 ]]; then read -rp "$prompt [$default]: " val; echo "${val:-$default}"
  else echo "$default"; fi
}

echo "pi-board-agent setup wizard"
echo "==========================="
echo

# 1. gh CLI
echo "→ Checking prerequisites..."
command -v gh >/dev/null 2>&1 || err "gh CLI not found. Install: https://cli.github.com/"
ok "gh CLI found"

# 2. gh auth
gh auth status >/dev/null 2>&1 || err "gh not authenticated. Run: gh auth login"
ok "gh authenticated"

# 3. gh project scope
if gh auth status 2>&1 | grep -q "project"; then
  ok "gh has project scope"
else
  warn "gh is missing the 'project' scope. Running: gh auth refresh -s project"
  gh auth refresh -s project || err "Failed to add project scope"
  ok "project scope added"
fi

# 4. git origin
REMOTE="$(git remote get-url origin 2>/dev/null || echo '')"
if [[ -z "$REMOTE" ]]; then
  err "No git origin remote. Run: git remote add origin <url>"
fi
if ! echo "$REMOTE" | grep -qi github.com; then
  err "origin is not a GitHub remote: $REMOTE"
fi
ok "git origin: $REMOTE"

# Derive owner + repo
OWNER="$(echo "$REMOTE" | sed -E 's|.*github.com[:/]([^/]+)/([^/]+?)(\.git)?$|\1|')"
REPO="$(echo "$REMOTE" | sed -E 's|.*github.com[:/]([^/]+)/([^/]+?)(\.git)?$|\2|')"
echo "  → owner=$OWNER  repo=$REPO"
echo

# 5. Pick project number
echo "→ GitHub Projects (v2) for $OWNER:"
gh project list --owner "$OWNER" --format json 2>/dev/null \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
if not data.get('projects'):
    print('  (no projects found)')
    sys.exit(0)
for p in data['projects']:
    print(f'  #{p[\"number\"]:>4d}  {p[\"title\"]}')
" 2>/dev/null || warn "Could not list projects. You can set the number manually later."

PROJECT_NUMBER="$(ask "Project number" "1")"
echo

# 6. Fetch project fields
echo "→ Fetching project fields..."
FIELDS_JSON="$(gh api graphql -f query='
query($owner: String!, $num: Int!) {
  user(login: $owner) { projectV2(number: $num) { fields(first:50) {
    nodes {
      ... on ProjectV2SingleSelectField { id name options { id name } }
      ... on ProjectV2Field { id name }
  }} } }
  organization(login: $owner) { projectV2(number: $num) { fields(first:50) {
    nodes {
      ... on ProjectV2SingleSelectField { id name options { id name } }
      ... on ProjectV2Field { id name }
  }} } }
}' -f owner="$OWNER" -F num="$PROJECT_NUMBER" 2>/dev/null)"

STATUS_FIELDS="$(echo "$FIELDS_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for scope in ('user','organization'):
    proj = (data.get(scope) or {}).get('projectV2')
    if not proj: continue
    for f in proj.get('fields',{}).get('nodes',[]):
        if not f: continue
        if f.get('options'):
            print(json.dumps({'name':f['name'], 'options':[o['name'] for o in f['options']]}))
" 2>/dev/null)"

if [[ -z "$STATUS_FIELDS" ]]; then
  warn "Could not read fields from project #$PROJECT_NUMBER. You will need to configure fields manually."
else
  echo "  Single-select fields found:"
  echo "$STATUS_FIELDS" | while IFS= read -r line; do
    echo "    $(echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"name\"]}: {d[\"options\"]}')")"
  done
fi
echo

# 7. Build config
STATUS_FIELD="$(ask "Status field name" "Status")"
PLAN_FIELD="$(ask "Plan field name (empty to skip)" "")"
READY_COL="$(ask "Ready column name" "Ready")"
DONE_COL="$(ask "Done column name" "Done")"

CONFIG_PATH="$CWD/.pi/board-agent.yml"

if [[ -f "$CONFIG_PATH" ]]; then
  warn "$CONFIG_PATH already exists."
  OVERWRITE="$(ask "Overwrite? (y/n)" "n")"
  if [[ "$OVERWRITE" != "y" ]]; then
    echo "Setup aborted. Edit $CONFIG_PATH manually."
    exit 0
  fi
fi

mkdir -p "$CWD/.pi"
cat > "$CONFIG_PATH" <<YAML
project:
  owner: "$OWNER"
  number: $PROJECT_NUMBER

columns:
  ready: "$READY_COL"
  building: "Building"
  review: "Review"
  done: "$DONE_COL"
status_field: "$STATUS_FIELD"
plan_field: "$PLAN_FIELD"

max_workers: 2
tick_seconds: 90
branches:
  base: "main"
  plan_prefix: "plan/"
  task_prefix: "task/"
task_merge_strategy: "squash"

pr:
  reviewers: []
  labels: ["board-agent"]

builder_tier: "medium"
builder_timeout_ms: 1800000
builder_retries: 1

safety:
  max_stuck_building: 3
  require_clean_worktree: true
  skip_closed_issues: true

bot_identity: ""
YAML

ok "Config written to $CONFIG_PATH"
echo

# 8. Verify with lint
echo "→ Running /board-agent lint..."
echo "  (start pi and run '/board-agent lint' to verify everything works)"
echo
echo "Setup complete! Next steps:"
echo "  1. pi install npm:@quintinshaw/pi-dynamic-workflows (if not already installed)"
echo "  2. pi install npm:@mancioshell/pi-board-agent"
echo "  3. /reload"
echo "  4. /board-agent lint"
echo "  5. /board-agent run"