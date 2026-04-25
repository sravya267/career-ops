#!/usr/bin/env bash
# career-ops — Deploy Google Apps Script via clasp
#
# What this script does:
#   1. Installs clasp (Google's Apps Script CLI) if not present
#   2. Logs you in to Google (opens browser once)
#   3. Creates a new Apps Script project linked to your Google Sheet, OR
#      pushes to an existing project if .clasp.json already exists
#   4. Enables the BigQuery advanced service in the project
#   5. Opens the Apps Script editor so you can run onOpen() once to add the menu
#
# Prerequisites:
#   - Node.js 18+ (check: node --version)
#   - A Google account
#   - The Google Sheet where you want the dashboard
#     (create one at sheets.new, copy its ID from the URL)
#
# Usage:
#   bash apps-script/setup.sh

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}   $*"; }
step() { echo -e "\n${BOLD}▶  $*${NC}"; }
err()  { echo -e "\033[0;31m✗\033[0m  $*"; exit 1; }
hr()   { echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASP_JSON="$SCRIPT_DIR/.clasp.json"

hr
echo -e "${BOLD}  career-ops — Apps Script Setup${NC}"
hr

# ── 1. Node.js check ──────────────────────────────────────────────────────────
step "Checking prerequisites"

command -v node &>/dev/null || err "Node.js not found. Install: https://nodejs.org"
NODE_VERSION=$(node --version)
ok "Node.js $NODE_VERSION"

# ── 2. Install clasp ──────────────────────────────────────────────────────────
step "clasp (Google Apps Script CLI)"

if ! command -v clasp &>/dev/null; then
  echo "  Installing clasp globally..."
  npm install -g @google/clasp --quiet
  ok "clasp installed"
else
  ok "clasp $(clasp --version 2>/dev/null | head -1) already installed"
fi

# ── 3. Google login ───────────────────────────────────────────────────────────
step "Google authentication"

# Check if already logged in
if clasp login --status &>/dev/null; then
  ok "Already logged in to Google"
else
  echo "  Opening browser for Google login..."
  echo "  (Authorize clasp to manage your Apps Script projects)"
  clasp login
  ok "Logged in"
fi

# ── 4. Get the Google Sheet ID ────────────────────────────────────────────────
step "Google Sheet"

SHEET_ID=""
if [[ -f "$CLASP_JSON" ]]; then
  # Extract parentId from existing .clasp.json
  SHEET_ID=$(node -e "
    const c = require('${CLASP_JSON}');
    console.log(c.parentId || '');
  " 2>/dev/null || true)
fi

if [[ -z "$SHEET_ID" ]]; then
  echo ""
  echo "  Create a new Google Sheet at: https://sheets.new"
  echo "  Then copy the Sheet ID from the URL:"
  echo "  https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit"
  echo ""
  read -rp "  Paste your Google Sheet ID: " SHEET_ID
  [[ -z "$SHEET_ID" ]] && err "Sheet ID is required"
fi
ok "Sheet ID: $SHEET_ID"

# ── 5. Create or update the Apps Script project ───────────────────────────────
step "Apps Script project"

cd "$SCRIPT_DIR"

if [[ -f "$CLASP_JSON" ]]; then
  ok "Existing .clasp.json found — will push to existing project"
else
  echo "  Creating new Apps Script project bound to your Sheet..."
  clasp create \
    --type sheets \
    --title "career-ops" \
    --parentId "$SHEET_ID"
  ok "Apps Script project created"
fi

# ── 6. Push code ──────────────────────────────────────────────────────────────
step "Pushing code to Apps Script"

clasp push --force
ok "Code pushed (Code.gs + appsscript.json)"

# ── 7. Update config reminder ─────────────────────────────────────────────────
step "Final configuration"

# Read BQ project from job-board-api/.env if available
BQ_PROJECT=""
JOB_BOARD_ENV="$(dirname "$SCRIPT_DIR")/job-board-api/.env"
if [[ -f "$JOB_BOARD_ENV" ]]; then
  BQ_PROJECT=$(grep '^PROJECT_ID=' "$JOB_BOARD_ENV" | cut -d= -f2 || true)
fi

if [[ -n "$BQ_PROJECT" ]]; then
  warn "Update CONFIG.bqProject in Code.gs to: $BQ_PROJECT"
  warn "Then re-run this script (it will push the updated code)."
  echo ""
  read -rp "  Want me to update it now? [Y/n] " _update
  if [[ "${_update:-y}" =~ ^[yY] ]]; then
    sed -i "s/bqProject: *'your-gcp-project-id'/bqProject: '${BQ_PROJECT}'/" "$SCRIPT_DIR/Code.gs"
    ok "Updated bqProject in Code.gs to: $BQ_PROJECT"
    clasp push --force
    ok "Pushed updated Code.gs"
  fi
fi

# ── 8. Open editor ────────────────────────────────────────────────────────────
step "Opening Apps Script editor"

clasp open || warn "Could not open editor automatically — open it manually from your Google Sheet: Extensions → Apps Script"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
hr
echo -e "${GREEN}${BOLD}  Apps Script deployed!${NC}"
hr
echo ""
echo "  Manual step remaining (one-time):"
echo "  1. In the Apps Script editor, select 'onOpen' from the function dropdown"
echo "  2. Click ▶ Run — this adds the 'Career Ops' menu to your Sheet"
echo "  3. Grant the permissions it asks for (BigQuery, Drive, Docs, Sheets)"
echo "  4. Back in your Sheet, click Career Ops → Refresh dashboard"
echo ""
echo "  To push code changes in the future:"
printf "  %s\n" "cd apps-script && clasp push"
echo ""
