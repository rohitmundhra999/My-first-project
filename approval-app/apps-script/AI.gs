// ======================= AI: invoice auto-read (Google Gemini, free tier) =======================
// When a storekeeper picks the invoice photo/PDF, the app sends it here; Gemini reads the invoice
// number, date and grand total and the app fills the form. The storekeeper checks and then uploads.
// Nothing is written to the sheet here.
// Script properties: GEMINI_API_KEY (required), GEMINI_MODEL (optional, default below).

const AI_CFG = { MODEL: 'gemini-2.5-flash' };

function readInvoice_(user, req) {
  checkFile_(req.file, ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], STORE_CFG.MAX_FILE, 'Invoice file');
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw appError_('SETUP', 'AI invoice reading is not set up yet. Please type the details.');
  const model = prop_('GEMINI_MODEL', AI_CFG.MODEL);
  const prompt = 'This is a purchase invoice / tax invoice / bill from an Indian vendor. Read it and return: ' +
    'invoiceNo = the invoice or bill number exactly as printed (not the PO, GSTIN, challan or order number); ' +
    'date = the invoice date as YYYY-MM-DD (Indian dates are day/month/year); ' +
    'amount = the final grand total payable in rupees including GST, as a plain number. ' +
    'Use an empty string or 0 for anything you cannot read clearly.';
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: req.file.type, data: req.file.data } }, { text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { invoiceNo: { type: 'STRING' }, date: { type: 'STRING' }, amount: { type: 'NUMBER' } },
        required: ['invoiceNo', 'date', 'amount'] }
    }
  };
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true });
  const code = res.getResponseCode();
  if (code === 429) throw appError_('BUSY', 'AI is busy right now. Please type the details or try again in a minute.');
  if (code !== 200) { console.warn('Gemini ' + code + ': ' + res.getContentText().slice(0, 500)); throw appError_('AI', 'AI could not read this invoice. Please type the details.'); }
  let out = {};
  try {
    const j = JSON.parse(res.getContentText());
    out = JSON.parse(j.candidates[0].content.parts.map((p) => p.text || '').join(''));
  } catch (e) { throw appError_('AI', 'AI could not read this invoice. Please type the details.'); }

  const no = String(out.invoiceNo || '').trim().slice(0, 40);
  const dm = String(out.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let date = '';
  if (dm) {
    const d = new Date(+dm[1], +dm[2] - 1, +dm[3]);
    if (d.getMonth() === +dm[2] - 1 && d.getTime() <= Date.now() + 86400000 && +dm[1] > 2000) date = dm[0];
  }
  const amount = Number(out.amount) > 0 && Number(out.amount) < 1e9 ? Math.round(Number(out.amount) * 100) / 100 : 0;
  return { invoiceNo: no, date: date, amount: amount };
}
