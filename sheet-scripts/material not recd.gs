const NR_EMAIL = "rohit@summithotels.in";
const NR_SHEET_ID = "1FYI-Mj44MXeu-YN4qiQMErPsm9jVE97vePxw3gu-QeY"; // Copy of NONLOCAL PURCHASES
const NR_START_YEAR = 2026;                 // year of first row in FMS
const NR_FROM_DATE = new Date(2026, 3, 1);  // 1 April 2026
const NR_TZ = "Asia/Kolkata";


// Cluster, Unit name shown in report, and words used to recognise the unit in FMS
const NR_UNIT_MAP = [
  ["Arunachal Pradesh", "DIRANG",        ["dirang"]],
  ["Assam",             "Green",         ["green"]],
  ["Darjeeling",        "Bougainvillea", ["bougainvillea"]],
  ["Darjeeling",        "Enigma",        ["enigma"]],
  ["Darjeeling",        "Grace",         ["grace"]],
  ["Darjeeling",        "Hermon",        ["hermon"]],
  ["Darjeeling",        "Mall Stone",    ["mallstone", "mall"]],
  ["Darjeeling",        "Montana",       ["montana"]],
  ["Darjeeling",        "Oakdene",       ["oakden"]],
  ["Darjeeling",        "POSHTEL",       ["poshtel"]],
  ["Darjeeling",        "Swiss",         ["swiss"]],
  ["Darjeeling",        "West Gate",     ["westgate", "west"]],
  ["Gangtok",           "Grand",         ["grand"]],
  ["Gangtok",           "Namnang",       ["namnang"]],
  ["Gangtok",           "Norling",       ["norling"]],
  ["Gangtok",           "North Star",    ["northstar"]],
  ["Gangtok",           "Signature",     ["signature"]],
  ["Gangtok",           "Ttakshang",     ["ttakshang"]],
  ["Goa",               "Calangute",     ["calangute"]],
  ["HP",                "Le Royale",     ["royale"]],
  ["Kalimpong",         "Barsana",       ["barsana"]],
  ["Kalimpong",         "Samthar",       ["samthar"]],
  ["Kalimpong",         "Sherpa",        ["sherpa"]],
  ["North Sikkim",      "Gangchen",      ["gangchen"]],
  ["North Sikkim",      "Khangri",       ["khangri"]],
  ["North Sikkim",      "Panghen",       ["panghen"]],
  ["Pelling",           "Newa",          ["newa"]],
  ["Pelling",           "Tashi Ghang",   ["tashi"]],
  ["Siliguri",          "Head Office",   ["headoffice", "head"]],
  ["Siliguri",          "Singalila",     ["singalila"]],
  ["UK",                "Ganges",        ["ganges"]],
  ["UK",                "Jungle",        ["jungle"]],
  ["Rajasthan",         "SALASAR",       ["salasar"]]
];


// ================= MAIN =================
function sendNotReceivedReport() {
  const list = nrGetPendingPOs_();
  const stamp = Utilities.formatDate(new Date(), NR_TZ, "dd-MM-yyyy");
  const matrix = nrMatrixData_(list);
  const attachments = [];


  // Excel file: PO-wise detail
  try {
    attachments.push(nrExcelFile_(list, stamp));
  } catch (e) {
    Logger.log("Excel file failed: " + e);
  }


  // Picture (for WhatsApp) + PDF of the Material Not Received table
  try {
    nrMatrixImage_(matrix, stamp).forEach(a => attachments.push(a));
  } catch (e) {
    Logger.log("Image failed: " + e);
  }


  const html = nrBuildDetailHtml_(list) +
               '<div style="height:30px"></div>' +
               nrBuildMatrixHtml_(matrix);


  MailApp.sendEmail({
    to: NR_EMAIL,
    subject: "Material Not Received Report " + Utilities.formatDate(new Date(), NR_TZ, "dd/MM/yyyy"),
    htmlBody: html,
    attachments: attachments
  });
}


