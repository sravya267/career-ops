import { readFileSync, existsSync } from 'fs';

export const config = {
  port:             parseInt(process.env.PORT            || '8080'),
  geminiKey:        process.env.GEMINI_API_KEY           || '',
  geminiModel:      process.env.GEMINI_MODEL             || 'gemini-2.5-flash',
  bqProject:        process.env.BQ_PROJECT               || '',
  bqDataset:        process.env.BQ_DATASET               || 'career_ops',
  bqJobsTable:      process.env.BQ_JOBS_TABLE            || 'jobs',
  bqScoresTable:    process.env.BQ_SCORES_TABLE          || 'scores',
  candidateProfile: process.env.CANDIDATE_PROFILE        || '',
  titleKeywords:    parseCsv(process.env.TITLE_KEYWORDS  || 'data engineer,data scientist,cloud engineer,ml engineer,ai engineer,analytics engineer,data platform,analytics consultant,machine learning,data science,data analytics,mlops,etl,snowflake,databricks,bigquery'),
  titleExclude:     parseCsv(process.env.TITLE_EXCLUDE   || 'manager,director,vp,vice president,head of,chief,staff manager,engineering manager'),
  companyBlocklist: parseCsv(process.env.COMPANY_BLOCKLIST || 'meta,facebook,google,amazon,apple,netflix,microsoft,uber,lyft,airbnb,tiktok,bytedance,twitter,x corp'),
  maxJobsPerRun:    parseInt(process.env.MAX_JOBS_PER_RUN || '50'),
  fetchTimeoutMs:   parseInt(process.env.FETCH_TIMEOUT_MS || '40000'),
  fetchDescriptions: process.env.FETCH_DESCRIPTIONS === 'true',
  portals:          loadPortals(),

  // CV generation — set CV_BUCKET_NAME to enable (GCS bucket, publicly readable)
  generateCvs:     process.env.GENERATE_CVS === 'true',
  cvMinScore:      parseInt(process.env.CV_MIN_SCORE  || '65'),
  cvBucketName:    process.env.CV_BUCKET_NAME         || '',
  cvBatchSize:     parseInt(process.env.CV_BATCH_SIZE || '10'),
};

function parseCsv(str) {
  return str.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function loadPortals() {
  if (process.env.PORTALS_JSON) {
    try { return JSON.parse(process.env.PORTALS_JSON); } catch { /* fall through */ }
  }
  const path = process.env.PORTALS_FILE || new URL('../portals.json', import.meta.url).pathname;
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }
  return [];
}
