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
  { name: 'missing_skills',   type: 'STRING'  },
  { name: 'salary_mentioned', type: 'BOOLEAN' },
  { name: 'remote',           type: 'STRING'  },
  { name: 'wlb_signals',      type: 'STRING'  },
  { name: 'ai_proof',         type: 'BOOLEAN' },
  { name: 'stability',        type: 'STRING'  },
  { name: 'seniority',        type: 'STRING'  },
  { name: 'summary',          type: 'STRING'  },
  { name: 'cv_url',           type: 'STRING'  },
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
  await addColumnIfMissing(config.bqScoresTable, 'cv_url', 'STRING');
}

async function ensureTable(name, schema) {
  const table = dataset().table(name);
  const [exists] = await table.exists();
  if (!exists) {
    await table.create({ schema });
    console.log(`Created table ${config.bqDataset}.${name}`);
  }
}

// Adds a NULLABLE column to an existing table without recreating it.
async function addColumnIfMissing(tableName, columnName, columnType) {
  const table = dataset().table(tableName);
  const [exists] = await table.exists();
  if (!exists) return;
  try {
    const [meta] = await table.getMetadata();
    if (!meta.schema.fields.some(f => f.name === columnName)) {
      meta.schema.fields.push({ name: columnName, type: columnType, mode: 'NULLABLE' });
      await table.setMetadata(meta);
      console.log(`Migrated ${tableName}: added column ${columnName}`);
    }
  } catch (err) {
    console.warn(`Migration warning (${columnName}):`, err.message);
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

// Returns scored jobs that still need a CV (score >= threshold, no cv_url yet).
export async function getJobsNeedingCv(minScore = config.cvMinScore, limit = config.cvBatchSize) {
  const [rows] = await bq().query({
    query: `
      SELECT j.id, j.url, j.company, j.title, j.location,
             s.score, s.remote, s.seniority, s.missing_skills
      FROM \`${config.bqProject}.${config.bqDataset}.${config.bqJobsTable}\` j
      JOIN  \`${config.bqProject}.${config.bqDataset}.${config.bqScoresTable}\` s
        ON  j.id = s.job_id
      WHERE s.score >= ${minScore}
        AND (s.cv_url IS NULL OR s.cv_url = '')
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

// Updates cv_url for previously-scored rows using DML (safe for non-streaming rows).
export async function updateCvUrls(cvResults) {
  const valid = cvResults.filter(r => r.cv_url);
  if (!valid.length) return;

  for (const { job_id, cv_url } of valid) {
    try {
      await bq().query({
        query: `
          UPDATE \`${config.bqProject}.${config.bqDataset}.${config.bqScoresTable}\`
          SET    cv_url = @cv_url
          WHERE  job_id = @job_id
        `,
        params:      { cv_url, job_id },
        useLegacySql: false,
      });
    } catch (err) {
      console.error(`  [cv] updateCvUrl failed for ${job_id}: ${err.message}`);
    }
  }
  console.log(`Updated cv_url for ${valid.length} rows`);
}
