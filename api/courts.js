// GET /api/courts — the map's single source for the QR code list.
//
// Lists every active Uniqode QR code named QR-* (Fitness Courts) or TL-*
// (Trail Line signs), joins exact per-code scan totals from the webhook
// archive (scan_totals), places each code (Design Lab station > Salesforce /
// hand override > Uniqode metadata > geocoded guess), and reconciles computed
// totals against Uniqode's official `scans` field.

import {
  fetchAllQRCodes,
  supabaseSelect,
  parseLocation,
  parseName,
  sendError,
  setCache,
} from './_lib.js';
import fs from 'node:fs';
import { trailStationPositions, placeTrailCodes } from './_trail.js';

// Court configuration from Salesforce (scripts/sync-configurations.mjs).
let courtConfig = {};
try { courtConfig = JSON.parse(fs.readFileSync(new URL('./_data/court-config.json', import.meta.url), 'utf8')); } catch {}
const CONFIG_LABEL = { 'Fitness Court': 'Fitness Court', 'Fitness Court Studio': 'Studio', 'Fitness Court Studio +': 'Studio +' };
const TRAIL_SIZE = { L: 'Large', M: 'Medium', S: 'Small' };
function configurationOf(c) {
  if (c.name.startsWith('TL-')) {
    const m = c.name.match(/^TL-[A-Za-z]{2}-[^-]+-([LMS])(?:-|$)/i);
    return m ? TRAIL_SIZE[m[1].toUpperCase()] : null;
  }
  const v = courtConfig[String(c.id)];
  return v ? CONFIG_LABEL[v] || v : null;
}

const RECONCILE_TOLERANCE = 2; // R11: delta ≤ 2 = matches Uniqode
// Complete per-scan history starts when the receive-scan webhook went live
// (2026-04-07). Before that, scan_logs only has a one-off backfill (loaded
// 2026-04-07, 41 codes), so a code created earlier can legitimately have
// Uniqode history we don't hold — and that backfill ran up to ~4% high on a
// few codes (Hernando County, Brownsville, Lake Merced) versus Uniqode today.
const ARCHIVE_START = '2026-04-07';
const BACKFILL_TOLERANCE = 0.05;

