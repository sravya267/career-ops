// career-ops — Google Apps Script (CV Generator)
// Data comes from the BigQuery connector — this script only generates CVs.
//
// Setup:
//   1. Open Google Sheets → Extensions → Apps Script
//   2. Paste this file as Code.gs
//   3. Run onOpen() once to add the Career Ops menu
//   4. Update CONFIG below if needed

// ── Config ────────────────────────────────────────────────────────────────────

var CONFIG = {
  minScore:       65,    // only generate CVs for jobs at or above this score
  cvFolderId:     '',    // Drive folder ID for CVs ('' = creates "career-ops CVs" folder)
  cvTemplateName: 'career-ops CV Template',

  // Column positions in your sheet (1-based).
  // Match these to the order in your BigQuery connector query.
  cols: {
    company:  1,   // A
    role:     2,   // B
    url:      3,   // C
    location: 4,   // D
    score:    5,   // E
    remote:   6,   // F
    seniority: 10, // J
    missing:  11,  // K
    cvLink:   13,  // M  ← where the script writes the CV link
  },
};

// ── Menu ──────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Career Ops')
    .addItem('⚡ Generate CV for selected row', 'generateCVForSelectedRow')
    .addItem('⚡ Generate CVs for all rows (score ≥ ' + CONFIG.minScore + ')', 'generateAllCVs')
    .addToUi();
}

// ── CV Generation ─────────────────────────────────────────────────────────────

function generateCVForSelectedRow() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var row   = sheet.getActiveRange().getRow();
  if (row < 2) {
    SpreadsheetApp.getUi().alert('Select a data row first (not the header).');
    return;
  }
  var data = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  var url  = _generateCV(data);
  sheet.getRange(row, CONFIG.cols.cvLink).setFormula('=HYPERLINK("' + url + '","CV →")');
  SpreadsheetApp.getUi().alert('CV created! Check column ' + CONFIG.cols.cvLink + '.');
}

function generateAllCVs() {
  var sheet     = SpreadsheetApp.getActiveSheet();
  var lastRow   = sheet.getLastRow();
  if (lastRow < 2) { SpreadsheetApp.getUi().alert('No data rows found.'); return; }

  var allData   = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  var generated = 0;

  allData.forEach(function(row, i) {
    var score  = parseFloat(row[CONFIG.cols.score - 1]) || 0;
    var cvLink = row[CONFIG.cols.cvLink - 1];
    if (cvLink || score < CONFIG.minScore) return;

    try {
      var url = _generateCV(row);
      sheet.getRange(i + 2, CONFIG.cols.cvLink).setFormula('=HYPERLINK("' + url + '","CV →")');
      generated++;
    } catch (e) {
      Logger.log('CV error row ' + (i + 2) + ': ' + e.message);
    }
    Utilities.sleep(1500);
  });

  SpreadsheetApp.getUi().alert('Generated ' + generated + ' CVs.');
}

function _generateCV(row) {
  var c = CONFIG.cols;
  var job = {
    company:   String(row[c.company  - 1] || ''),
    role:      String(row[c.role     - 1] || ''),
    url:       String(row[c.url      - 1] || ''),
    location:  String(row[c.location - 1] || 'Remote'),
    score:     String(row[c.score    - 1] || ''),
    remote:    String(row[c.remote   - 1] || ''),
    seniority: String(row[c.seniority- 1] || ''),
    missing:   String(row[c.missing  - 1] || ''),
  };

  var templateFile = _getOrCreateTemplate();
  var folder       = _getOutputFolder();
  var docName      = 'CV — ' + job.company + ' — ' + job.role;
  var date         = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMMM yyyy');

  // Trash any existing doc with same name
  var existing = folder.getFilesByName(docName);
  while (existing.hasNext()) existing.next().setTrashed(true);

  var docFile = templateFile.makeCopy(docName, folder);
  var doc     = DocumentApp.openById(docFile.getId());
  var body    = doc.getBody();

  body.replaceText('\\{\\{COMPANY\\}\\}',   job.company);
  body.replaceText('\\{\\{ROLE\\}\\}',      job.role);
  body.replaceText('\\{\\{DATE\\}\\}',      date);
  body.replaceText('\\{\\{LOCATION\\}\\}',  job.location);
  body.replaceText('\\{\\{REMOTE\\}\\}',    job.remote);
  body.replaceText('\\{\\{SENIORITY\\}\\}', job.seniority);
  body.replaceText('\\{\\{SCORE\\}\\}',     job.score);
  body.replaceText('\\{\\{APPLY_URL\\}\\}', job.url);
  body.replaceText('\\{\\{MISSING\\}\\}',
    job.missing ? 'Skills to highlight: ' + job.missing : '');

  doc.saveAndClose();

  var pdfBlob = DriveApp.getFileById(docFile.getId()).getAs('application/pdf');
  var pdfName = docName + '.pdf';
  var existingPdf = folder.getFilesByName(pdfName);
  while (existingPdf.hasNext()) existingPdf.next().setTrashed(true);

  var pdfFile = folder.createFile(pdfBlob.setName(pdfName));
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return pdfFile.getUrl();
}

function _getOutputFolder() {
  if (CONFIG.cvFolderId) return DriveApp.getFolderById(CONFIG.cvFolderId);
  var folders = DriveApp.getFoldersByName('career-ops CVs');
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder('career-ops CVs');
}

function _getOrCreateTemplate() {
  var files = DriveApp.getFilesByName(CONFIG.cvTemplateName);
  if (files.hasNext()) return files.next();

  var doc  = DocumentApp.create(CONFIG.cvTemplateName);
  var body = doc.getBody();
  body.appendParagraph('{{COMPANY}} — {{ROLE}}').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('{{DATE}}  |  {{SENIORITY}}  |  {{REMOTE}}');
  body.appendParagraph('');
  body.appendParagraph('Dear Hiring Team,').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(
    'I am applying for the {{ROLE}} position at {{COMPANY}} ({{LOCATION}}).\n\n' +
    '{{MISSING}}\n\n' +
    '[Replace this with your CV / cover note content. Keep the {{PLACEHOLDERS}} where you want job-specific text to appear automatically.]'
  );
  body.appendParagraph('');
  body.appendParagraph('Apply: {{APPLY_URL}}');
  doc.saveAndClose();

  SpreadsheetApp.getUi().alert(
    'A starter CV template "' + CONFIG.cvTemplateName + '" was created in your Drive.\n\n' +
    'Open it and replace the placeholder text with your real CV content.\n' +
    'Keep the {{PLACEHOLDERS}} — they get filled in per job automatically.'
  );
  return DriveApp.getFileById(doc.getId());
}