// ================= STEP 1: pending POs =================
function nrGetPendingPOs_() {
  const sh = SpreadsheetApp.openById(NR_SHEET_ID).getSheetByName("FMS");
  if (!sh) throw new Error("Tab FMS not found");
  const n = sh.getLastRow() - 3;
  const rows = sh.getRange(4, 1, n, 33).getValues();
  const stamps = sh.getRange(4, 2, n, 1).getDisplayValues();   // timestamp as shown


  let year = NR_START_YEAR, prevMonth = 1, validDates = 0;
  const pos = {}, order = [], excluded = {};


  rows.forEach((r, i) => {
    const m = String(stamps[i][0]).match(/^(\d{1,2})-(\d{1,2})/);
    if (!m) return;
    validDates++;
    const day = +m[1], mon = +m[2];
    if (prevMonth - mon >= 6) year++;     // new year started
    prevMonth = mon;


    const approved   = String(r[10]).trim().toLowerCase() === "approved";
    const isPO       = String(r[21]).replace(/[\s.]/g, "").toUpperCase() === "PO";
    const noInvoice  = String(r[29]).trim() === "";
    const noReceived = String(r[27]).trim() === "";
    const date = new Date(year, mon - 1, day);
    if (!(approved && isPO && noInvoice && noReceived && date >= NR_FROM_DATE)) return;


    const key = String(r[19]).trim().toUpperCase();   // PO number
    if (!key) return;


    const vendorKey = String(r[32]).toLowerCase().replace(/[^a-z]/g, "");
    if (vendorKey.indexOf("centralstore") !== -1) { excluded[key] = true; return; }


    if (!pos[key]) {
      pos[key] = { po: String(r[19]).trim(), unit: r[2], vendor: r[32],
                   amount: Number(String(r[20]).replace(/[^0-9.]/g, "")) || 0,
                   date: date, items: 0 };
      order.push(key);
    }
    pos[key].items++;
  });


  Logger.log("Rows read: " + rows.length + " | valid dates: " + validDates +
             " | POs found: " + order.length);
  return order.filter(k => !excluded[k]).map(k => pos[k]);
}


// ================= REPORT: PO-wise detail =================
function nrBuildDetailHtml_(list) {
  let total = 0;
  list.forEach(p => { total += p.amount; });


  const fmt = d => Utilities.formatDate(d, NR_TZ, "dd-MMM-yy");
  const today = Utilities.formatDate(new Date(), NR_TZ, "dd/MM/yyyy");
  const th = 'style="background:#e8f5e9;color:#1b5e20;padding:8px;text-align:left"';


  const detail = list.map((p, i) =>
    '<tr><td>' + (i + 1) + '</td><td>' + p.po + '</td><td>' + p.unit +
    '</td><td>' + p.vendor + '</td><td>' + fmt(p.date) +
    '</td><td align="right">' + p.items + '</td><td align="right">' + p.amount +
    '</td></tr>').join("");


  return '' +
  '<div style="font-family:Arial;max-width:900px">' +
    '<div style="background:#1b5e20;color:#fff;padding:16px">' +
      '<h2 style="margin:0">PURCHASE FMS - MATERIAL NOT RECEIVED</h2>' +
      '<div>From 01-Apr-2026 to ' + today + '</div>' +
    '</div>' +
    '<h3>PO-wise detail</h3>' +
    '<table width="100%" cellpadding="6" border="1" style="border-collapse:collapse">' +
      '<tr><th ' + th + '>S.No</th><th ' + th + '>PO Number</th><th ' + th + '>Unit</th>' +
      '<th ' + th + '>Vendor</th><th ' + th + '>Order Date</th><th ' + th + '>Items</th>' +
      '<th ' + th + '>PO Amount</th></tr>' +
      (detail || '<tr><td colspan="7">Nothing pending.</td></tr>') +
    '</table>' +
    '<div style="background:#1b5e20;color:#fff;padding:12px;font-weight:bold">' +
      'TOTAL POs: ' + list.length + ' &nbsp;|&nbsp; TOTAL AMOUNT: Rs. ' + total +
    '</div>' +
  '</div>';
}