export default async function handler(req, res) {
  try {
    // Totals come from the webhook archive; if that read fails (the views
    // have been timing out), fall back to Uniqode's official per-code count
    // so the map still loads instead of 502ing.
    const warnings = [];
    const soft = (p, label) => p.catch((err) => { warnings.push(`${label}: ${err.message}`); return null; });
    const [codes, totalsRows, suggestionRows, linkRows, stationSets] = await Promise.all([
      fetchAllQRCodes(),
      soft(supabaseSelect('scan_totals?select=qr_id,human_scans,bot_scans&order=qr_id.asc'), 'scan_totals'),
      soft(supabaseSelect('qr_location_suggestions?select=qr_id,lat,lon,source&order=qr_id.asc'), 'suggestions'),
      // Salesforce Site__c coordinates, synced by scripts/sync-salesforce-locations.mjs.
      soft(supabaseSelect('qr_site_links?select=qr_id,sf_site_id,sf_site_name,lat,lon&lat=not.is.null&order=qr_id.asc'), 'qr_site_links'),
      // Trail line signs are placed from the Design Lab station layer.
      soft(trailStationPositions(), 'trail positions'),
    ]);
    const trailPos = placeTrailCodes(codes, stationSets || []);
    const archiveOk = totalsRows !== null;
    const totals = totalsRows || [];
    const suggestions = suggestionRows || [];
    const siteById = new Map((linkRows || []).map((l) => [String(l.qr_id), l]));

    const totalsById = new Map(totals.map((t) => [String(t.qr_id), t]));
    const suggestionById = new Map(suggestions.map((s) => [String(s.qr_id), s]));

    const courts = codes
      .filter((c) => (c.name.startsWith('QR') || c.name.startsWith('TL-')) && c.state === 'A')
      .map((c) => {
        const loc = parseLocation(c.metadata);
        const named = parseName(c.name);
        // Archive down: show Uniqode's official total so the map still works,
        // but say reconciliation is unknown rather than claiming a match.
        const t = totalsById.get(String(c.id)) ||
          (archiveOk ? { human_scans: 0, bot_scans: 0 } : { human_scans: c.scans ?? 0, bot_scans: 0 });
        const computedAll = t.human_scans + t.bot_scans;
        const official = c.scans ?? 0;
        const delta = archiveOk ? official - computedAll : null;
        const preArchive = (c.created || '').slice(0, 10) < ARCHIVE_START;
        // Location precedence:
        //   salesforce = the court's Site__c geo location (source of truth)
        //   uniqode    = exact coords hand-entered in Uniqode metadata
        //   geocoded   = guessed from the code's name, awaiting confirmation
        // locationStatus keeps the UI's three states: verified | approx | missing.
        const site = siteById.get(String(c.id)) || trailPos.get(String(c.id));
        const suggestion = suggestionById.get(String(c.id));
        // Name-geocoded guesses are no longer plotted: a confident pin in the
        // wrong place (e.g. the SF Welcome Sign dropped on Union Square) is
        // worse than none. They stay listed under Needs Location Verification,
        // with the guess kept as suggestedLat/Lon for reference.
        const locationSource = trailPos.has(String(c.id)) ? 'designlab' : site ? (site.sf_site_id ? 'salesforce' : 'override') : loc.hasLocation ? 'uniqode' : null;
        // Pop-ups and sandwich boards move around — nothing to verify.
        const mobile = /popup|sandwich/i.test(c.name);
        const locationStatus = locationSource ? 'verified' : mobile ? 'mobile' : 'missing';
        const lat = site ? site.lat : loc.hasLocation ? loc.lat : null;
        const lon = site ? site.lon : loc.hasLocation ? loc.lon : null;
        return {
          id: c.id,
          name: c.name,
          kind: c.name.startsWith('TL-') ? 'trail' : 'court',
          configuration: configurationOf(c),
          state: named.state,
          city: named.city,
          location: named.location,
          url: c.url,
          created: c.created,
          lat,
          lon,
          address: loc.address,
          hasLocation: locationStatus === 'verified',
          locationStatus,
          locationSource,
          suggestedLat: !locationSource && suggestion ? suggestion.lat : null,
          suggestedLon: !locationSource && suggestion ? suggestion.lon : null,
          sfSiteId: site?.sf_site_id ?? null,
          sfSiteName: site?.sf_site_name ?? null,
          officialScans: official,
          humanScans: t.human_scans,
          botScans: t.bot_scans,
          reconciled: !archiveOk ? null : Math.abs(delta) <= RECONCILE_TOLERANCE
            || (preArchive && (delta > 0 || -delta <= Math.max(RECONCILE_TOLERANCE, official * BACKFILL_TOLERANCE))),
          preArchive,
          delta,
        };
      })
      .sort((a, b) => b.humanScans - a.humanScans);

    const needsLocation = courts.filter((c) => c.locationStatus === 'missing' || c.locationStatus === 'approx').map((c) => c.id);
    const reconciledCount = courts.filter((c) => c.reconciled === true).length;
    const approxCount = courts.filter((c) => c.locationStatus === 'approx').length;

    setCache(res, { degraded: warnings.length > 0 });
    res.status(200).json({
      courts,
      needsLocation,
      summary: {
        totalCourts: courts.length,
        plotted: courts.filter((c) => c.lat != null && c.lon != null).length,
        approx: approxCount,
        needsLocation: needsLocation.length,
        humanScans: courts.reduce((s, c) => s + c.humanScans, 0),
        botScans: courts.reduce((s, c) => s + c.botScans, 0),
        officialScans: courts.reduce((s, c) => s + c.officialScans, 0),
        reconciled: reconciledCount,
        // null = unknown (archive unavailable), not "fine".
        reconciliationOk: archiveOk ? reconciledCount === courts.length : null,
      },
      archiveOk,
      warnings,
      lastSynced: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
}
