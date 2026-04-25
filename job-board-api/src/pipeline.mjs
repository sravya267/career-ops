import { fetchAllJobs }                                           from './fetchers.mjs';
import { scoreBatch }                                              from './scorer.mjs';
import { ensureSchema, getExistingJobIds, insertJobs, insertScores, getUnscoredJobs } from './storage.mjs';
import { config }                                                  from './config.mjs';

export async function runPipeline() {
  const startedAt = Date.now();
  console.log(`\n[pipeline] started ${new Date().toISOString()}`);

  // 1. Ensure BigQuery tables exist
  await ensureSchema();

  // 2. Fetch all matching jobs from configured portals
  const allJobs = await fetchAllJobs();
  if (!allJobs.length) {
    console.log('[pipeline] no jobs fetched — check portals config');
    return { fetched: 0, new: 0, scored: 0, durationMs: Date.now() - startedAt };
  }

  // 3. Deduplicate against BigQuery
  const existingIds = await getExistingJobIds();
  const newJobs = allJobs.filter(j => !existingIds.has(j.id));
  console.log(`[pipeline] ${newJobs.length} new jobs (${allJobs.length - newJobs.length} dupes skipped)`);

  // 4. Store new jobs
  if (newJobs.length) await insertJobs(newJobs);

  // 5. Score unscored jobs (respects daily quota via rate limiter in scorer.mjs)
  const unscoredJobs = await getUnscoredJobs(config.maxJobsPerRun);
  const scores = config.geminiKey
    ? await scoreBatch(unscoredJobs)
    : (console.log('[pipeline] GEMINI_API_KEY not set — skipping scoring'), []);

  // 6. Persist scores
  if (scores.length) await insertScores(scores);

  const duration = Date.now() - startedAt;
  console.log(`[pipeline] done in ${duration}ms — fetched=${allJobs.length} new=${newJobs.length} scored=${scores.length}`);

  return { fetched: allJobs.length, new: newJobs.length, scored: scores.length, durationMs: duration };
}
