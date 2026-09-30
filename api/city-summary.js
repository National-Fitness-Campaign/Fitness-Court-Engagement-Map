// GET /api/city-summary?city=Las%20Vegas&state=NV[&from=YYYY-MM-DD&to=YYYY-MM-DD]
// AI overview for the city panel and the Analytics city breakdown. With a
// range, the facts (and so the words) describe that period and compare it
// with the period of the same length just before it.
//
// Three short overviews: the city as a whole, its Fitness Courts, and its
// Trail Line signs. Every number is computed here from Uniqode (all-time) and
// the scan rollup (by Pacific day); the model only words them. When the model
// is unavailable this returns { source: 'computed' } and the panel keeps the
// overview it already wrote from the same numbers.

import { fetchAllQRCodes, supabaseSelect, parseName, laToday, sendError, setCache } from './_lib.js';
import { PILOTS, parseTrailCode } from './_trail.js';
import { writeWithAI, storedSummary, directAI } from './_ai.js';

const SYSTEM =
  'You write short overviews for an internal dashboard of QR-code scans at outdoor fitness sites in one city. '
  + 'Fitness Courts are outdoor gyms; Trail Line signs are wayfinding stations on trails (Map codes open a trail map, CTA codes open the coaching app). '
  + 'Never use em dashes or en dashes as punctuation; write with commas, periods or colons so it reads like a person wrote it. '
  + 'Use ONLY the numbers given. Never invent numbers, causes, weather or seasons. Dates are Pacific time. '
  + 'Reply with JSON only: {"city": string, "courts": string, "trail": string}. Each value is 1-2 plain sentences, no emoji, no markdown. '
  + '"city": the total picture and whether this week is up or down vs last week. '
  + '"courts": the trend, the busiest and the lowest court, and any that went quiet. '
  + '"trail": the trend, which stations are being scanned, Map vs CTA. If the pilot has not launched (today before launchDate), say scans so far are test/install scans and when public counting starts. '
  + 'If facts.range is present, lead with that period: scans in the range, the change versus the previous period of the same length (prevScans), and the top and lowest codes in the range. Describe the range in words (e.g. "in the last 30 days", "since January 1"). '
  + 'If a side has no codes, its value is an empty string. If there is too little data to call a trend, say so plainly.';

const shift = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

function sideFacts(list, daysById, today, range) {
  if (!list.length) return null;
  const sumRange = (c, from, to) => {
    let n = 0;
    for (const [d, v] of daysById.get(String(c.id)) || []) if (d >= from && d <= to) n += v;
    return n;
  };
  const week = (k) => list.reduce((t, c) => t + sumRange(c, shift(today, -6 - 7 * k), shift(today, -7 * k)), 0);
  const ranked = [...list].sort((a, b) => b.allTime - a.allTime);
  const withScans = ranked.filter((c) => c.allTime > 0);
  const thisWeekBy = list.map((c) => ({ name: c.label, n: sumRange(c, shift(today, -6), today) })).sort((a, b) => b.n - a.n);
  return {
    codes: list.length,
    allTimeScans: list.reduce((t, c) => t + c.allTime, 0),
    thisWeek: week(0),
    lastWeek: week(1),
    last4WeeksOldestFirst: [3, 2, 1, 0].map(week),
    top: ranked.slice(0, 3).filter((c) => c.allTime > 0).map((c) => ({ name: c.label, allTime: c.allTime })),
    lowest: withScans.length > 1 ? { name: withScans.at(-1).label, allTime: withScans.at(-1).allTime } : null,
    bestThisWeek: thisWeekBy[0]?.n ? thisWeekBy[0] : null,
    quietLast28Days: list.filter((c) => sumRange(c, shift(today, -27), today) === 0).map((c) => c.label).slice(0, 6),
    ...(range ? rangeFacts(list, sumRange, range) : {}),
  };
}

// The selected period vs. the period of the same length right before it.
function rangeFacts(list, sumRange, { from, to }) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const pTo = shift(from, -1), pFrom = shift(from, -days);
  const inRange = list.map((c) => ({ name: c.label, n: sumRange(c, from, to), prev: sumRange(c, pFrom, pTo) })).sort((a, b) => b.n - a.n);
  const scanned = inRange.filter((c) => c.n > 0);
  return {
    rangeScans: inRange.reduce((t, c) => t + c.n, 0),
    prevScans: inRange.reduce((t, c) => t + c.prev, 0),
    rangeTop: scanned.slice(0, 3).map(({ name, n }) => ({ name, scans: n })),
    rangeLowest: scanned.length > 1 ? { name: scanned.at(-1).name, scans: scanned.at(-1).n } : null,
    noScansInRange: inRange.filter((c) => c.n === 0).map((c) => c.name).slice(0, 6),
  };
}

