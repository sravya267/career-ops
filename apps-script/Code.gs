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
  minScore:        65,
  cvFolderId:      '',
  cvTemplateName:  'career-ops CV Template',
  dataSourceSheet: 'jobs',           // name of the BigQuery connector sheet tab
  dashboardSheet:  'Jobs Dashboard', // regular sheet the script reads/writes

  // Column positions as they come from the BigQuery connector (1-based)
  cols: {
    company:   1,   // A
    role:      2,   // B
    url:       3,   // C
    location:  4,   // D
    score:     5,   // E
    remote:    6,   // F
    seniority: 10,  // J
    missing:   11,  // K
  },
};

// ── Menu ──────────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Career Ops')
    .addItem('↻  Copy data to dashboard',       'copyToDashboard')
    .addItem('⚡ Generate CV for selected row',  'generateCVForSelectedRow')
    .addItem('⚡ Generate all CVs (score ≥ ' + CONFIG.minScore + ')', 'generateAllCVs')
    .addToUi();
}

// Copies data from the locked DataSource sheet into a regular editable sheet.
function copyToDashboard() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var src = ss.getSheetByName(CONFIG.dataSourceSheet);
  if (!src) {
    SpreadsheetApp.getUi().alert(
      'DataSource sheet "' + CONFIG.dataSourceSheet + '" not found.\n' +
      'Check that CONFIG.dataSourceSheet matches your BigQuery connector tab name.'
    );
    return;
  }

  var dst = ss.getSheetByName(CONFIG.dashboardSheet) || ss.insertSheet(CONFIG.dashboardSheet);
  dst.clearContents();

  var values = src.getDataRange().getValues();
  dst.getRange(1, 1, values.length, values[0].length).setValues(values);

  // Add CV link column header
  var cvCol = values[0].length + 1;
  dst.getRange(1, cvCol).setValue('CV Link');

  // Style header row
  dst.getRange(1, 1, 1, cvCol).setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff');
  dst.setFrozenRows(1);

  SpreadsheetApp.getUi().alert('Copied ' + (values.length - 1) + ' rows to "' + CONFIG.dashboardSheet + '".');
}

// ── CV Generation ─────────────────────────────────────────────────────────────

function generateCVForSelectedRow() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.dashboardSheet);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('Run "Copy data to dashboard" first.');
    return;
  }

  // Make sure the user is viewing the dashboard sheet so their row selection is correct
  if (ss.getActiveSheet().getName() !== CONFIG.dashboardSheet) {
    ss.setActiveSheet(sheet);
    SpreadsheetApp.getUi().alert(
      'Switched to "' + CONFIG.dashboardSheet + '".\n' +
      'Click on any job row, then run this menu item again.'
    );
    return;
  }

  var row = sheet.getActiveRange().getRow();
  if (row < 2) {
    SpreadsheetApp.getUi().alert('Click on a job row (not the header), then try again.');
    return;
  }

  var data  = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  var cvCol = sheet.getLastColumn(); // CV link goes in the last column
  var url   = _generateCV(data);
  sheet.getRange(row, cvCol).setFormula('=HYPERLINK("' + url + '","CV →")');
  SpreadsheetApp.getUi().alert('CV created!');
}

function generateAllCVs() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.dashboardSheet);
  if (!sheet || sheet.getLastRow() < 2) {
    SpreadsheetApp.getUi().alert('Run "Copy data to dashboard" first.');
    return;
  }

  var lastRow   = sheet.getLastRow();
  var lastCol   = sheet.getLastColumn();
  var allData   = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var generated = 0;

  allData.forEach(function(row, i) {
    var score  = parseFloat(row[CONFIG.cols.score - 1]) || 0;
    var cvLink = row[lastCol - 1]; // last column = CV link
    if (cvLink || score < CONFIG.minScore) return;
    try {
      var url = _generateCV(row);
      sheet.getRange(i + 2, lastCol).setFormula('=HYPERLINK("' + url + '","CV →")');
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
    company:   String(row[c.company   - 1] || ''),
    role:      String(row[c.role      - 1] || ''),
    url:       String(row[c.url       - 1] || ''),
    location:  String(row[c.location  - 1] || 'Remote'),
    score:     String(row[c.score     - 1] || ''),
    remote:    String(row[c.remote    - 1] || ''),
    seniority: String(row[c.seniority - 1] || ''),
    missing:   String(row[c.missing   - 1] || ''),
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
