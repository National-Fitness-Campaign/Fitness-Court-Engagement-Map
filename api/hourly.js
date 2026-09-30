// GET /api/hourly?ids=1,2,3&from=2026-09-01&to=2026-09-30&bots=1
// Time of day: scans by Pacific day of week x hour for the given codes (all
// codes when ids is omitted), from scan_hourly_rollup via scan_hour_profile().
// Live webhook scans only (from 2026-04-07); the older backfill has no times.

import { env, sendError, setCache, UpstreamError } from './_lib.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    const ids = q.ids ? String(q.ids).split(',').filter(Boolean) : null;
    if (ids && (ids.length > 1000 || !ids.every((id) => /^\d{1,12}$/.test(id)))) { res.status(400).json({ error: 'ids must be numeric QR code ids' }); return; }
    const from = q.from && DATE.test(q.from) ? q.from : null;
    const to = q.to && DATE.test(q.to) ? q.to : null;
    const key = env('SUPABASE_SERVICE_KEY');
    const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/scan_hour_profile`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_ids: ids, p_from: from, p_to: to, p_bots: q.bots !== '0' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new UpstreamError(`Supabase ${r.status} on scan_hour_profile: ${(await r.text()).slice(0, 200)}`);
    // grid[dow][hour], dow 0 = Sunday, Pacific time.
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const row of await r.json()) grid[row.dow][row.hour_la] = Number(row.scans);
    setCache(res);
    res.status(200).json({ grid, since: '2026-04-07', tz: 'America/Los_Angeles' });
  } catch (err) {
    sendError(res, err);
  }
}
