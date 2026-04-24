import { createHash } from 'crypto';
import { config } from './config.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function jobId(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 20);
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'career-ops-job-board/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── API detection ─────────────────────────────────────────────────────────────

function detectApi(company) {
  if (company.api?.includes('greenhouse')) {
    return { type: 'greenhouse', boardToken: extractGreenhouseToken(company.api), url: company.api };
  }

  const url = company.careers_url || '';

  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashby) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashby[1]}?includeCompensation=true`,
    };
  }

  const lever = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (lever) {
    return { type: 'lever', url: `https://api.lever.co/v0/postings/${lever[1]}` };
  }

  const gh = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (gh) {
    const boardToken = gh[1];
    return {
      type: 'greenhouse',
      boardToken,
      url: `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs`,
    };
  }

  const ghApi = url.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/);
  if (ghApi) {
    return { type: 'greenhouse', boardToken: ghApi[1], url };
  }

  return null;
}

function extractGreenhouseToken(apiUrl) {
  const m = apiUrl.match(/boards\/([^/?#]+)/);
  return m ? m[1] : '';
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  return (json.jobs || []).map(j => ({
    id:          jobId(j.absolute_url || ''),
    url:         j.absolute_url || '',
    company:     companyName,
    title:       j.title || '',
    location:    j.location?.name || '',
    description: '',   // requires a second API call per job
    source:      'greenhouse',
    fetched_at:  new Date().toISOString(),
  }));
}

function parseGreenhouseJob(json, companyName, listingUrl) {
  return {
    id:          jobId(listingUrl),
    url:         listingUrl,
    company:     companyName,
    title:       json.title || '',
    location:    json.location?.name || '',
    description: stripHtml(json.content || '').slice(0, 4000),
    source:      'greenhouse',
    fetched_at:  new Date().toISOString(),
  };
}

function parseLever(json, companyName) {
  return (Array.isArray(json) ? json : []).map(j => ({
    id:          jobId(j.hostedUrl || j.id || ''),
    url:         j.hostedUrl || '',
    company:     companyName,
    title:       j.text || '',
    location:    j.categories?.location || j.categories?.allLocations?.[0] || '',
    description: stripHtml(j.descriptionPlain || j.description || '').slice(0, 4000),
    source:      'lever',
    fetched_at:  new Date().toISOString(),
  }));
}

function parseAshby(json, companyName) {
  return (json.jobs || []).map(j => ({
    id:          jobId(j.applicationLink || j.id || ''),
    url:         j.applicationLink || '',
    company:     companyName,
    title:       j.title || '',
    location:    j.isRemote ? 'Remote' : (j.location || ''),
    description: stripHtml(j.descriptionHtml || '').slice(0, 4000),
    source:      'ashby',
    fetched_at:  new Date().toISOString(),
  }));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

const PARSERS = { greenhouse: parseGreenhouse, lever: parseLever, ashby: parseAshby };

// ── Title filter ──────────────────────────────────────────────────────────────

function makeTitleFilter(keywords) {
  if (!keywords.length) return () => true;
  return (title) => {
    const t = title.toLowerCase();
    return keywords.some(k => t.includes(k));
  };
}

// ── Greenhouse description fetcher ────────────────────────────────────────────

async function enrichGreenhouseDescriptions(jobs, boardToken) {
  const enriched = [];
  for (const job of jobs) {
    const ghId = job.url.match(/(\d+)(?:[?#]|$)/)?.[1];
    if (!ghId || !boardToken) { enriched.push(job); continue; }
    try {
      const detail = await fetchJson(
        `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs/${ghId}`
      );
      enriched.push({ ...job, description: stripHtml(detail.content || '').slice(0, 4000) });
    } catch {
      enriched.push(job);
    }
  }
  return enriched;
}

// ── Parallel fetch ────────────────────────────────────────────────────────────

async function parallelFetch(tasks, limit = 10) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
  return results.flat();
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchAllJobs(companies = config.portals) {
  const titleFilter = makeTitleFilter(config.titleKeywords);

  const targets = companies
    .filter(c => c.enabled !== false)
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  console.log(`Fetching from ${targets.length} companies`);

  const errors = [];
  const allJobs = await parallelFetch(
    targets.map(company => async () => {
      const { type, url, boardToken } = company._api;
      try {
        const json = await fetchJson(url);
        let jobs = PARSERS[type](json, company.name);

        // Optionally fetch Greenhouse descriptions
        if (type === 'greenhouse' && config.fetchDescriptions) {
          jobs = await enrichGreenhouseDescriptions(jobs, boardToken);
        }

        return jobs.filter(j => j.url && titleFilter(j.title));
      } catch (err) {
        errors.push({ company: company.name, error: err.message });
        return [];
      }
    })
  );

  if (errors.length) {
    for (const e of errors) console.error(`  fetch error — ${e.company}: ${e.error}`);
  }

  console.log(`Fetched ${allJobs.length} matching jobs (${errors.length} errors)`);
  return allJobs;
}
