// career-ops — Google Apps Script
// Reads scored jobs from BigQuery → Google Sheets dashboard → generates CVs as Docs/PDFs.
//
// Setup:
//   1. Open Google Sheets → Extensions → Apps Script
//   2. Paste this file as Code.gs
//   3. Paste appsscript.json into the manifest (Project Settings → Show manifest)
//   4. Enable BigQuery Advanced Service (Services → BigQuery API)
//   5. Update CONFIG below
//   6. Run onOpen() once to add the Career Ops menu

// ── Config ────────────────────────────────────────────────────────────────────

var CONFIG = {
  bqProject:     'your-gcp-project-id',   // ← update
  bqDataset:     'career_ops',
  bqJobsTable:   'jobs',
  bqScoresTable: 'scores',
  minScore:      65,                        // only show jobs scoring 65+
  maxJobs:       100,
  cvFolderId:    '',                        // Drive folder ID for CVs ('' = root)
  sheetName:     'Jobs Dashboard',
  cvTemplateName:'career-ops CV Template', // name of your CV template Google Doc
};

// ── Menu ──────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Career Ops')
    .addItem('↻  Refresh dashboard',      'updateDashboard')
    .addItem('⚡ Generate CVs (top jobs)', 'generateCVs')
    .addItem('▶  Refresh + Generate',      'runAll')
    .addSeparator()
    .addItem('⚙  Open config',            'openConfig')
    .addToUi();
}

// ── BigQuery ──────────────────────────────────────────────────────────────────

function queryBigQuery(sql) {
  var request = { query: sql, useLegacySql: false, timeoutMs: 60000 };
  var response = BigQuery.Jobs.query(CONFIG.bqProject, request);

  if (!response.jobComplete) {
    // Poll until done (rare for small queries)
    var jobId = response.jobReference.jobId;
    for (var i = 0; i < 30; i++) {
      Utilities.sleep(2000);
      response = BigQuery.Jobs.getQueryResults(CONFIG.bqProject, jobId);
      if (response.jobComplete) break;
    }
  }

  if (!response.rows) return [];

  var fields = response.schema.fields.map(function(f) { return f.name; });
  return response.rows.map(function(row) {
    var obj = {};
    row.f.forEach(function(cell, i) { obj[fields[i]] = cell.v; });
    return obj;
  });
}

