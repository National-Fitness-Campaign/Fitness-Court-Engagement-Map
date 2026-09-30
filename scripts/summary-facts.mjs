#!/usr/bin/env node
// Step 1 of the daily AI summary: gather the facts to write from.
//
//   node scripts/summary-facts.mjs [--out=/path/facts.json] [--base=https://…] [--top=25]
//
// Pulls, from the live site, the numbers behind each city panel and the
// Las Vegas Trail Line pilot. Cities: the --top busiest by all-time scans,
// plus every city with Trail Line codes. Output feeds the writer (a scheduled
// Claude task), whose summaries go back in via scripts/save-summaries.mjs.

import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const BASE = (args.base || 'https://fitness-court-engagement-map.vercel.app').replace(/\/+$/, '');
const TOP = Number(args.top || 25);
const get = async (p) => {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} on ${p}`);
  return r.json();
};

const { courts } = await get(`/api/courts?t=${Date.now()}`);
const byCity = new Map();
for (const c of courts) {
  if (!c.city || !/^[A-Z]{2}$/.test(c.state)) continue;
  const key = `${c.city}, ${c.state}`;
  const e = byCity.get(key) || { city: c.city, state: c.state, scans: 0, trail: false };
  e.scans += c.officialScans || 0;
  e.trail ||= c.kind === 'trail';
  byCity.set(key, e);
}
const picked = [...byCity.values()].sort((a, b) => b.scans - a.scans)
  .filter((e, i) => i < TOP || e.trail);

const items = [];
for (const e of picked) {
  const s = await get(`/api/city-summary?city=${encodeURIComponent(e.city)}&state=${e.state}&t=${Date.now()}`);
  items.push({ key: `city:${e.city}, ${e.state}`, kind: 'city', facts: s.facts });
}
const pilot = await get(`/api/trail-summary?pilot=las-vegas&t=${Date.now()}`);
items.push({ key: 'pilot:las-vegas', kind: 'pilot', facts: pilot.digest });

const out = { generatedAt: new Date().toISOString(), count: items.length, items };
if (args.out) { fs.writeFileSync(String(args.out), JSON.stringify(out, null, 1)); console.log(`wrote ${items.length} fact sets to ${args.out}`); }
else process.stdout.write(JSON.stringify(out, null, 1));
