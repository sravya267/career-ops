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
  return `You are evaluating a job posting for a candidate.

CANDIDATE PROFILE:
${config.candidateProfile || '[not configured — score based on role title and seniority only]'}

JOB POSTING:
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || 'Not specified'}
Description:
${desc}

Return valid JSON ONLY (no markdown fences, no explanation):
{
  "score": <integer 0-100, overall candidate fit>,
  "missing_skills": [<up to 5 strings — skills required by the JD the candidate likely lacks>],
  "salary_mentioned": <true|false>,
  "remote": <"yes"|"hybrid"|"no"|"unclear">,
  "seniority": <"senior"|"mid"|"junior"|"unclear">,
  "summary": "<one sentence: main reason for this score>"
}`;
}

let _model;
function getModel() {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY is not set');
  if (!_model) {
    _model = new GoogleGenerativeAI(config.geminiKey).getGenerativeModel({
      model: config.geminiModel,
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
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
      missing_skills:   (parsed.missing_skills || []).slice(0, 5).join(', '),
      salary_mentioned: Boolean(parsed.salary_mentioned),
      remote:           ['yes', 'hybrid', 'no', 'unclear'].includes(parsed.remote) ? parsed.remote : 'unclear',
      seniority:        ['senior', 'mid', 'junior', 'unclear'].includes(parsed.seniority) ? parsed.seniority : 'unclear',
      summary:          String(parsed.summary || '').slice(0, 200),
    };
  } catch {
    return { score: -1, missing_skills: '', salary_mentioned: false, remote: 'unclear', seniority: 'unclear', summary: 'parse-error' };
  }
}

export async function scoreJob(job) {
  await throttle();
  const result = await getModel().generateContent(buildPrompt(job));
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
        remote: 'unclear', seniority: 'unclear',
        summary: `error: ${err.message}`.slice(0, 200),
        scored_at: new Date().toISOString(),
      });
    }
  }

  return scored;
}
