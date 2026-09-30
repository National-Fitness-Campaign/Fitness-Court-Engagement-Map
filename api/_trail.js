// Trail Line pilot data — shared by /api/trail and /api/trail-summary.
//
// A pilot is one city's set of TL- QR codes plus that city's Design Lab
// layers. Sign positions come from the Design Lab "Trail Line Stations" layer
// (the same source the station maps are drawn from), matched to each code by
// the station ID in its name: TL-NV-LasVegas-L-KL2-Map → station KL2.
//
// Code names: TL-{ST}-{City}-{Size}[-{Station}][-{Purpose}]
//   Size    L = Gateway (Station Max), M = Midway (Station Plus), S = Trail Marker
//   Purpose Map = "scan for the city map", CTA = "your personal trainers" (app);
//           a Midway's unsuffixed code is its CTA

import { fetchAllQRCodes, supabaseSelect, laToday } from './_lib.js';

export const PILOTS = {
  'las-vegas': {
    name: 'Las Vegas',
    state: 'NV',
    prefix: 'TL-NV-LasVegas-',
    designLabCityId: 'cmnp7a5ng0000l404woglts7g',
    // Signs go in Oct 19–21 (pilot status update, 2026-09-30). Installer
    // checks on those days aren't public use, so public counting starts the
    // day after install; everything earlier is a test / install scan.
    installStart: '2026-10-19',
    launchDate: '2026-10-22',
    installWindow: 'Oct 19–21',
    center: [36.1835, -115.2615],
  },
};

const TIERS = { L: 'gateway', M: 'midway', S: 'marker' };
// Station ID prefix → the line it sits on (Design Lab loop names).
const LINES = [
  ['KL', 'Kellogg-Zaher Loops'],
  ['PL', 'Pioneer Park Loops'],
  ['WL', 'Woofter Loops'],
  ['BL', 'Bill Briare Park Loops'],
  ['B', 'Bonanza Trail'],
  ['L', 'Lone Mountain Trail'],
];
const lineFor = (station) => (LINES.find(([p]) => station && station.startsWith(p) && /^\d/.test(station.slice(p.length))) || [])[1] || null;

export function parseTrailCode(name, prefix) {
  // Tolerate case slips and trailing extras (…-KL2-Map-v2, …-l-kl2-map).
  const parts = name.slice(prefix.length).split('-').map((p) => p.trim()).filter(Boolean);
  const size = (parts[0] || '').toUpperCase();
  const station = parts[1] && /^[A-Za-z]{1,2}\d+$/.test(parts[1]) ? parts[1].toUpperCase() : null;
  const tagged = parts.slice(station ? 2 : 1).find((p) => /^(map|cta)$/i.test(p));
  // Midway signs carry the station's original code as the app / personal
  // trainer QR and a "-Map" code in the map key (checked against the print
  // files 2026-09-30), so an untagged station code is the CTA.
  const purpose = tagged ? (tagged.toLowerCase() === 'map' ? 'Map' : 'CTA') : station ? 'CTA' : null;
  return { tier: TIERS[size] || 'unknown', station, purpose };
}

async function designLabLayer(cityId, name) {
  const rows = await supabaseSelect(
    `layers?select=geojsonData&cityId=eq.${cityId}&name=eq.${encodeURIComponent(name)}&limit=1`,
  );
  return rows[0]?.geojsonData?.features || [];
}

