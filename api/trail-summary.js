// GET /api/trail-summary?pilot=las-vegas — the "what's happening" bubble.
//
// The numbers come from digest() (computed, exact); the model only turns them
// into two or three plain sentences. If the model is unavailable the bubble
// falls back to a written-out version of the same facts, so it never breaks.

import { generateText } from 'ai';
import { buildPilot, digest, PILOTS } from './_trail.js';
import { sendError } from './_lib.js';

const MODEL = 'anthropic/claude-haiku-4.5';

function fallback(d) {
  const total = d.publicScans + d.testScans;
  if (total === 0) return `No scans yet across the ${d.codes} ${d.city} Trail Line codes.`;
  const top = d.top[0] ? ` ${d.top[0].station} leads with ${d.top[0].scans}.` : '';
  const trend = d.thisWeek === d.lastWeek ? 'flat on last week' : d.thisWeek > d.lastWeek ? `up from ${d.lastWeek} last week` : `down from ${d.lastWeek} last week`;
  return `${total} scan${total === 1 ? '' : 's'} so far at ${d.stationsWithScans} of ${d.stations} stations — ${d.thisWeek} this week, ${trend}.${top}`
    + (!d.launchDate ? ' Launch date isn’t set, so every scan is counted as a pre-launch check.'
      : d.today < d.launchDate ? ` Signs install ${new Date(d.launchDate + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}; these are test scans until then.` : '');
}

export default async function handler(req, res) {
  try {
    const slug = (req.query && req.query.pilot) || 'las-vegas';
    if (!PILOTS[slug]) { res.status(404).json({ error: `Unknown pilot: ${slug}` }); return; }
    const d = digest(await buildPilot(slug));

    let text = null, source = 'computed';
    try {
      const out = await generateText({
        model: MODEL,
        maxOutputTokens: 220,
        system:
          'You write the one-glance status line for an internal dashboard tracking QR-code scans on a new outdoor trail signage pilot. '
          + 'Use ONLY the numbers given. 2-3 short sentences, plain English, no headings, no bullet points, no emoji. '
          + 'Say whether it is trending up or down week over week, name the strongest and any silent stations, and compare Map vs CTA codes when both have scans. '
          + 'If there is too little data to call a trend, say so plainly. If launchDate is null or still in the future (compare with today), say the scans so far are pre-install test scans and public tracking starts at launchDate.',
        prompt: JSON.stringify(d),
      });
      text = out.text.trim();
      source = 'ai';
    } catch (err) {
      console.warn('trail-summary: model unavailable, using computed summary:', err.message);
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({ text: text || fallback(d), source, digest: d, generatedAt: new Date().toISOString() });
  } catch (err) {
    sendError(res, err);
  }
}
