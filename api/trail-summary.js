// GET /api/trail-summary?pilot=las-vegas — the "what's happening" bubble.
//
// The numbers come from digest() (computed, exact); the model only turns them
// into two or three plain sentences. If the model is unavailable or slow the
// bubble falls back to a written-out version of the same facts, so it never
// breaks. Model output is cached per digest, so refreshes don't re-bill it.

import { writeWithAI, storedSummary, directAI } from './_ai.js';
import { buildPilot, digest, PILOTS } from './_trail.js';
import { sendError, setCache } from './_lib.js';


const fmtDay = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Where the pilot is relative to install, in words the summary can use.
function phase(d) {
  if (!d.launchDate) return 'no-date';
  if (d.installStart && d.today < d.installStart) return 'before-install';
  if (d.today < d.launchDate) return 'installing';
  return 'live';
}

function fallback(d) {
  const total = d.publicScans + d.testScans;
  const p = phase(d);
  const when = p === 'no-date' ? ' Launch date isn’t set, so every scan is counted as a pre-launch check.'
    : p === 'before-install' ? ` Signs install ${d.installWindow || fmtDay(d.installStart)}; public counting starts ${fmtDay(d.launchDate)}, so these are test scans.`
    : p === 'installing' ? ` Signs are going in now; public counting starts ${fmtDay(d.launchDate)}.`
    : '';
  if (total === 0) return `No scans yet across the ${d.codes} ${d.city} Trail Line codes.${when}`;
  const top = d.top[0] ? ` ${d.top[0].station} leads with ${d.top[0].scans}.` : '';
  const trend = d.thisWeek === d.lastWeek ? 'flat on last week' : d.thisWeek > d.lastWeek ? `up from ${d.lastWeek} last week` : `down from ${d.lastWeek} last week`;
  return `${total} scan${total === 1 ? '' : 's'} so far at ${d.stationsWithScans} of ${d.stations} stations, ${d.thisWeek} this week, ${trend}.${top}${when}`;
}

const SYSTEM =
  'You write the one-glance status line for an internal dashboard tracking QR-code scans on a new outdoor trail signage pilot. '
  + 'Never use em dashes or en dashes as punctuation; write with commas, periods or colons so it reads like a person wrote it. '
  + 'Use ONLY the numbers given. 2-3 short sentences, plain English, no headings, no bullet points, no emoji. '
  + 'Say whether it is trending up or down week over week, name the strongest and any silent stations, and compare Map vs CTA codes when both have scans. '
  + 'If there is too little data to call a trend, say so plainly. '
  + 'Dates are YYYY-MM-DD in Pacific time. If today is before installStart, the signs are not installed yet and every scan is a test scan. '
  + 'If today is between installStart and launchDate, signs are being installed and scans are installer checks. Public counting starts on launchDate.';

export default async function handler(req, res) {
  try {
    const slug = (req.query && req.query.pilot) || 'las-vegas';
    if (!Object.hasOwn(PILOTS, slug)) { res.status(404).json({ error: `Unknown pilot: ${slug}` }); return; }
    const d = digest(await buildPilot(slug));

    let text = null, source = 'computed', writtenAt = null;
    const useStore = async () => {
      const stored = await storedSummary(`pilot:${slug}`);
      if (stored?.text) { text = stored.text; source = 'ai'; writtenAt = stored.writtenAt; }
    };
    if (!directAI()) await useStore();
    if (!text) try {
      text = await writeWithAI({ system: SYSTEM, facts: d });
      source = 'ai';
    } catch (err) {
      console.warn('trail-summary: live AI unavailable:', err.message);
      if (directAI()) await useStore();
    }

    // Same freshness as /api/trail so the bubble never lags the KPI tiles.
    setCache(res);
    res.status(200).json({ text: text || fallback(d), source, writtenAt, digest: d, generatedAt: new Date().toISOString() });
  } catch (err) {
    sendError(res, err);
  }
}
