// POST /api/confirm-location — write a CONFIRMED exact location to Uniqode metadata.
//
// Body: { id: <qr code id>, lat?: number, lon?: number, address?: string }
//   - lat+lon provided → written as-is (exact, human-confirmed)
//   - address only     → geocoded once via Nominatim, then written
// Auth: x-admin-key header must match the ADMIN_KEY env var. This endpoint
// writes to the NFC Uniqode account, so it is never open to the public.
//
// On success the matching row in qr_location_suggestions is deleted —
// the code graduates from "approximate" to "verified".

import { timingSafeEqual } from 'node:crypto';
import { env, uniqodeFetch, sendError, UpstreamError } from './_lib.js';

// Constant-time compare so the key can't be guessed byte by byte from timing.
function keyMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const sanitize = (s) => s.replace(/[^A-Za-z0-9 _-]/g, ' ').replace(/\s+/g, ' ').trim();

async function supaFetch(path, opts = {}) {
  const key = env('SUPABASE_SERVICE_KEY');
  return fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) { res.status(503).json({ error: 'ADMIN_KEY is not configured in Vercel — add it under Settings → Environment Variables to enable location editing.' }); return; }
    if (!keyMatches(req.headers['x-admin-key'], adminKey)) { res.status(401).json({ error: 'Wrong admin key.' }); return; }

    const { id, address } = req.body || {};
    let { lat, lon } = req.body || {};
    // Uniqode ids are numeric; anything else would be spliced into the API path.
    if (!/^\d{1,12}$/.test(String(id ?? ''))) { res.status(400).json({ error: 'Missing or invalid QR code id.' }); return; }

    if ((lat == null || lon == null) && address) {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
      const hits = await (await fetch(url, { headers: { 'User-Agent': 'NFC-FitnessCourtMap/1.0 (jessica@nfchq.com)' } })).json();
      if (!hits[0]) { res.status(422).json({ error: `Could not geocode that address — try entering lat/lon directly.` }); return; }
      lat = +hits[0].lat; lon = +hits[0].lon;
    }
    lat = Number(lat); lon = Number(lon);
    const valid = Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0);
    if (!valid) { res.status(400).json({ error: 'Provide a valid lat/lon pair or an address.' }); return; }

    // Merge with existing metadata, never drop other keys.
    const current = await uniqodeFetch(`/qrcodes/${id}/`);
    const metadata = { ...(current.metadata || {}), lat, lon };
    if (address) metadata.address = sanitize(address);

    const resp = await fetch(`https://api.uniqode.com/api/2.0/qrcodes/${id}/`, {
      method: 'PATCH',
      headers: { Authorization: `Token ${env('UNIQODE_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ metadata }),
    });
    if (!resp.ok) throw new UpstreamError(`Uniqode PATCH ${resp.status}: ${(await resp.text()).slice(0, 150)}`);

    await supaFetch(`qr_location_suggestions?qr_id=eq.${encodeURIComponent(String(id))}`, { method: 'DELETE' }).catch(() => {});

    res.status(200).json({ ok: true, id, lat, lon, address: metadata.address || null });
  } catch (err) {
    sendError(res, err);
  }
}
