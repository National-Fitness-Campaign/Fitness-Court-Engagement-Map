// Residents inside a walk area, area-weighted: every 2020 Census block that
// touches the area counts in proportion to how much of the block is inside
// (block population × overlap share). Block outlines and 2020 population
// (POP100) come straight from TIGERweb, so no Census API key is needed.
// Counting only blocks whose center falls inside undercounts small walk areas
// (a park whose neighbours' block centers sit just outside reads as 0).
import * as turf from '@turf/turf';

const LAYER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/10/query';

async function get(url, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`TIGERweb ${r.status}`);
      return await r.json();
    } catch (e) { if (i + 1 >= tries) throw e; await new Promise((ok) => setTimeout(ok, 2000 * (i + 1))); }
  }
}

export async function blocksTouching(area) {
  const [minX, minY, maxX, maxY] = turf.bbox(area);
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const q = new URLSearchParams({
      where: 'POP100 > 0', geometry: `${minX},${minY},${maxX},${maxY}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: 'GEOID,POP100', returnGeometry: 'true', maxAllowableOffset: '0.00002',
      resultOffset: String(offset), resultRecordCount: '1000', f: 'geojson',
    });
    const page = await get(`${LAYER}?${q}`);
    if (page.error) throw new Error(`TIGERweb: ${page.error.message}`);
    for (const f of page.features || []) {
      if (!f.geometry) continue;
      out.push({ pop: Number(f.properties.POP100) || 0, feature: f, area: turf.area(f), bbox: turf.bbox(f) });
    }
    if (!page.exceededTransferLimit && (page.features || []).length < 1000) break;
  }
  return out;
}

export function reachIn(blocks, area) {
  if (!area) return { population: 0, blocks: 0 };
  const [ax0, ay0, ax1, ay1] = turf.bbox(area);
  let population = 0, n = 0;
  for (const b of blocks) {
    const [x0, y0, x1, y1] = b.bbox;
    if (x1 < ax0 || x0 > ax1 || y1 < ay0 || y0 > ay1 || !b.area) continue;
    let inter = null;
    try { inter = turf.intersect(turf.featureCollection([b.feature, area])); } catch { inter = null; }
    if (!inter) continue;
    const share = Math.min(1, turf.area(inter) / b.area);
    if (share <= 0) continue;
    population += b.pop * share;
    n++;
  }
  return { population: Math.round(population), blocks: n };
}