export default async function handler(req, res) {
  try {
    const city = String(req.query?.city || '').trim();
    const state = String(req.query?.state || '').trim().toUpperCase();
    const D = /^\d{4}-\d{2}-\d{2}$/;
    const from = String(req.query?.from || ''), to = String(req.query?.to || '');
    const range = D.test(from) && D.test(to) && from <= to ? { from, to } : null;
    if (!city || city.length > 80 || !/^[A-Z]{2}$/.test(state)) {
      res.status(400).json({ error: 'Pass ?city=<name>&state=<two-letter code>' });
      return;
    }

    const codes = (await fetchAllQRCodes())
      .filter((c) => c.state === 'A' && (c.name.startsWith('QR') || c.name.startsWith('TL-')))
      .map((c) => ({ ...c, parsed: parseName(c.name) }))
      .filter((c) => c.parsed.state === state && c.parsed.city.toLowerCase() === city.toLowerCase());
    if (!codes.length) { res.status(404).json({ error: `No codes for ${city}, ${state}` }); return; }

    const ids = codes.map((c) => c.id).join(',');
    const rows = await supabaseSelect(
      `scan_daily?select=qr_id,scan_date_la,scans&qr_id=in.(${ids})&order=scan_date_la.asc,qr_id.asc,is_bot.asc`,
    );
    const daysById = new Map();
    for (const r of rows) {
      const m = daysById.get(String(r.qr_id)) || new Map();
      m.set(r.scan_date_la, (m.get(r.scan_date_la) || 0) + r.scans);
      daysById.set(String(r.qr_id), m);
    }

    const pilot = Object.values(PILOTS).find((p) => codes.some((c) => c.name.startsWith(p.prefix))) || null;
    const courts = [], trail = [];
    for (const c of codes) {
      if (c.name.startsWith('TL-') && pilot) {
        const t = parseTrailCode(c.name, pilot.prefix);
        const tier = { gateway: 'Gateway', midway: 'Midway', marker: 'Trail Marker' }[t.tier] || 'Sign';
        trail.push({ id: c.id, allTime: c.scans ?? 0, label: t.station ? `${t.station} ${tier} · ${t.purpose}` : tier, purpose: t.purpose, station: t.station });
      } else if (!c.name.startsWith('TL-')) {
        courts.push({ id: c.id, allTime: c.scans ?? 0, label: c.parsed.location });
      }
    }

    const today = laToday();
    const facts = {
      city: `${codes[0].parsed.city}, ${state}`,
      today,
      ...(range ? { range: { ...range, days: Math.round((Date.parse(range.to) - Date.parse(range.from)) / 864e5) + 1 } } : {}),
      courts: sideFacts(courts, daysById, today, range),
      trail: sideFacts(trail, daysById, today, range),
    };
    if (facts.trail) {
      facts.trail.stationsScanned = new Set(trail.filter((c) => c.allTime > 0).map((c) => c.station)).size;
      facts.trail.stations = new Set(trail.map((c) => c.station).filter(Boolean)).size;
      facts.trail.mapScans = trail.filter((c) => c.purpose === 'Map').reduce((t, c) => t + c.allTime, 0);
      facts.trail.ctaScans = trail.filter((c) => c.purpose === 'CTA').reduce((t, c) => t + c.allTime, 0);
      if (pilot) Object.assign(facts.trail, { installStart: pilot.installStart, launchDate: pilot.launchDate });
    }

    let out = { source: 'computed' };
    const fromStore = async () => {
      const stored = await storedSummary(`city:${facts.city}`);
      return stored?.city ? { source: 'ai', city: stored.city, courts: stored.courts || '', trail: stored.trail || '', writtenAt: stored.writtenAt } : null;
    };
    const stored = directAI() || range ? null : await fromStore();
    if (stored) {
      out = stored;
    } else try {
      const text = await writeWithAI({ system: SYSTEM, facts, maxOutputTokens: 400 });
      const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 600) : '');
      out = { source: 'ai', city: clean(json.city), courts: facts.courts ? clean(json.courts) : '', trail: facts.trail ? clean(json.trail) : '' };
      if (!out.city) throw new Error('model reply missing "city"');
    } catch (err) {
      console.warn('city-summary: live AI unavailable:', err.message);
      out = (directAI() && !range && await fromStore()) || { source: 'computed' };
    }

    setCache(res);
    res.status(200).json({ ...out, facts, generatedAt: new Date().toISOString() });
  } catch (err) {
    sendError(res, err);
  }
}
