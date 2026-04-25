#!/usr/bin/env bash
# Simplified setup for Google Cloud Shell
# (Cloud Shell is already authenticated — skips auth/Docker checks)
#
# Run from inside career-ops/job-board-api/:
#   bash setup-cloudshell.sh

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}   $*"; }
err()  { echo -e "${RED}✗${NC}  $*"; exit 1; }
step() { echo -e "\n${BOLD}▶  $*${NC}"; }
hr()   { echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

hr
echo -e "${BOLD}  career-ops — Cloud Shell Setup${NC}"
hr

# Load .env if exists
[[ -f "$ENV_FILE" ]] && { set -o allexport; source "$ENV_FILE"; set +o allexport; ok "Loaded .env"; }

# ── Config prompts ─────────────────────────────────────────────────────────────
step "Configuration"

ask() {
  local var="$1" prompt="$2" default="${3:-}"
  if [[ -n "${!var:-}" ]]; then echo "  $prompt: ${!var}"; return; fi
  if [[ -n "$default" ]]; then
    read -rp "  $prompt [$default]: " _v; printf -v "$var" '%s' "${_v:-$default}"
  else
    read -rp "  $prompt: " _v; [[ -z "$_v" ]] && err "$var is required"; printf -v "$var" '%s' "$_v"
  fi
  export "$var"
}

# Default to current Cloud Shell project
DEFAULT_PROJECT=$(gcloud config get-value project 2>/dev/null || echo "")
ask PROJECT_ID "GCP project ID" "$DEFAULT_PROJECT"
ask REGION     "Region"         "us-central1"

# Gemini key
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  read -rsp "  Gemini API key (hidden): " GEMINI_API_KEY; echo ""; export GEMINI_API_KEY
fi
ok "Gemini key: ****${GEMINI_API_KEY: -4}"

# Candidate profile — from file or prompt
PROFILE_FILE="$SCRIPT_DIR/candidate-profile.txt"
if [[ -z "${CANDIDATE_PROFILE:-}" ]]; then
  if [[ -f "$PROFILE_FILE" ]]; then
    CANDIDATE_PROFILE="$(cat "$PROFILE_FILE")"; ok "Loaded profile from candidate-profile.txt"
  else
    echo "  Paste your candidate profile (1-3 sentences, press Enter twice when done):"
    CANDIDATE_PROFILE=""; while IFS= read -r line; do
      [[ -z "$line" ]] && break; CANDIDATE_PROFILE+="$line "; done
    [[ -z "$CANDIDATE_PROFILE" ]] && err "Candidate profile is required"
  fi
  export CANDIDATE_PROFILE
else
  ok "Profile: ${CANDIDATE_PROFILE:0:60}..."
fi

SERVICE_NAME="${SERVICE_NAME:-career-ops-job-board}"
SA_NAME="${SA_NAME:-career-ops-runner}"
BQ_DATASET="${BQ_DATASET:-career_ops}"
REPO_NAME="${REPO_NAME:-career-ops}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo ""
echo "  Project: $PROJECT_ID  |  Region: $REGION  |  Service: $SERVICE_NAME"
read -rp "  Proceed? [Y/n] " _c; [[ "${_c:-y}" =~ ^[nN] ]] && exit 0

# ── Project & APIs ─────────────────────────────────────────────────────────────
step "Setting project and enabling APIs"
gcloud config set project "$PROJECT_ID" --quiet
gcloud services enable \
  run.googleapis.com bigquery.googleapis.com cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com --project="$PROJECT_ID" --quiet
ok "APIs enabled"

# ── Service account ────────────────────────────────────────────────────────────
step "Service account"
if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" &>/dev/null; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="career-ops runner" --project="$PROJECT_ID" --quiet
fi
for role in roles/bigquery.dataEditor roles/bigquery.jobUser \
            roles/secretmanager.secretAccessor roles/run.invoker; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" --role="$role" --condition=None --quiet &>/dev/null
done
ok "$SA_EMAIL — roles assigned"

# ── Secrets ────────────────────────────────────────────────────────────────────
step "Storing secrets"
_store() {
  local n="$1" v="$2"
  if gcloud secrets describe "$n" --project="$PROJECT_ID" &>/dev/null; then
    printf '%s' "$v" | gcloud secrets versions add "$n" --data-file=- --project="$PROJECT_ID" --quiet
  else
    printf '%s' "$v" | gcloud secrets create "$n" --data-file=- \
      --replication-policy=automatic --project="$PROJECT_ID" --quiet
  fi
  gcloud secrets add-iam-policy-binding "$n" \
    --member="serviceAccount:$SA_EMAIL" --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" --quiet &>/dev/null
  ok "Secret: $n"
}
_store "GEMINI_API_KEY"    "$GEMINI_API_KEY"
_store "CANDIDATE_PROFILE" "$CANDIDATE_PROFILE"

# ── Artifact Registry ──────────────────────────────────────────────────────────
step "Container registry"
if ! gcloud artifacts repositories describe "$REPO_NAME" \
  --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker --location="$REGION" --project="$PROJECT_ID" --quiet
fi
ok "Registry: $REPO_NAME"

# ── Build & Deploy ─────────────────────────────────────────────────────────────
step "Building image (Cloud Build — ~3 min)"
cd "$SCRIPT_DIR"
gcloud builds submit --region="$REGION" --tag="$IMAGE:latest" --project="$PROJECT_ID" --quiet .
ok "Image built: $IMAGE:latest"

step "Deploying Cloud Run"
gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE:latest" --region="$REGION" --platform=managed \
  --no-allow-unauthenticated --service-account="$SA_EMAIL" \
  --memory=512Mi --cpu=1 --timeout=900 --concurrency=1 \
  --min-instances=0 --max-instances=1 \
  --set-env-vars="BQ_PROJECT=${PROJECT_ID},BQ_DATASET=${BQ_DATASET}" \
  --set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest,CANDIDATE_PROFILE=CANDIDATE_PROFILE:latest" \
  --project="$PROJECT_ID" --quiet

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')
ok "Cloud Run: $SERVICE_URL"

# ── Cloud Scheduler ────────────────────────────────────────────────────────────
step "Cloud Scheduler (every 6 hours)"
SCHED_ARGS=(--location="$REGION" --schedule="0 */6 * * *"
  --uri="${SERVICE_URL}/run" --http-method=POST
  --oidc-service-account-email="$SA_EMAIL" --oidc-token-audience="$SERVICE_URL"
  --attempt-deadline=960s --project="$PROJECT_ID" --quiet)

if gcloud scheduler jobs describe career-ops-scan \
  --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  gcloud scheduler jobs update http career-ops-scan "${SCHED_ARGS[@]}"
else
  gcloud scheduler jobs create http career-ops-scan "${SCHED_ARGS[@]}"
fi
ok "Scheduler: every 6 hours"

# ── Save .env ──────────────────────────────────────────────────────────────────
cat > "$ENV_FILE" <<ENVEOF
PROJECT_ID=${PROJECT_ID}
REGION=${REGION}
SERVICE_NAME=${SERVICE_NAME}
SA_NAME=${SA_NAME}
BQ_DATASET=${BQ_DATASET}
REPO_NAME=${REPO_NAME}
SERVICE_URL=${SERVICE_URL}
ENVEOF
ok "Config saved to .env"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""; hr
echo -e "${GREEN}${BOLD}  Done! Pipeline is live.${NC}"; hr
echo ""
echo "  Service:   $SERVICE_URL"
echo "  Schedule:  every 6 hours (automatic)"
echo "  BigQuery:  ${PROJECT_ID}.${BQ_DATASET}"
echo ""
echo "  Trigger first run now:"
echo "  gcloud scheduler jobs run career-ops-scan --location=$REGION --project=$PROJECT_ID"
echo ""
echo "  Then set up your Google Sheets dashboard — see SETUP.md Part 3"
echo ""