// ================= EXCEL: PO-wise detail =================
function nrExcelFile_(list, stamp) {
  const header = ["S.No", "PO Number", "Unit", "Vendor", "Order Date", "Items", "PO Amount"];
  const values = [header].concat(list.map((p, i) =>
    [i + 1, p.po, p.unit, p.vendor, p.date, p.items, p.amount]));
  let total = 0;
  list.forEach(p => { total += p.amount; });
  values.push(["", "", "", "", "", "TOTAL", total]);


  const ss = SpreadsheetApp.create("tmp_po_detail_" + stamp);
  try {
    const sh = ss.getSheets()[0];
    sh.getRange(1, 1, values.length, 7).setValues(values);
    sh.getRange(1, 1, 1, 7).setBackground("#1b5e20").setFontColor("#ffffff").setFontWeight("bold");
    if (list.length > 0) sh.getRange(2, 5, list.length, 1).setNumberFormat("dd-mmm-yy");
    sh.getRange(2, 7, values.length - 1, 1).setNumberFormat("#,##0.00");
    sh.getRange(values.length, 1, 1, 7).setFontWeight("bold");
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, 7);
    SpreadsheetApp.flush();
    const blob = nrExport_(ss, "xlsx", "");
    blob.setName("PO_Detail_" + stamp + ".xlsx");
    return blob;
  } finally {
    DriveApp.getFileById(ss.getId()).setTrashed(true);
  }
}


// ================= TABLE: Material Not Received (Cluster / Unit / Month) =================
function nrMatrixData_(list) {
  const now = new Date();
  const ny = +Utilities.formatDate(now, NR_TZ, "yyyy");
  const nm = +Utilities.formatDate(now, NR_TZ, "M") - 1;


  const months = [];
  let y = NR_FROM_DATE.getFullYear(), m = NR_FROM_DATE.getMonth();
  while (y < ny || (y === ny && m <= nm)) {
    months.push({ y: y, m: m, label: Utilities.formatDate(new Date(y, m, 1), NR_TZ, "MMM-yy") });
    m++;
    if (m > 11) { m = 0; y++; }
  }


  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const grid = NR_UNIT_MAP.map(() => months.map(() => 0));
  const other = months.map(() => 0);
  const otherNames = {};


  list.forEach(p => {
    const mi = months.findIndex(x => x.y === p.date.getFullYear() && x.m === p.date.getMonth());
    if (mi < 0) return;
    const u = norm(p.unit);
    const ui = NR_UNIT_MAP.findIndex(row => row[2].some(k => u.indexOf(k) !== -1));
    if (ui >= 0) {
      grid[ui][mi]++;
    } else {
      other[mi]++;
      otherNames[String(p.unit).trim()] = true;
    }
  });


  const rows = NR_UNIT_MAP.map((row, i) => ({
    cluster: row[0], unit: row[1], counts: grid[i],
    total: grid[i].reduce((a, b) => a + b, 0)
  }));
  const otherTotal = other.reduce((a, b) => a + b, 0);
  if (otherTotal > 0) {
    rows.push({ cluster: "Other", unit: Object.keys(otherNames).join(", "),
                counts: other, total: otherTotal });
  }


  const colTotals = months.map((x, j) => rows.reduce((a, r) => a + r.counts[j], 0));
  const grandTotal = colTotals.reduce((a, b) => a + b, 0);


  return {
    months: months.map(x => x.label),
    rows: rows,
    totals: { counts: colTotals, total: grandTotal },
    title: "PURCHASE FMS MATERIAL NOT RECEIVED (DATE " +
           Utilities.formatDate(now, NR_TZ, "dd.MM.yy") + ")"
  };
}


function nrMatrixHtml_dash_(v) { return v ? v : "-"; }


function nrBuildMatrixHtml_(data) {
  const bd   = "border:1px solid #bbb;padding:2px 6px;";
  const cell = 'style="' + bd + '"';
  const num  = 'style="' + bd + 'text-align:right;"';
  const hdr  = 'style="background:#5b9bd5;color:#fff;font-weight:bold;' + bd + 'text-align:center;"';


  const body = data.rows.map(r =>
    '<tr><td ' + cell + '>' + r.cluster + '</td><td ' + cell + '>' + r.unit + '</td>' +
    r.counts.map(v => '<td ' + num + '>' + nrMatrixHtml_dash_(v) + '</td>').join("") +
    '<td ' + num + '>' + nrMatrixHtml_dash_(r.total) + '</td></tr>').join("");


  const headCells = data.months.map(l => '<th ' + hdr + '>' + l + '</th>').join("");


  const totalStyle = 'style="' + bd + 'text-align:right;font-weight:bold;background:#ddebf7;"';
  const totalRow =
    '<tr><td ' + totalStyle + ' colspan="2">Grand Total</td>' +
    data.totals.counts.map(v => '<td ' + totalStyle + '>' + nrMatrixHtml_dash_(v) + '</td>').join("") +
    '<td ' + totalStyle + '>' + nrMatrixHtml_dash_(data.totals.total) + '</td></tr>';


  return '' +
  '<div style="font-family:Arial;font-size:13px;max-width:900px">' +
    '<div style="background:#5b9bd5;color:#fff;padding:10px;text-align:center;font-weight:bold;font-size:16px">' +
      data.title +
    '</div>' +
    '<table width="100%" cellpadding="0" style="border-collapse:collapse">' +
      '<tr><th ' + hdr + '>Cluster</th><th ' + hdr + '>Unit</th>' + headCells +
      '<th ' + hdr + '>Total</th></tr>' +
      body + totalRow +
    '</table>' +
  '</div>';
}


