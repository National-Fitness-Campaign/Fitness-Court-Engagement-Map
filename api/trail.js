// GET /api/trail?pilot=las-vegas — one Trail Line pilot: every TL- code,
// placed at its Design Lab station, with per-day scans split public/test.

import { buildPilot, digest, PILOTS } from './_trail.js';
import { sendError, setCache } from './_lib.js';

export default async function handler(req, res) {
  try {
    const slug = (req.query && req.query.pilot) || 'las-vegas';
    if (!PILOTS[slug]) { res.status(404).json({ error: `Unknown pilot: ${slug}` }); return; }
    const data = await buildPilot(slug);
    setCache(res);
    res.status(200).json({ ...data, digest: digest(data) });
  } catch (err) {
    sendError(res, err);
  }
}
