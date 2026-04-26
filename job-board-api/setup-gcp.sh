#!/usr/bin/env bash
# career-ops — One-time GCP infrastructure setup
#
# What this script does (in order):
#   1. Checks prerequisites (gcloud)
#   2. Prompts for project ID, region, API key, candidate profile
#   3. Creates GCP project (or uses existing)
#   4. Enables required APIs
#   5. Creates a dedicated service account with least-privilege IAM roles
#   6. Stores GEMINI_API_KEY and CANDIDATE_PROFILE in Secret Manager
#   7. Creates an Artifact Registry Docker repo
#   8. Builds the container image via Cloud Build (no local Docker needed)
#   9. Deploys the Cloud Run service (secrets auto-injected, scales to zero)
#  10. Creates a Cloud Scheduler job to POST /run every 6 hours
#  11. Saves non-sensitive config to .env for future deploys
#
# Usage:
#   bash setup-gcp.sh
#
# Re-running is safe — all steps are idempotent.

set -euo pipefail

# ── Output helpers ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC}  $*"; }
warn() { echo -e "${YELLOW}⚠${NC}   $*"; }
err()  { echo -e "${RED}✗${NC}  $*"; exit 1; }
step() { echo -e "\n${BOLD}▶  $*${NC}"; }
hr()   { echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

hr
echo -e "${BOLD}  career-ops — GCP Setup${NC}"
hr

# ── 1. Prerequisites ───────────────────────────────────────────────────────────
step "Checking prerequisites"

command -v gcloud &>/dev/null || err "gcloud CLI not found.
   Install: https://cloud.google.com/sdk/docs/install
   Then run: gcloud auth login && gcloud auth application-default login"

GCLOUD_VERSION=$(gcloud version --format='value(Google Cloud SDK)' 2>/dev/null | head -1)
ok "gcloud ${GCLOUD_VERSION:-found}"

# Verify authenticated
GCLOUD_ACCOUNT=$(gcloud config get-value account 2>/dev/null || true)
[[ -z "$GCLOUD_ACCOUNT" ]] && err "Not logged in. Run: gcloud auth login"
ok "Authenticated as $GCLOUD_ACCOUNT"

# ── 2. Load .env if it exists ──────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  # Export vars but skip lines starting with # and blank lines
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    export "$line" 2>/dev/null || true
  done < "$ENV_FILE"
  ok "Loaded existing config from .env"
fi

# ── 3. Collect configuration ───────────────────────────────────────────────────
step "Configuration"

ask() {
  # ask VAR_NAME "prompt text" ["default"]
  local var="$1" prompt="$2" default="${3:-}"
  # If already set (from .env or env), just show the value
  if [[ -n "${!var:-}" ]]; then
    echo "  $prompt: ${!var}"
    return
  fi
  if [[ -n "$default" ]]; then
    read -rp "  $prompt [$default]: " _val
    printf -v "$var" '%s' "${_val:-$default}"
  else
    read -rp "  $prompt: " _val
    [[ -z "$_val" ]] && err "$var is required"
    printf -v "$var" '%s' "$_val"
  fi
  export "$var"
}

ask PROJECT_ID  "GCP project ID (new or existing, e.g. career-ops-yourname)"
ask REGION      "Region" "us-central1"

# Gemini key — never print it back after entry
if [[ -z "${GEMINI_API_KEY:-}" ]]; then
  read -rsp "  Gemini API key (hidden, get one at aistudio.google.com/apikey): " GEMINI_API_KEY
  echo ""
  export GEMINI_API_KEY
fi
ok "Gemini API key: ****${GEMINI_API_KEY: -4}"

# Candidate profile — read from file or stdin
PROFILE_FILE="$SCRIPT_DIR/candidate-profile.txt"
if [[ -z "${CANDIDATE_PROFILE:-}" ]]; then
  if [[ -f "$PROFILE_FILE" ]]; then
    CANDIDATE_PROFILE="$(cat "$PROFILE_FILE")"
    ok "Loaded candidate profile from candidate-profile.txt"
  else
    echo ""
    echo "  Candidate profile (2-4 sentences: experience, stack, target roles, location)."
    echo "  Tip: save it to job-board-api/candidate-profile.txt to avoid re-entering."
    read -rp "  Profile: " CANDIDATE_PROFILE
    [[ -z "$CANDIDATE_PROFILE" ]] && err "CANDIDATE_PROFILE is required"
  fi
  export CANDIDATE_PROFILE
else
  ok "Candidate profile: ${CANDIDATE_PROFILE:0:60}..."
fi

# Derived names (can be overridden via .env)
SERVICE_NAME="${SERVICE_NAME:-career-ops-job-board}"
SA_NAME="${SA_NAME:-career-ops-runner}"
BQ_DATASET="${BQ_DATASET:-career_ops}"
REPO_NAME="${REPO_NAME:-career-ops}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}"

echo ""
echo "  Project:     $PROJECT_ID"
echo "  Region:      $REGION"
echo "  Service:     $SERVICE_NAME"
echo "  BigQuery:    ${PROJECT_ID}.${BQ_DATASET}"
echo ""
read -rp "  Proceed? [Y/n] " _confirm
[[ "${_confirm:-y}" =~ ^[nN] ]] && { echo "Aborted."; exit 0; }

# ── 4. GCP project ─────────────────────────────────────────────────────────────
step "GCP project"

if gcloud projects describe "$PROJECT_ID" &>/dev/null; then
  ok "Using existing project: $PROJECT_ID"
else
  echo "  Creating project $PROJECT_ID..."
  gcloud projects create "$PROJECT_ID" --name="career-ops" --quiet
  ok "Project created: $PROJECT_ID"
fi

gcloud config set project "$PROJECT_ID" --quiet

# Billing check (required for Cloud Run, Secret Manager, Scheduler)
BILLING_ENABLED=$(gcloud billing projects describe "$PROJECT_ID" \
  --format='value(billingEnabled)' 2>/dev/null || echo "False")

if [[ "$BILLING_ENABLED" != "True" ]]; then
  warn "Billing is not enabled on project $PROJECT_ID."
  warn "Cloud Run, Secret Manager, and Cloud Scheduler require billing to be enabled,"
  warn "even though all services used here are within the free tier."
  warn ""
  warn "Enable billing at:"
  warn "  https://console.cloud.google.com/billing/projects"
  warn ""
  read -rp "  Have you enabled billing and want to continue? [y/N] " _bill
  [[ "${_bill:-n}" =~ ^[yY] ]] || { echo "Aborted — enable billing first."; exit 1; }
fi

# ── 5. Enable APIs ─────────────────────────────────────────────────────────────
step "Enabling GCP APIs (may take 1-2 minutes on first run)"

gcloud services enable \
  run.googleapis.com \
  bigquery.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  docs.googleapis.com \
  drive.googleapis.com \
  --project="$PROJECT_ID" --quiet

ok "All APIs enabled"

# ── 6. Service account + IAM ───────────────────────────────────────────────────
step "Service account"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" &>/dev/null; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="career-ops Cloud Run runner" \
    --project="$PROJECT_ID" --quiet
  ok "Created service account: $SA_EMAIL"
else
  ok "Service account already exists: $SA_EMAIL"
fi

# Assign least-privilege roles
for role in \
  roles/bigquery.dataEditor \
  roles/bigquery.jobUser \
  roles/secretmanager.secretAccessor \
  roles/run.invoker; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="$role" \
    --condition=None \
    --quiet &>/dev/null
done
ok "IAM roles assigned (BigQuery editor, Secret accessor, Run invoker)"

# ── 7. Secret Manager ──────────────────────────────────────────────────────────
step "Storing secrets in Secret Manager"

store_secret() {
  local name="$1" value="$2"
  if gcloud secrets describe "$name" --project="$PROJECT_ID" &>/dev/null; then
    printf '%s' "$value" | gcloud secrets versions add "$name" \
      --data-file=- --project="$PROJECT_ID" --quiet
    ok "Updated secret: $name"
  else
    printf '%s' "$value" | gcloud secrets create "$name" \
      --data-file=- \
      --replication-policy=automatic \
      --project="$PROJECT_ID" --quiet
    ok "Created secret: $name"
  fi
  # Grant the service account access to read this secret
  gcloud secrets add-iam-policy-binding "$name" \
    --member="serviceAccount:$SA_EMAIL" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" --quiet &>/dev/null
}

store_secret "GEMINI_API_KEY"    "$GEMINI_API_KEY"
store_secret "CANDIDATE_PROFILE" "$CANDIDATE_PROFILE"

# ── 8. Artifact Registry ───────────────────────────────────────────────────────
step "Container registry (Artifact Registry)"

if ! gcloud artifacts repositories describe "$REPO_NAME" \
  --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --project="$PROJECT_ID" --quiet
  ok "Created Artifact Registry repo: $REPO_NAME"
else
  ok "Registry repo already exists: $REPO_NAME"
fi

# ── 9. Build image via Cloud Build ─────────────────────────────────────────────
step "Building container image (Cloud Build — no local Docker needed)"

cd "$SCRIPT_DIR"
gcloud builds submit \
  --region="$REGION" \
  --tag="$IMAGE:latest" \
  --project="$PROJECT_ID" \
  --quiet .

ok "Image built and pushed: $IMAGE:latest"

# ── 10. Deploy Cloud Run ────────────────────────────────────────────────────────
step "Deploying Cloud Run service"

gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE:latest" \
  --region="$REGION" \
  --platform=managed \
  --no-allow-unauthenticated \
  --service-account="$SA_EMAIL" \
  --memory=512Mi \
  --cpu=1 \
  --timeout=900 \
  --concurrency=1 \
  --min-instances=0 \
  --max-instances=1 \
  --set-env-vars="BQ_PROJECT=${PROJECT_ID},BQ_DATASET=${BQ_DATASET}" \
  --set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest,CANDIDATE_PROFILE=CANDIDATE_PROFILE:latest" \
  --project="$PROJECT_ID" \
  --quiet

SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')

ok "Cloud Run deployed: $SERVICE_URL"

# ── 11. Cloud Scheduler (every 6 hours) ─────────────────────────────────────────
step "Cloud Scheduler"

SCHEDULER_JOB="career-ops-scan"

SCHEDULER_ARGS=(
  --location="$REGION"
  --schedule="0 */6 * * *"
  --uri="${SERVICE_URL}/run"
  --http-method=POST
  --oidc-service-account-email="$SA_EMAIL"
  --oidc-token-audience="$SERVICE_URL"
  --attempt-deadline=960s
  --project="$PROJECT_ID"
  --quiet
)

if gcloud scheduler jobs describe "$SCHEDULER_JOB" \
  --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  gcloud scheduler jobs update http "$SCHEDULER_JOB" "${SCHEDULER_ARGS[@]}"
  ok "Updated Cloud Scheduler job: $SCHEDULER_JOB"
else
  gcloud scheduler jobs create http "$SCHEDULER_JOB" "${SCHEDULER_ARGS[@]}"
  ok "Created Cloud Scheduler job: every 6 hours → POST ${SERVICE_URL}/run"
fi

# ── 12. Save config to .env ─────────────────────────────────────────────────────
step "Saving config"

# Write only non-sensitive values; secrets stay in Secret Manager
cat > "$ENV_FILE" <<ENVEOF
# Auto-generated by setup-gcp.sh — safe to commit (no secrets here)
PROJECT_ID=${PROJECT_ID}
REGION=${REGION}
SERVICE_NAME=${SERVICE_NAME}
SA_NAME=${SA_NAME}
BQ_DATASET=${BQ_DATASET}
REPO_NAME=${REPO_NAME}
SERVICE_URL=${SERVICE_URL}
ENVEOF

ok "Saved config to $ENV_FILE"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
hr
echo -e "${GREEN}${BOLD}  Setup complete!${NC}"
hr
echo ""
echo "  Cloud Run:   $SERVICE_URL"
echo "  Scheduler:   every 6 hours → POST ${SERVICE_URL}/run"
echo "  BigQuery:    ${PROJECT_ID}.${BQ_DATASET}.{jobs, scores}"
echo ""
echo "  Run the pipeline right now:"
printf "  %s\n" "gcloud scheduler jobs run career-ops-scan --location=$REGION --project=$PROJECT_ID"
echo ""
echo "  Or trigger manually:"
printf "  %s\n" "gcloud run services proxy $SERVICE_NAME --region=$REGION --port=8080 &"
printf "  %s\n" "curl -X POST http://localhost:8080/run"
echo ""
echo "  Next step — Google Sheets dashboard:"
printf "  %s\n" "bash $(dirname "$SCRIPT_DIR")/apps-script/setup.sh"
echo ""
