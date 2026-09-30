// GET /api/courts — the map's single source for the QR code list.
//
// Lists every active Uniqode QR code whose name starts with "QR", joins exact
// per-code scan totals from the cleaned webhook archive (scan_totals view),
// reads locations ONLY from Uniqode metadata (lat/lon/address keys), and
// reconciles computed totals against Uniqode's official `scans` field.
// Codes without valid coordinates are returned in the same list with
// hasLocation:false — visible, never plotted at a guess.

import {
  fetchAllQRCodes,
  supabaseSelect,
  parseLocation,
  parseName,
  sendError,
  setCache,
} from './_lib.js';
import { trailCodePositions } from './_trail.js';

const RECONCILE_TOLERANCE = 2; // R11: delta ≤ 2 = matches Uniqode
// Per-day webhook archive begins here. Codes created before this date have
// official totals that legitimately include scans we have no event rows for —
// that surplus is expected history, not drift.
const ARCHIVE_START = '2025-06-04';

export default async function handler(req, res) {
  try {
    // Totals come from the webhook archive; if that read fails (the views
    // have been timing out), fall back to Uniqode's official per-code count
    // so the map still loads instead of 502ing.
    const warnings = [];
    const soft = (p, label) => p.catch((err) => { warnings.push(`${label}: ${err.message}`); return null; });
    const [codes, totalsRows, suggestionRows, linkRows] = await Promise.all([
      fetchAllQRCodes(),
      soft(supabaseSelect('scan_totals?select=qr_id,human_scans,bot_scans'), 'scan_totals'),
      soft(supabaseSelect('qr_location_suggestions?select=qr_id,lat,lon,source'), 'suggestions'),
      // Salesforce Site__c coordinates, synced by scripts/sync-salesforce-locations.mjs.
      soft(supabaseSelect('qr_site_links?select=qr_id,sf_site_id,sf_site_name,lat,lon&lat=not.is.null'), 'qr_site_links'),
    ]);
    // Trail line signs are placed from the Design Lab station layer.
    const trailPos = await trailCodePositions(codes).catch((err) => {
      warnings.push(`trail positions: ${err.message}`);
      return new Map();
    });
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
        const t = totalsById.get(String(c.id)) ||
          (archiveOk ? { human_scans: 0, bot_scans: 0 } : { human_scans: c.scans ?? 0, bot_scans: 0 });
        const computedAll = t.human_scans + t.bot_scans;
        const official = c.scans ?? 0;
        const delta = official - computedAll;
        const preArchive = (c.created || '').slice(0, 10) < ARCHIVE_START;
        // Location precedence:
        //   salesforce = the court's Site__c geo location (source of truth)
        //   uniqode    = exact coords hand-entered in Uniqode metadata
        //   geocoded   = guessed from the code's name, awaiting confirmation
        // locationStatus keeps the UI's three states: verified | approx | missing.
        const site = siteById.get(String(c.id)) || trailPos.get(String(c.id));
        const suggestion = suggestionById.get(String(c.id));
        const locationSource = trailPos.has(String(c.id)) ? 'designlab' : site ? 'salesforce' : loc.hasLocation ? 'uniqode' : suggestion ? 'geocoded' : null;
        // Pop-ups and sandwich boards move around — nothing to verify.
        const mobile = /popup|sandwich/i.test(c.name);
        const locationStatus = locationSource === 'geocoded' ? 'approx' : locationSource ? 'verified' : mobile ? 'mobile' : 'missing';
        const lat = site ? site.lat : loc.hasLocation ? loc.lat : suggestion ? suggestion.lat : null;
        const lon = site ? site.lon : loc.hasLocation ? loc.lon : suggestion ? suggestion.lon : null;
        return {
          id: c.id,
          name: c.name,
          kind: c.name.startsWith('TL-') ? 'trail' : 'court',
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
          sfSiteId: site?.sf_site_id ?? null,
          sfSiteName: site?.sf_site_name ?? null,
          officialScans: official,
          humanScans: t.human_scans,
          botScans: t.bot_scans,
          reconciled: Math.abs(delta) <= RECONCILE_TOLERANCE || (preArchive && delta > 0),
          preArchive,
          delta,
        };
      })
      .sort((a, b) => b.humanScans - a.humanScans);

    const needsLocation = courts.filter((c) => c.locationStatus === 'missing' || c.locationStatus === 'approx').map((c) => c.id);
    const reconciledCount = courts.filter((c) => c.reconciled).length;
    const approxCount = courts.filter((c) => c.locationStatus === 'approx').length;

    setCache(res);
    res.status(200).json({
      courts,
      needsLocation,
      summary: {
        totalCourts: courts.length,
        plotted: courts.length - needsLocation.length,
        approx: approxCount,
        needsLocation: needsLocation.length,
        humanScans: courts.reduce((s, c) => s + c.humanScans, 0),
        botScans: courts.reduce((s, c) => s + c.botScans, 0),
        officialScans: courts.reduce((s, c) => s + c.officialScans, 0),
        reconciled: reconciledCount,
        reconciliationOk: reconciledCount === courts.length,
      },
      archiveOk,
      warnings,
      lastSynced: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
}
