// City-limits lookup shared by /api/boundary and scripts/compute-accessibility-all.mjs.
// NFC "cities" are often towns, townships, villages or counties, so the name is
// matched against the right Census geography (TIGERweb, public, no key):
//   "Hernando County, FL"       -> Counties
//   "Cranberry Township, PA"    -> County Subdivisions (townships)
//   "Town Of Wallingford, CT"   -> Incorporated Places, then County Subdivisions
//   "Mc Allen, TX"              -> also tried as "McAllen"
// Universities and school districts have no Census boundary and return null.

export const FIPS = { AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56', PR: '72' };
const BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';
const LAYER = { place: 28, cdp: 30, subdivision: 22, county: 82 };
const NOT_A_PLACE = /universit|college|school|district|\bUSD\b|SUNY|campus|academy/i;

async function query(layer, base, fips, offset = '0.0003') {
  const q = new URLSearchParams({
    where: `BASENAME='${base.replace(/'/g, "''")}' AND STATE='${fips}'`,
    outFields: 'NAME', returnGeometry: 'true', outSR: '4326', maxAllowableOffset: offset, geometryPrecision: '5', f: 'geojson',
  });
  const r = await fetch(`${BASE}/${layer}/query?${q}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`TIGERweb ${r.status}`);
  const fc = await r.json();
  return fc.features?.length ? fc : null;
}

// Several places can share a name in one state (three Union townships in MI);
// keep the one whose outline holds `near` ([lon, lat] of a Fitness Court).
function bboxOf(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (a) => (typeof a[0] === 'number' ? (x0 = Math.min(x0, a[0]), y0 = Math.min(y0, a[1]), x1 = Math.max(x1, a[0]), y1 = Math.max(y1, a[1])) : a.forEach(walk));
  walk(geom.coordinates);
  return [x0, y0, x1, y1];
}
function pick(fc, near) {
  if (!fc) return null;
  if (fc.features.length === 1 && !near) return fc;
  if (!near) return null; // ambiguous without a location to choose by
  const inside = fc.features.filter((f) => { const [x0, y0, x1, y1] = bboxOf(f.geometry); return near[0] >= x0 && near[0] <= x1 && near[1] >= y0 && near[1] <= y1; });
  return inside.length ? { type: 'FeatureCollection', features: inside.slice(0, 1) } : null;
}

export async function findBoundary(city, st, { offset, near } = {}) {
  const fips = FIPS[st];
  if (!fips || !city || NOT_A_PLACE.test(city)) return null;
  const clean = city.replace(/^(charter\s+)?(town|township|village|city)\s*of\s*/i, '').replace(/\s+park district$/i, '').trim();
  const names = [...new Set([clean, clean.replace(/^Mc\s+/i, 'Mc'), clean.replace(/\s+/g, '')])];
  if (/\bcounty$/i.test(clean)) return pick(await query(LAYER.county, clean.replace(/\s+county$/i, ''), fips, offset), near);
  const layers = /township/i.test(city) ? [LAYER.subdivision] : [LAYER.place, LAYER.cdp, LAYER.subdivision];
  for (const layer of layers) {
    for (const n of names) {
      const fc = pick(await query(layer, layer === LAYER.subdivision ? n.replace(/\s+township$/i, '') : n, fips, offset), near);
      if (fc) return fc;
    }
  }
  return null;
}
