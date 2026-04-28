import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.mjs';

// Free tier: gemini-2.0-flash → 15 RPM. We target 12 RPM to stay safe.
const RATE_LIMIT_MS = 5000;
let lastCallAt = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function throttle() {
  const wait = RATE_LIMIT_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function buildPrompt(job) {
  const desc = (job.description || '').slice(0, 3000) || '[no description available]';
  return `You are evaluating a job posting for a candidate with very specific priorities.

CANDIDATE PROFILE:
${config.candidateProfile || '[not configured — score based on role title and seniority only]'}

SCORING PRIORITIES (in order of importance):
1. REMOTE WORK — candidate requires fully remote. If the role is onsite or hybrid only, cap score at 30.
2. WORK-LIFE BALANCE — look for signals: flexible hours, async culture, no-crunch, reasonable expectations.
3. JOB SECURITY — prefer roles where the candidate BUILDS AI/data infrastructure (pipelines, platforms, governance) over roles that compete with AI. Stable companies (profitable, government, enterprise) score higher than high-risk startups.
4. SKILLS MATCH — data engineering, cloud platforms (GCP/Azure/AWS), Python, PySpark, SQL, ML/AI, Airflow, Snowflake, Databricks.
5. IC ROLE — individual contributor only. If the role is primarily managerial (hiring, performance reviews, org design), cap score at 40.

JOB POSTING:
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || 'Not specified'}
Description:
${desc}

Return valid JSON ONLY (no markdown fences, no explanation):
{
  "score": <integer 0-100, applying all 5 priorities above>,
  "remote": <"yes"|"hybrid"|"no"|"unclear">,
  "wlb_signals": "<brief: any WLB signals found — flexible hours, async, 4-day week, unlimited PTO, etc. or 'none mentioned'>",
  "ai_proof": <true if role builds data/AI infrastructure that AI depends on; false if AI could replace this role>,
  "stability": <"high"|"medium"|"low" — based on company type and funding stage>,
  "seniority": <"senior"|"mid"|"junior"|"unclear">,
  "missing_skills": [<up to 3 strings the candidate likely lacks>],
  "summary": "<one sentence: score rationale focusing on remote + WLB + stability>"
}`;
}

let _model;
function getModel() {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY is not set');
  if (!_model) {
    _model = new GoogleGenerativeAI(config.geminiKey).getGenerativeModel({
      model: config.geminiModel,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      },
    });
  }
  return _model;
}

function parseResponse(text) {
  const clean = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(clean);
    return {
      score:            Math.min(100, Math.max(0, parseInt(parsed.score) || 0)),
      missing_skills:   (parsed.missing_skills || []).slice(0, 3).join(', '),
      salary_mentioned: Boolean(parsed.salary_mentioned),
      remote:           ['yes', 'hybrid', 'no', 'unclear'].includes(parsed.remote) ? parsed.remote : 'unclear',
      wlb_signals:      String(parsed.wlb_signals || 'none mentioned').slice(0, 200),
      ai_proof:         Boolean(parsed.ai_proof),
      stability:        ['high', 'medium', 'low'].includes(parsed.stability) ? parsed.stability : 'medium',
      seniority:        ['senior', 'mid', 'junior', 'unclear'].includes(parsed.seniority) ? parsed.seniority : 'unclear',
      summary:          String(parsed.summary || '').slice(0, 200),
    };
  } catch {
    return {
      score: -1, missing_skills: '', salary_mentioned: false,
      remote: 'unclear', wlb_signals: 'none mentioned', ai_proof: false,
      stability: 'medium', seniority: 'unclear', summary: 'parse-error',
    };
  }
}

export async function scoreJob(job) {
  await throttle();
  const result = await getModel().generateContent(buildPrompt(job));
  // SDK 0.24.0+ handles thinking models automatically
  return parseResponse(result.response.text());
}

export async function scoreBatch(jobs) {
  if (!jobs.length) return [];

  console.log(`Scoring ${jobs.length} jobs with Gemini (${config.geminiModel})`);
  const scored = [];

  for (const job of jobs) {
    try {
      const s = await scoreJob(job);
      scored.push({ job_id: job.id, ...s, scored_at: new Date().toISOString() });
      console.log(`  scored ${job.company}/${job.title}: ${s.score}`);
    } catch (err) {
      console.error(`  score failed ${job.company}/${job.title}: ${err.message}`);
      scored.push({
        job_id: job.id, score: -1, missing_skills: '', salary_mentioned: false,
        remote: 'unclear', wlb_signals: 'none mentioned', ai_proof: false,
        stability: 'medium', seniority: 'unclear',
        summary: `error: ${err.message}`.slice(0, 200),
        scored_at: new Date().toISOString(),
      });
    }
  }

  return scored;
}
