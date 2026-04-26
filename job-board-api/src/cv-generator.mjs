import { google } from 'googleapis';
import { config } from './config.mjs';

let _authClient;

async function authClient() {
  if (!_authClient) {
    const auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/documents',
      ],
    });
    _authClient = await auth.getClient();
  }
  return _authClient;
}

function buildReplaceRequests(job) {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const map = {
    '{{COMPANY}}':   job.company       || '',
    '{{ROLE}}':      job.title         || '',
    '{{DATE}}':      date,
    '{{LOCATION}}':  job.location      || 'Remote',
    '{{REMOTE}}':    job.remote        || '',
    '{{SENIORITY}}': job.seniority     || '',
    '{{SCORE}}':     String(job.score  || ''),
    '{{APPLY_URL}}': job.url           || '',
    '{{MISSING}}':   job.missing_skills
      ? 'Skills to highlight: ' + job.missing_skills
      : '',
  };
  return Object.entries(map).map(([find, replace]) => ({
    replaceAllText: {
      containsText: { text: find, matchCase: false },
      replaceText:  replace,
    },
  }));
}

export async function generateCV(job) {
  const client = await authClient();
  const drive  = google.drive({ version: 'v3', auth: client });
  const docs   = google.docs({ version: 'v1', auth: client });

  const docName = `CV — ${job.company} — ${job.title}`;

  // 1. Copy the template into the output folder
  const { data: copy } = await drive.files.copy({
    fileId:      config.cvTemplateDocId,
    requestBody: {
      name:    docName,
      ...(config.cvFolderId ? { parents: [config.cvFolderId] } : {}),
    },
    fields: 'id',
  });
  const docId = copy.id;

  // 2. Fill in job-specific placeholders
  await docs.documents.batchUpdate({
    documentId:  docId,
    requestBody: { requests: buildReplaceRequests(job) },
  });

  // 3. Make the doc public so the export URL is shareable
  await drive.permissions.create({
    fileId:      docId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  // Return a direct PDF download URL — works for any public Google Doc
  return `https://docs.google.com/document/d/${docId}/export?format=pdf`;
}

export async function generateCvBatch(jobs) {
  if (!config.cvTemplateDocId) {
    console.log('[cv] CV_TEMPLATE_DOC_ID not set — skipping CV generation');
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
    await new Promise(r => setTimeout(r, 500)); // respect Drive API rate limits
  }
  return results;
}
