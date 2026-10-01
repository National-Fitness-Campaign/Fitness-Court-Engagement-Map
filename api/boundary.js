// GET /api/boundary?city=Las%20Vegas&state=NV: the city-limits outline for
// the map, from the Census Bureau's TIGERweb (see _boundary-lookup.js for how
// towns, townships and counties are matched). Empty collection when the place
// has no Census boundary (a university, a school district).

import { sendError } from './_lib.js';
import { FIPS, findBoundary } from './_boundary-lookup.js';

export default async function handler(req, res) {
  try {
    const city = String(req.query?.city || '').trim();
    const st = String(req.query?.state || '').trim().toUpperCase();
    if (!/^[A-Za-z .'-]{2,80}$/.test(city) || !FIPS[st]) { res.status(400).json({ error: 'Need ?city=<name>&state=<2-letter state>' }); return; }
    const lat = Number(req.query?.lat), lon = Number(req.query?.lon);
    const near = Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : undefined;
    const fc = (await findBoundary(city, st, { near })) || { type: 'FeatureCollection', features: [] };
    res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=2592000');
    res.status(200).json(fc);
  } catch (err) {
    sendError(res, err);
  }
}
