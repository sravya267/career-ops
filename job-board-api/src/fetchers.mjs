import { createHash } from 'crypto';
import { config } from './config.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function jobId(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 20);
}

// Browser-like headers — critical to avoid blocks from job board APIs
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml,application/xml' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function now() { return new Date().toISOString(); }

// ── Jobicy — public remote jobs API ──────────────────────────────────────────
// https://jobicy.com/api/v2/remote-jobs  (no auth, no rate limit documented)

const JOBICY_TAGS = [
  'data-engineer', 'data-engineering',
  'machine-learning', 'artificial-intelligence',
  'cloud-computing', 'analytics',
];

export async function fetchJobicy() {
  const seen = new Set();
  const jobs = [];

  for (const tag of JOBICY_TAGS) {
    try {
      const data = await fetchJson(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${tag}`);
      for (const j of (data.jobs || [])) {
        const url = j.jobApply || j.url || `https://jobicy.com/jobs/${j.jobSlug}`;
        if (seen.has(url)) continue;
        seen.add(url);
        jobs.push({
          id:          jobId(url),
          url,
          company:     j.companyName  || '',
          title:       j.jobTitle     || '',
          location:    'Remote',
          description: stripHtml(j.jobDescription || '').slice(0, 4000),
          source:      'jobicy',
          fetched_at:  now(),
        });
      }
    } catch (err) {
      console.error(`  jobicy error (tag=${tag}): ${err.message}`);
    }
  }

  console.log(`  jobicy: ${jobs.length} jobs`);
  return jobs;
}

// ── We Work Remotely — RSS feed ───────────────────────────────────────────────
// Categories that cover data/cloud/ML roles

const WWR_FEEDS = [
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss',
];

function parseRssItem(itemXml) {
  const get = (tag) => {
    const m = itemXml.match(new RegExp(
      `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`
    ));
    return m ? (m[1] || m[2] || '').trim() : '';
  };
  return { title: get('title'), link: get('link'), description: get('description'), company: get('region') };
}

export async function fetchWeWorkRemotely() {
  const seen = new Set();
  const jobs = [];

  for (const feed of WWR_FEEDS) {
    try {
      const xml  = await fetchText(feed);
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

      for (const m of items) {
        const item = parseRssItem(m[1]);
        if (!item.link || seen.has(item.link)) continue;
        seen.add(item.link);
        jobs.push({
          id:          jobId(item.link),
          url:         item.link,
          company:     item.company || '',
          title:       item.title   || '',
          location:    'Remote',
          description: stripHtml(item.description).slice(0, 4000),
          source:      'weworkremotely',
          fetched_at:  now(),
        });
      }
    } catch (err) {
      console.error(`  weworkremotely error: ${err.message}`);
    }
  }

  console.log(`  weworkremotely: ${jobs.length} jobs`);
  return jobs;
}

// ── Greenhouse / Lever / Ashby company boards ─────────────────────────────────

function detectApi(company) {
  if (company.api?.includes('greenhouse')) {
    return { type: 'greenhouse', boardToken: extractGreenhouseToken(company.api), url: company.api };
  }
  const url = company.careers_url || '';

  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashby) return { type: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${ashby[1]}?includeCompensation=true` };

  const lever = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (lever) return { type: 'lever', url: `https://api.lever.co/v0/postings/${lever[1]}` };

  const gh = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (gh) return { type: 'greenhouse', boardToken: gh[1], url: `https://boards-api.greenhouse.io/v1/boards/${gh[1]}/jobs` };

  const ghApi = url.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/);
  if (ghApi) return { type: 'greenhouse', boardToken: ghApi[1], url };

  return null;
}

function extractGreenhouseToken(u) { return (u.match(/boards\/([^/?#]+)/) || [])[1] || ''; }

function parseGreenhouse(json, company) {
  return (json.jobs || []).map(j => ({
    id: jobId(j.absolute_url || ''), url: j.absolute_url || '',
    company, title: j.title || '', location: j.location?.name || '',
    description: '', source: 'greenhouse', fetched_at: now(),
  }));
}

function parseLever(json, company) {
  return (Array.isArray(json) ? json : []).map(j => ({
    id: jobId(j.hostedUrl || j.id || ''), url: j.hostedUrl || '',
    company, title: j.text || '',
    location: j.categories?.location || j.categories?.allLocations?.[0] || '',
    description: stripHtml(j.descriptionPlain || j.description || '').slice(0, 4000),
    source: 'lever', fetched_at: now(),
  }));
}

function parseAshby(json, company) {
  return (json.jobs || []).map(j => ({
    id: jobId(j.applicationLink || j.id || ''), url: j.applicationLink || '',
    company, title: j.title || '', location: j.isRemote ? 'Remote' : (j.location || ''),
    description: stripHtml(j.descriptionHtml || '').slice(0, 4000),
    source: 'ashby', fetched_at: now(),
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, lever: parseLever, ashby: parseAshby };

async function enrichGreenhouseDescriptions(jobs, boardToken) {
  const enriched = [];
  for (const job of jobs) {
    const ghId = job.url.match(/(\d+)(?:[?#]|$)/)?.[1];
    if (!ghId || !boardToken) { enriched.push(job); continue; }
    try {
      const detail = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs/${ghId}`);
      enriched.push({ ...job, description: stripHtml(detail.content || '').slice(0, 4000) });
    } catch { enriched.push(job); }
  }
  return enriched;
}

async function parallelFetch(tasks, limit = 8) {
  const results = []; let i = 0;
  async function next() { while (i < tasks.length) results.push(await tasks[i++]()); }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
  return results.flat();
}

function makeTitleFilter(keywords) {
  if (!keywords.length) return () => true;
  return (title) => keywords.some(k => title.toLowerCase().includes(k));
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchAllJobs(companies = config.portals) {
  const titleFilter   = makeTitleFilter(config.titleKeywords, config.titleExclude || []);
  const companyFilter = makeCompanyFilter(config.companyBlocklist || []);

  // 1. Broad remote job platforms (no company list needed)
  const [jobicyJobs, wwrJobs] = await Promise.all([
    fetchJobicy(),
    fetchWeWorkRemotely(),
  ]);

  const platformJobs = [...jobicyJobs, ...wwrJobs]
    .filter(j => titleFilter(j.title) && companyFilter(j.company));
  console.log(`Platform jobs matching title filter: ${platformJobs.length}`);

  // 2. Specific company boards (Greenhouse / Lever / Ashby)
  const targets = companies
    .filter(c => c.enabled !== false)
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  console.log(`Fetching from ${targets.length} company boards`);

  const errors = [];
  const companyJobs = await parallelFetch(
    targets.map(company => async () => {
      const { type, url, boardToken } = company._api;
      try {
        const json = await fetchJson(url);
        let jobs = PARSERS[type](json, company.name);
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

  const allJobs = [...platformJobs, ...companyJobs];
  console.log(`Total: ${allJobs.length} jobs fetched (${errors.length} company board errors)`);
  return allJobs;
}
