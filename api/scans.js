// GET /api/scans?from=YYYY-MM-DD&to=YYYY-MM-DD — per-day scan series.
//
// Rows come from the scan_daily view (deduped, bot-split, America/Los_Angeles
// dates). The frontend does all range math on these exact daily buckets.
// Without params, returns the full archive (June 2025 → today; a few thousand
// rows), so the map can compute every range client-side from one response.

import { supabaseSelect, sendError, setCache } from './_lib.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  try {
    const { from, to } = req.query || {};
    for (const [k, v] of [['from', from], ['to', to]]) {
      if (v && !DATE_RE.test(v)) {
        res.status(400).json({ error: `Invalid ${k} date: expected YYYY-MM-DD` });
        return;
      }
    }

    let q = 'scan_daily?select=qr_id,scan_date_la,is_bot,scans&order=scan_date_la.asc,qr_id.asc,is_bot.asc';
    if (from) q += `&scan_date_la=gte.${from}`;
    if (to) q += `&scan_date_la=lte.${to}`;

    const rows = await supabaseSelect(q);

    // Compact: one row per code+date with human/bot split.
    const byKey = new Map();
    for (const r of rows) {
      const key = `${r.qr_id}|${r.scan_date_la}`;
      let entry = byKey.get(key);
      if (!entry) {
        entry = { qr_id: String(r.qr_id), date: r.scan_date_la, human: 0, bot: 0 };
        byKey.set(key, entry);
      }
      entry[r.is_bot ? 'bot' : 'human'] += r.scans;
    }

    setCache(res);
    res.status(200).json({ days: [...byKey.values()], lastSynced: new Date().toISOString() });
  } catch (err) {
    sendError(res, err);
  }
}
