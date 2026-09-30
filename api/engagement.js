// GET /api/engagement: the inputs for the Analytics "Engagement" view that
// don't come from Uniqode. The page already has every QR scan; this adds
//   - accessibility: residents within reach of a city's courts / trail line
//     (api/_data/accessibility.json, from scripts/compute-accessibility.mjs)
//   - app: monthly app check-ins and first check-ins (the download proxy) per
//     QR court, from a snapshot of the NFC app backend
//     (api/_data/app-engagement.json, from sql/app-engagement-snapshot.sql)
//   - pilots: Trail Line pilot cities and their public start dates
//   - benchmarks: the NFC per-court health figures the portal uses
// Swapping the snapshot for a live read of the app database only changes this
// file; the page reads the same shape.

import fs from 'node:fs';
import { PILOTS } from './_trail.js';
import { sendError } from './_lib.js';

const readJSON = (name) => JSON.parse(fs.readFileSync(new URL(`./_data/${name}`, import.meta.url), 'utf8'));

// Same figures as the PD portal's HealthImpactCard (PER_COURT).
const BENCHMARKS = {
  courtKcalPerYear: 1_300_000,
  courtKcalSource: 'NFC benchmark: 1.3M calories burned per Fitness Court per year',
};

let cached = null;
function build() {
  if (cached) return cached;
  const access = readJSON('accessibility.json');
  const app = readJSON('app-engagement.json');

  const byCode = {};
  for (const [qr, appCourt, dist] of app.map) byCode[qr] = { appCourt, dist, m: {} };
  const add = (rows, i) => {
    for (const [qr, mo, n] of rows || []) {
      const e = byCode[qr];
      if (!e) continue;
      (e.m[mo] ||= [0, 0])[i] += n;
    }
  };
  add(app.checkins, 0);
  add(app.firsts, 1);

  const accessibility = {};
  for (const a of Object.values(access)) accessibility[a.city] = a;

  cached = {
    accessibility,
    app: {
      takenAt: app.takenAt,
      monthsFrom: app.monthsFrom,
      monthsThrough: app.monthsThrough,
      matchRadiusMeters: app.matchRadiusMeters,
      source: app.source,
      byCode,
      national: app.national.map(([month, newUsers, checkins]) => ({ month, newUsers, checkins })),
    },
    pilots: Object.entries(PILOTS).map(([slug, p]) => ({
      slug, city: `${p.name}, ${p.state}`, launchDate: p.launchDate, installStart: p.installStart, installWindow: p.installWindow,
    })),
    benchmarks: BENCHMARKS,
  };
  return cached;
}

export default function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json(build());
  } catch (err) {
    sendError(res, err);
  }
}
