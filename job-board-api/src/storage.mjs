import { BigQuery } from '@google-cloud/bigquery';
import { config } from './config.mjs';

let _bq;
function bq() {
  if (!_bq) _bq = new BigQuery({ projectId: config.bqProject });
  return _bq;
}

function dataset() { return bq().dataset(config.bqDataset); }

// ── Schema ────────────────────────────────────────────────────────────────────

const JOBS_SCHEMA = [
  { name: 'id',          type: 'STRING',    mode: 'REQUIRED' },
  { name: 'url',         type: 'STRING',    mode: 'REQUIRED' },
  { name: 'company',     type: 'STRING' },
  { name: 'title',       type: 'STRING' },
  { name: 'location',    type: 'STRING' },
  { name: 'description', type: 'STRING' },
  { name: 'source',      type: 'STRING' },
  { name: 'fetched_at',  type: 'TIMESTAMP' },
];

const SCORES_SCHEMA = [
  { name: 'job_id',           type: 'STRING',  mode: 'REQUIRED' },
  { name: 'score',            type: 'INTEGER' },
  { name: 'missing_skills',   type: 'STRING'  },  // comma-separated for simplicity
  { name: 'salary_mentioned', type: 'BOOLEAN' },
  { name: 'remote',           type: 'STRING'  },
  { name: 'seniority',        type: 'STRING'  },
  { name: 'summary',          type: 'STRING'  },
  { name: 'scored_at',        type: 'TIMESTAMP' },
];

// ── Setup ─────────────────────────────────────────────────────────────────────

export async function ensureSchema() {
  const [dsExists] = await dataset().exists();
  if (!dsExists) {
    await bq().createDataset(config.bqDataset, { location: 'US' });
    console.log(`Created dataset ${config.bqDataset}`);
  }
  await ensureTable(config.bqJobsTable,   JOBS_SCHEMA);
  await ensureTable(config.bqScoresTable, SCORES_SCHEMA);
}

async function ensureTable(name, schema) {
  const table = dataset().table(name);
  const [exists] = await table.exists();
  if (!exists) {
    await table.create({ schema });
    console.log(`Created table ${config.bqDataset}.${name}`);
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function getExistingJobIds() {
  try {
    const [rows] = await bq().query({
      query:         `SELECT id FROM \`${config.bqProject}.${config.bqDataset}.${config.bqJobsTable}\``,
      useLegacySql:  false,
    });
    return new Set(rows.map(r => r.id));
  } catch {
    return new Set();
  }
}

export async function getUnscoredJobs(limit = config.maxJobsPerRun) {
  const [rows] = await bq().query({
    query: `
      SELECT j.id, j.url, j.company, j.title, j.location, j.description
      FROM \`${config.bqProject}.${config.bqDataset}.${config.bqJobsTable}\` j
      LEFT JOIN \`${config.bqProject}.${config.bqDataset}.${config.bqScoresTable}\` s
        ON j.id = s.job_id
      WHERE s.job_id IS NULL
      ORDER BY j.fetched_at DESC
      LIMIT ${limit}
    `,
    useLegacySql: false,
  });
  return rows;
}

export async function getTopJobs(minScore = 60, limit = 100) {
  const [rows] = await bq().query({
    query: `
      SELECT
        j.id, j.url, j.company, j.title, j.location,
        s.score, s.remote, s.seniority, s.missing_skills,
        s.salary_mentioned, s.summary, s.scored_at
      FROM \`${config.bqProject}.${config.bqDataset}.${config.bqJobsTable}\` j
      JOIN \`${config.bqProject}.${config.bqDataset}.${config.bqScoresTable}\` s
        ON j.id = s.job_id
      WHERE s.score >= ${minScore}
      ORDER BY s.score DESC
      LIMIT ${limit}
    `,
    useLegacySql: false,
  });
  return rows;
}

// ── Writes ────────────────────────────────────────────────────────────────────

export async function insertJobs(jobs) {
  if (!jobs.length) return;
  await dataset().table(config.bqJobsTable).insert(jobs);
  console.log(`Inserted ${jobs.length} jobs into BigQuery`);
}

export async function insertScores(scores) {
  if (!scores.length) return;
  await dataset().table(config.bqScoresTable).insert(scores);
  console.log(`Inserted ${scores.length} scores into BigQuery`);
}