// ================= IMAGE of the table (for WhatsApp) =================
function nrMatrixValues_(data) {
  const cols = 3 + data.months.length;
  const title = [data.title];
  while (title.length < cols) title.push("");
  const head = ["Cluster", "Unit"].concat(data.months).concat(["Total"]);
  const body = data.rows.map(r =>
    [r.cluster, r.unit].concat(r.counts.map(v => v ? v : "-")).concat([r.total ? r.total : "-"]));
  const dash = v => (v ? v : "-");
  const totalRow = ["Grand Total", ""].concat(data.totals.counts.map(dash)).concat([dash(data.totals.total)]);
  return [title, head].concat(body).concat([totalRow]);
}


function nrMatrixImage_(data, stamp) {
  const values = nrMatrixValues_(data);
  const nRows = values.length, nCols = values[0].length;
  const ss = SpreadsheetApp.create("tmp_matrix_" + stamp);
  try {
    const sh = ss.getSheets()[0];
    sh.getRange(1, 1, nRows, nCols).setValues(values);
    sh.getRange(1, 1, nRows, nCols).setFontFamily("Arial").setFontSize(10).setVerticalAlignment("middle");
    sh.getRange(1, 1, 1, nCols).merge().setBackground("#5b9bd5").setFontColor("#ffffff")
      .setFontWeight("bold").setFontSize(12).setHorizontalAlignment("center");
    sh.getRange(2, 1, 1, nCols).setBackground("#5b9bd5").setFontColor("#ffffff")
      .setFontWeight("bold").setHorizontalAlignment("center");
    sh.getRange(3, 3, nRows - 2, nCols - 2).setHorizontalAlignment("right");
    sh.getRange(2, 1, nRows - 1, nCols)
      .setBorder(true, true, true, true, true, true, "#999999", SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(nRows, 1, 1, nCols).setFontWeight("bold").setBackground("#ddebf7");
    sh.getRange(nRows, 1, 1, 2).merge().setHorizontalAlignment("right");
    sh.setColumnWidth(1, 130);
    sh.setColumnWidth(2, 120);
    for (let c = 3; c <= nCols; c++) sh.setColumnWidth(c, 65);
    SpreadsheetApp.flush();


    const pdf = nrExport_(ss, "pdf",
      "&size=A4&portrait=true&fitw=true&gridlines=false&sheetnames=false" +
      "&printtitle=false&pagenum=UNDEFINED" +
      "&top_margin=0.3&bottom_margin=0.3&left_margin=0.3&right_margin=0.3");
    pdf.setName("Material_Not_Received_" + stamp + ".pdf");


    // Try to turn the PDF page into a picture; if Google cannot, send the PDF instead
    try {
      const png = pdf.getAs("image/png");
      if (png.getBytes().length > 2000) {
        return [png.setName("Material_Not_Received_" + stamp + ".png"), pdf];
      }
    } catch (e) {
      Logger.log("PNG conversion failed, sending PDF instead: " + e);
    }
    return [pdf];
  } finally {
    DriveApp.getFileById(ss.getId()).setTrashed(true);
  }
}


// ================= helper: export a temp spreadsheet =================
function nrExport_(ss, format, extra) {
  const url = "https://docs.google.com/spreadsheets/d/" + ss.getId() +
              "/export?format=" + format + (extra || "");
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error("Export failed with code " + res.getResponseCode());
  }
  return res.getBlob();
}