// Design Lab station points. `label` is the printed station ID; the older
// `code` field went stale when stations were renumbered, so it's a fallback.
function stationPositions(features) {
  const positions = new Map();
  for (const f of features) {
    const p = f.properties || {};
    const id = (p.label || p.code || '').trim();
    if (!/^[A-Z]{1,2}\d+$/.test(id) || f.geometry?.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates;
    positions.set(id, { lat, lon });
  }
  return positions;
}

// For the all-courts map: every pilot's Design Lab station positions, fetched
// without needing the code list, so it can run alongside the other reads.
export async function trailStationPositions() {
  const out = [];
  for (const pilot of Object.values(PILOTS)) {
    out.push({ pilot, positions: stationPositions(await designLabLayer(pilot.designLabCityId, 'Trail Line Stations')) });
  }
  return out;
}

// Where each trail line code's sign stands, keyed by QR id. Codes without a
// station ID (e.g. a trail marker) are left out.
export function placeTrailCodes(codes, stationSets) {
  const out = new Map();
  for (const { pilot, positions } of stationSets) {
    for (const c of codes) {
      if (!c.name.toLowerCase().startsWith(pilot.prefix.toLowerCase())) continue;
      const { station } = parseTrailCode(c.name, pilot.prefix);
      const pos = station && positions.get(station);
      if (pos) out.set(String(c.id), { ...pos, station });
    }
  }
  return out;
}

export async function buildPilot(slug) {
  const pilot = PILOTS[slug];
  if (!pilot) return null;

  const [codes, stationFeatures, loopFeatures] = await Promise.all([
    fetchAllQRCodes(),
    designLabLayer(pilot.designLabCityId, 'Trail Line Stations'),
    designLabLayer(pilot.designLabCityId, 'Trail Line Loops'),
  ]);

  const trailCodes = codes.filter((c) => c.name.toLowerCase().startsWith(pilot.prefix.toLowerCase()) && c.state === 'A');
  const ids = trailCodes.map((c) => c.id);
  const daily = ids.length
    ? await supabaseSelect(`scan_daily?select=qr_id,scan_date_la,is_bot,scans&qr_id=in.(${ids.join(',')})&order=scan_date_la.asc,qr_id.asc,is_bot.asc`)
    : [];

  const positions = stationPositions(stationFeatures);

  const launch = pilot.launchDate;
  const byCode = new Map(trailCodes.map((c) => [String(c.id), []]));
  for (const r of daily) byCode.get(String(r.qr_id))?.push(r);

  const stations = new Map();
  const unplaced = [];
  for (const c of trailCodes) {
    const parsed = parseTrailCode(c.name, pilot.prefix);
    const rows = byCode.get(String(c.id)) || [];
    const days = {};
    let pub = 0, test = 0, bot = 0, last = null;
    for (const r of rows) {
      if (r.is_bot) { bot += r.scans; continue; }
      const isTest = !launch || r.scan_date_la < launch;
      if (isTest) test += r.scans; else pub += r.scans;
      days[r.scan_date_la] = (days[r.scan_date_la] || 0) + r.scans;
      if (!last || r.scan_date_la > last) last = r.scan_date_la;
    }
    const code = {
      id: c.id, name: c.name, purpose: parsed.purpose, url: c.url, created: c.created,
      publicScans: pub, testScans: test, botScans: bot, officialScans: c.scans ?? 0, lastScan: last, days,
    };
    const pos = parsed.station ? positions.get(parsed.station) : null;
    if (!parsed.station || !pos) { unplaced.push({ ...code, tier: parsed.tier, station: parsed.station }); continue; }
    let st = stations.get(parsed.station);
    if (!st) {
      st = { id: parsed.station, tier: parsed.tier, line: lineFor(parsed.station), lat: pos.lat, lon: pos.lon, codes: [] };
      stations.set(parsed.station, st);
    }
    st.codes.push(code);
  }

  const list = [...stations.values()].map((s) => ({
    ...s,
    publicScans: s.codes.reduce((n, c) => n + c.publicScans, 0),
    testScans: s.codes.reduce((n, c) => n + c.testScans, 0),
    lastScan: s.codes.map((c) => c.lastScan).filter(Boolean).sort().at(-1) || null,
  })).sort((a, b) => ({ gateway: 0, midway: 1, marker: 2 }[a.tier] - { gateway: 0, midway: 1, marker: 2 }[b.tier]) || a.id.localeCompare(b.id, 'en', { numeric: true }));

  const loops = loopFeatures
    .filter((f) => f.geometry?.type === 'LineString')
    .map((f) => ({
      type: 'Feature',
      properties: { name: f.properties?.name || '', stroke: f.properties?.stroke || '#097138' },
      geometry: f.geometry,
    }));

  return {
    pilot: { slug, name: pilot.name, state: pilot.state, launchDate: launch, installStart: pilot.installStart || null, installWindow: pilot.installWindow || null, center: pilot.center },
    stations: list,
    unplaced,
    loops: { type: 'FeatureCollection', features: loops },
    firstCodeCreated: trailCodes.map((c) => c.created).filter(Boolean).sort()[0] || null,
    lastSynced: new Date().toISOString(),
  };
}

// Numbers the summary is written from — computed here so the model only ever
// words facts, never invents them.
export function digest(data, today = laToday()) {
  const all = [...data.stations.flatMap((s) => s.codes.map((c) => ({ ...c, station: s.id, tier: s.tier, line: s.line }))),
    ...data.unplaced];
  const sumDays = (from, to) => all.reduce((n, c) => n + Object.entries(c.days).filter(([d]) => d >= from && d <= to).reduce((m, [, v]) => m + v, 0), 0);
  const shift = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
  const thisWeek = sumDays(shift(today, -6), today);
  const lastWeek = sumDays(shift(today, -13), shift(today, -7));
  const scanned = data.stations.filter((s) => s.publicScans + s.testScans > 0);
  const byPurpose = (p) => all.filter((c) => c.purpose === p).reduce((n, c) => n + c.publicScans + c.testScans, 0);
  const byTier = (t) => all.filter((c) => c.tier === t).reduce((n, c) => n + c.publicScans + c.testScans, 0);
  const ranked = [...data.stations].sort((a, b) => (b.publicScans + b.testScans) - (a.publicScans + a.testScans));
  return {
    city: data.pilot.name,
    launchDate: data.pilot.launchDate,
    installStart: data.pilot.installStart,
    installWindow: data.pilot.installWindow,
    today,
    codes: all.length,
    stations: data.stations.length,
    stationsWithScans: scanned.length,
    publicScans: all.reduce((n, c) => n + c.publicScans, 0),
    testScans: all.reduce((n, c) => n + c.testScans, 0),
    thisWeek, lastWeek,
    mapScans: byPurpose('Map'), ctaScans: byPurpose('CTA'),
    gatewayScans: byTier('gateway'), midwayScans: byTier('midway'), markerScans: byTier('marker'),
    top: ranked.slice(0, 3).filter((s) => s.publicScans + s.testScans > 0).map((s) => ({ station: s.id, line: s.line, scans: s.publicScans + s.testScans })),
    silentStations: data.stations.filter((s) => s.publicScans + s.testScans === 0).map((s) => s.id),
  };
}