function getTopJobs() {
  var sql = [
    'SELECT',
    '  j.id, j.url, j.company, j.title, j.location,',
    '  s.score, s.remote, s.seniority, s.missing_skills,',
    '  s.salary_mentioned, s.summary',
    'FROM `' + CONFIG.bqProject + '.' + CONFIG.bqDataset + '.' + CONFIG.bqJobsTable + '` j',
    'JOIN `' + CONFIG.bqProject + '.' + CONFIG.bqDataset + '.' + CONFIG.bqScoresTable + '` s',
    '  ON j.id = s.job_id',
    'WHERE s.score >= ' + CONFIG.minScore,
    'ORDER BY s.score DESC',
    'LIMIT ' + CONFIG.maxJobs,
  ].join('\n');

  return queryBigQuery(sql);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

var HEADERS = ['#', 'Score', 'Company', 'Role', 'Location', 'Remote', 'Seniority',
               'Missing Skills', 'Summary', 'Apply', 'CV', 'Status', 'Updated'];

function updateDashboard() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.sheetName) || ss.insertSheet(CONFIG.sheetName);

  // Header row
  var headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  headerRange.setValues([HEADERS]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#1a1a2e');
  headerRange.setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  var jobs = getTopJobs();
  if (!jobs.length) {
    SpreadsheetApp.getUi().alert('No jobs found with score ≥ ' + CONFIG.minScore + '. Run the Cloud Run pipeline first.');
    return;
  }

  // Clear old data (keep CV links in col 11)
  var existingCvLinks = {};
  if (sheet.getLastRow() > 1) {
    var existingData = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
    existingData.forEach(function(row) {
      var jobId = row[0]; // we'll use company+role as key
      var key   = (row[2] + '::' + row[3]).toLowerCase();
      if (row[10]) existingCvLinks[key] = row[10];
    });
    sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).clearContent();
  }

  var now  = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var rows = jobs.map(function(job, i) {
    var key     = (job.company + '::' + job.title).toLowerCase();
    var cvLink  = existingCvLinks[key] || '';
    var missing = (job.missing_skills || '').split(',').slice(0, 3).join(', ');
    return [
      i + 1,
      parseInt(job.score) || 0,
      job.company  || '',
      job.title    || '',
      job.location || '',
      job.remote   || 'unclear',
      job.seniority || 'unclear',
      missing,
      job.summary  || '',
      job.url      || '',   // Apply link (col 10 = J)
      cvLink,               // CV link    (col 11 = K)
      'To Review',
      now,
    ];
  });

  sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);

  // Score color coding
  rows.forEach(function(row, i) {
    var score = row[1];
    var cell  = sheet.getRange(i + 2, 2);
    if      (score >= 90) cell.setBackground('#34a853').setFontColor('#fff');
    else if (score >= 80) cell.setBackground('#4285f4').setFontColor('#fff');
    else if (score >= 65) cell.setBackground('#fbbc04').setFontColor('#000');
  });

  // Apply hyperlinks (col 10)
  rows.forEach(function(row, i) {
    var url = row[9];
    if (url) {
      sheet.getRange(i + 2, 10).setFormula('=HYPERLINK("' + url + '","Apply →")');
    }
  });

  // Column widths
  sheet.setColumnWidth(1, 40);   // #
  sheet.setColumnWidth(2, 60);   // Score
  sheet.setColumnWidth(3, 130);  // Company
  sheet.setColumnWidth(4, 220);  // Role
  sheet.setColumnWidth(5, 120);  // Location
  sheet.setColumnWidth(6, 80);   // Remote
  sheet.setColumnWidth(7, 80);   // Seniority
  sheet.setColumnWidth(8, 200);  // Missing skills
  sheet.setColumnWidth(9, 300);  // Summary
  sheet.setColumnWidth(10, 90);  // Apply
  sheet.setColumnWidth(11, 90);  // CV
  sheet.setColumnWidth(12, 90);  // Status
  sheet.setColumnWidth(13, 100); // Updated

  sheet.autoResizeColumn(9);

  Logger.log('Dashboard updated: ' + jobs.length + ' jobs');
  SpreadsheetApp.getUi().alert('Dashboard updated — ' + jobs.length + ' jobs (score ≥ ' + CONFIG.minScore + ')');
}

// ── CV Generation ─────────────────────────────────────────────────────────────

function generateCVs() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.sheetName);
  if (!sheet || sheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('Run "Refresh dashboard" first.');
    return;
  }

  var data      = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  var generated = 0;

  data.forEach(function(row, i) {
    var score   = parseInt(row[1]) || 0;
    var company = row[2];
    var role    = row[3];
    var cvLink  = row[10];

    // Skip if already generated or below threshold
    if (cvLink || score < CONFIG.minScore) return;

    try {
      var pdfUrl = generateCV({
        company:  company,
        role:     role,
        location: row[4],
        remote:   row[5],
        seniority: row[6],
        missing:  row[7],
        applyUrl: row[9],
        score:    score,
      });
      sheet.getRange(i + 2, 11).setValue(pdfUrl);
      sheet.getRange(i + 2, 11).setFormula('=HYPERLINK("' + pdfUrl + '","CV →")');
      generated++;
    } catch (e) {
      Logger.log('CV failed for ' + company + '/' + role + ': ' + e.message);
    }

    Utilities.sleep(1500); // avoid Drive quota
  });

  SpreadsheetApp.getUi().alert('Generated ' + generated + ' CVs.');
}

