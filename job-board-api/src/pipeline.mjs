import { fetchAllJobs }                                                                  from './fetchers.mjs';
import { scoreBatch }                                                                   from './scorer.mjs';
import { generateCvBatch }                                                              from './cv-generator.mjs';
import { ensureSchema, getExistingJobIds, insertJobs, insertScores,
         getUnscoredJobs, getJobsNeedingCv, updateCvUrls }                             from './storage.mjs';
import { config }                                                                       from './config.mjs';

export async function runPipeline() {
  const startedAt = Date.now();
  console.log(`\n[pipeline] started ${new Date().toISOString()}`);

  // 1. Ensure BigQuery tables exist (also migrates cv_url column if needed)
  await ensureSchema();

  // 2. Fetch all matching jobs from configured portals
  const allJobs = await fetchAllJobs();
  if (!allJobs.length) {
    console.log('[pipeline] no jobs fetched — check portals config');
    return { fetched: 0, new: 0, scored: 0, cvs: 0, durationMs: Date.now() - startedAt };
  }

  // 3. Deduplicate against BigQuery
  const existingIds = await getExistingJobIds();
  const newJobs = allJobs.filter(j => !existingIds.has(j.id));
  console.log(`[pipeline] ${newJobs.length} new jobs (${allJobs.length - newJobs.length} dupes skipped)`);

  // 4. Store new jobs
  if (newJobs.length) await insertJobs(newJobs);

  // 5. Score unscored jobs
  const unscoredJobs = await getUnscoredJobs(config.maxJobsPerRun);
  const scores = config.geminiKey
    ? await scoreBatch(unscoredJobs)
    : (console.log('[pipeline] GEMINI_API_KEY not set — skipping scoring'), []);

  // 6. Generate CVs for high-scoring NEW jobs (before inserting scores so cv_url goes in with the row)
  let cvsGenerated = 0;
  if (config.generateCvs && scores.length) {
    const jobMap = new Map(unscoredJobs.map(j => [j.id, j]));
    const highScoring = scores
      .filter(s => s.score >= config.cvMinScore && s.score > 0)
      .map(s => ({ ...jobMap.get(s.job_id), ...s }))
      .filter(j => j.id);

    if (highScoring.length) {
      console.log(`[pipeline] generating CVs for ${highScoring.length} high-scoring jobs`);
      const cvResults = await generateCvBatch(highScoring);
      const cvMap = new Map(cvResults.filter(r => r.cv_url).map(r => [r.job_id, r.cv_url]));
      for (const s of scores) {
        if (cvMap.has(s.job_id)) s.cv_url = cvMap.get(s.job_id);
      }
      cvsGenerated += cvMap.size;
    }
  }

  // 7. Persist scores (cv_url included where generated)
  if (scores.length) await insertScores(scores);

  // 8. Backfill CVs for previously-scored jobs that don't have one yet
  if (config.generateCvs && config.cvTemplateDocId) {
    const needCv = await getJobsNeedingCv();
    if (needCv.length) {
      console.log(`[pipeline] backfilling CVs for ${needCv.length} existing jobs`);
      const cvResults = await generateCvBatch(needCv);
      await updateCvUrls(cvResults);
      cvsGenerated += cvResults.filter(r => r.cv_url).length;
    }
  }

  const duration = Date.now() - startedAt;
  console.log(`[pipeline] done in ${duration}ms — fetched=${allJobs.length} new=${newJobs.length} scored=${scores.length} cvs=${cvsGenerated}`);

  return { fetched: allJobs.length, new: newJobs.length, scored: scores.length, cvs: cvsGenerated, durationMs: duration };
}

// Called by POST /run-cvs — generates CVs for all scored jobs that don't have one.
export async function runCvBackfill() {
  await ensureSchema();
  const jobs = await getJobsNeedingCv(config.cvMinScore, 50);
  if (!jobs.length) return { cvs: 0, message: 'no jobs need CVs' };

  console.log(`[cvs] backfilling ${jobs.length} jobs`);
  const results = await generateCvBatch(jobs);
  await updateCvUrls(results);
  const done = results.filter(r => r.cv_url).length;
  return { cvs: done, total: jobs.length };
}
