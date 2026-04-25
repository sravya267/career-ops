# career-ops Setup Guide

**Total time:** ~25 minutes  
**What you need:** A Google account (Gmail). That's it.

---

## Before you start — Get your free Gemini API key (2 min)

- Go to **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)**
- Click **Create API key**
- Click **Create API key in new project**
- Copy the key and save it somewhere (Notepad, Notes app) — you'll need it in Step 5

---

## Part 1 — Google Cloud setup (UI, ~10 min)

### Step 1 — Create a Google Cloud project

- Go to **[console.cloud.google.com](https://console.cloud.google.com)**
- Sign in with your Google account
- Click the project dropdown at the top (it may say "Select a project")
- Click **New Project**
- Project name: `career-ops` (or anything you like)
- Click **Create**
- Wait ~30 seconds, then make sure `career-ops` is selected in the top dropdown

### Step 2 — Enable billing (required, but free tier is plenty)

> Cloud Run and the other services are free within normal usage limits.
> Google still requires a credit card on file — you will **not** be charged
> for this project unless you process millions of jobs.

- In the left sidebar, click the **≡ menu** → **Billing**
- Click **Link a billing account**
- Follow the prompts to add a credit card
- Come back to **[console.cloud.google.com](https://console.cloud.google.com)** when done

### Step 3 — Enable the required services (one click)

- Click this link to enable all 6 services at once:  
  **[Enable all services](https://console.cloud.google.com/flows/enableapi?apiid=run.googleapis.com,bigquery.googleapis.com,cloudbuild.googleapis.com,cloudscheduler.googleapis.com,secretmanager.googleapis.com,artifactregistry.googleapis.com)**
- Make sure your `career-ops` project is selected at the top
- Click **Enable** (or **Next** → **Enable**)
- Wait about 1 minute for all services to activate

---

## Part 2 — Deploy the pipeline (Cloud Shell, ~10 min)

> **What is Cloud Shell?**  
> It's a free terminal that runs in your browser — nothing to download or install.
> It's built into Google Cloud and already has everything this project needs.

### Step 4 — Open Cloud Shell

- Go to **[console.cloud.google.com](https://console.cloud.google.com)**
- Click the **>_** icon in the top-right toolbar (tooltip says "Activate Cloud Shell")
- A terminal panel opens at the bottom of the page
- Click **Continue** if it asks to authorize Cloud Shell
- Wait ~15 seconds for it to initialize

### Step 5 — Run the setup (one command)

- Click inside the Cloud Shell terminal
- Copy and paste this command, then press **Enter**:

```
git clone https://github.com/sravya267/career-ops.git && cd career-ops/job-board-api && bash setup-gcp.sh
```

### Step 6 — Answer the 3 prompts

The script will ask you 3 things. Type each answer and press **Enter**:

1. **GCP project ID** — type `career-ops` (or whatever you named it in Step 1)  
   *(Tip: run `gcloud projects list` in the terminal to see your exact project ID)*

2. **Gemini API key** — paste the key you saved in the "Before you start" step  
   *(The key won't show as you type — that's normal, it's hidden for security)*

3. **Candidate profile** — paste this exact text (or edit it to match your preferences):

```
Fullstack data and analytics professional with 14+ years of hands-on experience in data engineering, ML/AI, and advanced analytics. Deep expertise in Python, PySpark, SQL, GCP, Azure, and AWS; hands-on with LLMs, NLP, prompt engineering, and GenAI automation. Delivered $200K+ pipeline savings at a Fortune 500 and currently building AI-powered applications using FastAPI and ML. Targeting mid-level to senior individual contributor roles in Data Engineering, ML Engineering, or Applied AI — not looking for management or team-lead positions. Open to remote or hybrid.
```

**Then wait ~10 minutes** while the script:
- Sets up your account permissions
- Stores your secrets securely
- Builds and deploys the pipeline
- Creates the 6-hour automatic schedule

When you see **"Setup complete!"** in green, you're done with this part.

---

## Part 3 — Google Sheets dashboard (UI, ~5 min)

### Step 7 — Create your Google Sheet

- Go to **[sheets.new](https://sheets.new)** — this creates a blank spreadsheet
- Rename it: click "Untitled spreadsheet" at the top → type `career-ops dashboard` → press Enter
- Copy the Sheet ID from the URL bar:  
  `https://docs.google.com/spreadsheets/d/`**`THIS_PART_HERE`**`/edit`  
  *(It's the long string of letters and numbers — save it in Notepad)*

### Step 8 — Open the Apps Script editor

- In your Google Sheet, click the top menu: **Extensions → Apps Script**
- A new browser tab opens with a code editor
- You'll see some default code like `function myFunction() {}`
- **Select all of it** (Ctrl+A on Windows, Cmd+A on Mac) and **delete it**

### Step 9 — Paste the dashboard code

- Go to **[this link](https://github.com/sravya267/career-ops/blob/claude/job-board-api-integration-gt6Qy/apps-script/Code.gs)** to view the dashboard code
- Click the **Copy raw file** button (or select all and copy)
- Go back to the Apps Script editor tab
- **Paste** the code (Ctrl+V / Cmd+V)

### Step 10 — Update your project ID in the code

- Near the top of the pasted code, find this line:

```
bqProject: 'your-gcp-project-id',
```

- Change `your-gcp-project-id` to your actual project ID (e.g. `career-ops`)  
  *(It should look like: `bqProject: 'career-ops',`)*

### Step 11 — Save and run

- Click the **💾 Save** button (or Ctrl+S / Cmd+S)
- In the function dropdown (shows "myFunction" by default), select **onOpen**
- Click the **▶ Run** button
- A popup asks for permissions — click **Review permissions** → choose your Google account → click **Allow**
- Go back to your Google Sheet tab and **refresh the page**
- You should now see a **"Career Ops"** menu in the top menu bar

### Step 12 — Enable BigQuery in Apps Script

- Back in the Apps Script editor, click **Services** (the + icon in the left sidebar)
- Scroll down to find **BigQuery API**
- Click it → click **Add**
- Save again (Ctrl+S)

---

## Part 4 — Test it end to end (2 min)

### Step 13 — Trigger your first pipeline run

- Go to **[console.cloud.google.com/cloudscheduler](https://console.cloud.google.com/cloudscheduler)**
- You'll see a job called **career-ops-scan**
- Click the **⋮ (three dots)** menu on the right → click **Force run**
- Wait 5-10 minutes for the pipeline to fetch and score jobs

### Step 14 — View your results

- Go back to your Google Sheet
- Click **Career Ops → Refresh dashboard**
- Jobs will appear ranked by score (green = 90+, blue = 80+, yellow = 65+)
- Click **Career Ops → Generate CVs** to auto-create a tailored CV PDF for each top job

---

## Day-to-day use

| What you want to do | How |
|---------------------|-----|
| See new jobs | Open your Sheet → **Career Ops → Refresh dashboard** |
| Generate CVs for top jobs | **Career Ops → Generate CVs** |
| Trigger an immediate scan | Cloud Scheduler → **Force run** |
| Update your profile/key | Go to [Secret Manager](https://console.cloud.google.com/security/secret-manager) → click the secret → **New version** |
| Add more companies | Edit `portals.json` in Cloud Shell, then run `bash deploy.sh` |
| View raw data | Go to [BigQuery](https://console.cloud.google.com/bigquery) → `career_ops` dataset |

The pipeline runs automatically every 6 hours — you don't need to do anything.

---

## Troubleshooting

**"Permission denied" in Cloud Shell**
→ Make sure your `career-ops` project is selected at the top of the Cloud Console

**"Billing not enabled" error**
→ Complete Step 2 and re-run `bash setup-gcp.sh` in Cloud Shell (it's safe to re-run)

**Dashboard shows no jobs**
→ The first pipeline run takes 10-15 min. Check Cloud Run logs:  
   [console.cloud.google.com/run](https://console.cloud.google.com/run) → click `career-ops-job-board` → **Logs** tab

**Apps Script "BigQuery not found" error**
→ Make sure you completed Step 12 (adding BigQuery as a Service in Apps Script)

---

*Need help? Open an issue or ask in [Discord](https://discord.gg/8pRpHETxa4)*
