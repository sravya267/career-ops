import { readFileSync } from 'fs';
import { Storage } from '@google-cloud/storage';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { config } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '../cv-template.html');

function loadTemplate() {
  return readFileSync(TEMPLATE_PATH, 'utf-8');
}

function fillTemplate(html, job) {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return html
    .replace(/\{\{COMPANY\}\}/g,   job.company       || '')
    .replace(/\{\{ROLE\}\}/g,      job.title         || '')
    .replace(/\{\{DATE\}\}/g,      date)
    .replace(/\{\{LOCATION\}\}/g,  job.location      || 'Remote')
    .replace(/\{\{REMOTE\}\}/g,    job.remote        || '')
    .replace(/\{\{SENIORITY\}\}/g, job.seniority     || '')
    .replace(/\{\{SCORE\}\}/g,     String(job.score  || ''))
    .replace(/\{\{APPLY_URL\}\}/g, job.url           || '')
    .replace(/\{\{MISSING\}\}/g,   job.missing_skills
      ? 'Skills to highlight: ' + job.missing_skills
      : '');
}

function safeSlug(str, max = 40) {
  return (str || '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max);
}

export async function generateCV(job) {
  if (!config.cvBucketName) throw new Error('CV_BUCKET_NAME env var not set');

  const html     = fillTemplate(loadTemplate(), job);
  const storage  = new Storage();
  const bucket   = storage.bucket(config.cvBucketName);
  const fileName = `cvs/${safeSlug(job.company)}-${safeSlug(job.title)}.html`;

  await bucket.file(fileName).save(html, {
    contentType: 'text/html; charset=utf-8',
    public: true,
    metadata: { cacheControl: 'no-cache' },
  });

  return `https://storage.googleapis.com/${config.cvBucketName}/${fileName}`;
}

export async function generateCvBatch(jobs) {
  if (!config.cvBucketName) {
    console.log('[cv] CV_BUCKET_NAME not set — skipping CV generation');
    return [];
  }

  const results = [];
  for (const job of jobs) {
    try {
      const url = await generateCV(job);
      results.push({ job_id: job.id, cv_url: url });
      console.log(`  [cv] ${job.company}/${job.title}`);
    } catch (err) {
      console.error(`  [cv] failed ${job.company}/${job.title}: ${err.message}`);
      results.push({ job_id: job.id, cv_url: null });
    }
  }
  return results;
}