function generateCV(job) {
  var templateDoc = getOrCreateTemplate();
  var folder      = getOutputFolder();
  var docName     = 'CV — ' + job.company + ' — ' + job.role;

  // Remove existing doc with same name
  var existing = folder.getFilesByName(docName);
  while (existing.hasNext()) existing.next().setTrashed(true);

  // Copy template → new doc
  var docFile = templateDoc.makeCopy(docName, folder);
  var doc     = DocumentApp.openById(docFile.getId());
  var body    = doc.getBody();

  var date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM yyyy');

  body.replaceText('\\{\\{COMPANY\\}\\}',   job.company  || '');
  body.replaceText('\\{\\{ROLE\\}\\}',      job.role     || '');
  body.replaceText('\\{\\{DATE\\}\\}',      date);
  body.replaceText('\\{\\{LOCATION\\}\\}',  job.location || 'Remote');
  body.replaceText('\\{\\{REMOTE\\}\\}',    job.remote   || 'unclear');
  body.replaceText('\\{\\{SENIORITY\\}\\}', job.seniority || '');
  body.replaceText('\\{\\{SCORE\\}\\}',     String(job.score || ''));
  body.replaceText('\\{\\{APPLY_URL\\}\\}', job.applyUrl || '');
  body.replaceText('\\{\\{MISSING\\}\\}',
    job.missing ? 'Skills to emphasize: ' + job.missing : '');

  doc.saveAndClose();

  // Export as PDF
  var pdfBlob = DriveApp.getFileById(doc.getId()).getAs('application/pdf');
  var pdfName = docName + '.pdf';

  var existingPdf = folder.getFilesByName(pdfName);
  while (existingPdf.hasNext()) existingPdf.next().setTrashed(true);

  var pdfFile = folder.createFile(pdfBlob.setName(pdfName));
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return pdfFile.getUrl();
}

function getOutputFolder() {
  if (CONFIG.cvFolderId) return DriveApp.getFolderById(CONFIG.cvFolderId);
  // Try to find/create a "career-ops CVs" folder in root
  var folders = DriveApp.getFoldersByName('career-ops CVs');
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder('career-ops CVs');
}

function getOrCreateTemplate() {
  var files = DriveApp.getFilesByName(CONFIG.cvTemplateName);
  if (files.hasNext()) return files.next();

  // Create a starter template — replace with your actual CV content
  var doc  = DocumentApp.create(CONFIG.cvTemplateName);
  var body = doc.getBody();

  body.appendParagraph('{{COMPANY}} — Application for {{ROLE}}')
      .setHeading(DocumentApp.ParagraphHeading.HEADING1);

  body.appendParagraph('Date: {{DATE}}  |  Seniority: {{SENIORITY}}  |  Remote: {{REMOTE}}');
  body.appendParagraph('');

  body.appendParagraph('COVER NOTE')
      .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(
    'I am applying for the {{ROLE}} position at {{COMPANY}} ({{LOCATION}}).\n\n' +
    '{{MISSING}}\n\n' +
    '[Replace this section with your actual cover note and CV content.]'
  );

  body.appendParagraph('');
  body.appendParagraph('Apply: {{APPLY_URL}}');

  doc.saveAndClose();
  Logger.log('Created starter CV template: ' + CONFIG.cvTemplateName);
  SpreadsheetApp.getUi().alert(
    'Starter CV template created: "' + CONFIG.cvTemplateName + '".\n\n' +
    'Open it in Google Docs and replace the placeholder content with your actual CV.\n' +
    'Keep the {{PLACEHOLDERS}} where you want job-specific text.'
  );

  return DriveApp.getFileById(doc.getId());
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function runAll() {
  updateDashboard();
  generateCVs();
}

function openConfig() {
  var html = HtmlService.createHtmlOutput(
    '<p>Edit <code>CONFIG</code> at the top of <code>Code.gs</code> to update settings.</p>' +
    '<ul>' +
    '<li><b>bqProject</b>: ' + CONFIG.bqProject + '</li>' +
    '<li><b>minScore</b>: ' + CONFIG.minScore + '</li>' +
    '<li><b>maxJobs</b>: ' + CONFIG.maxJobs + '</li>' +
    '</ul>'
  ).setWidth(400).setHeight(200);
  SpreadsheetApp.getUi().showModalDialog(html, 'Career Ops Config');
}

// ── Time-based trigger (optional) ─────────────────────────────────────────────
// Run this once to set up auto-refresh every 6 hours:
//
// function setupTrigger() {
//   ScriptApp.newTrigger('updateDashboard')
//     .timeBased()
//     .everyHours(6)
//     .create();
// }
