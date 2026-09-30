// GET /api/boundary?city=Las%20Vegas&state=NV: the city-limits outline for
// the map, from the Census Bureau's TIGERweb (incorporated places, then
// census-designated places). Public data, no key. Empty collection when the
// "city" is really a county or campus the Census doesn't list as a place.

import { sendError } from './_lib.js';

const FIPS = { AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56', PR: '72' };
const BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';

async function place(layer, city, fips) {
  const q = new URLSearchParams({
    where: `BASENAME='${city.replace(/'/g, "''")}' AND STATE='${fips}'`,
    outFields: 'NAME', returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.0003', geometryPrecision: '5', f: 'geojson',
  });
  const r = await fetch(`${BASE}/${layer}/query?${q}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`TIGERweb ${r.status}`);
  const fc = await r.json();
  return fc.features?.length ? fc : null;
}

export default async function handler(req, res) {
  try {
    const city = String(req.query?.city || '').trim();
    const st = String(req.query?.state || '').trim().toUpperCase();
    if (!/^[A-Za-z .'-]{2,60}$/.test(city) || !FIPS[st]) { res.status(400).json({ error: 'Need ?city=<name>&state=<2-letter state>' }); return; }
    const fc = (await place(28, city, FIPS[st])) || (await place(30, city, FIPS[st])) || { type: 'FeatureCollection', features: [] };
    res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=2592000');
    res.status(200).json(fc);
  } catch (err) {
    sendError(res, err);
  }
}
