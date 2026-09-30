// Shared helpers for the API gateway. Secrets come from Vercel env vars only.

const UNIQODE_BASE = 'https://api.uniqode.com/api/2.0';

export function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export async function uniqodeFetch(path) {
  const resp = await fetch(`${UNIQODE_BASE}${path}`, {
    headers: { Authorization: `Token ${env('UNIQODE_API_KEY')}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new UpstreamError(`Uniqode ${resp.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

// Pages through /qrcodes/ and returns every QR code object in the account.
export async function fetchAllQRCodes() {
  const results = [];
  let path = '/qrcodes/?limit=100';
  while (path) {
    const page = await uniqodeFetch(path);
    results.push(...page.results);
    path = page.next ? page.next.replace(UNIQODE_BASE, '') : null;
  }
  return results;
}

export async function supabaseSelect(pathAndQuery) {
  const url = `${env('SUPABASE_URL')}/rest/v1/${pathAndQuery}`;
  const key = env('SUPABASE_SERVICE_KEY');
  const rows = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const resp = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${from + PAGE - 1}`,
        'Range-Unit': 'items',
      },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new UpstreamError(`Supabase ${resp.status} on ${pathAndQuery}: ${body.slice(0, 200)}`);
    }
    const page = await resp.json();
    rows.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

export class UpstreamError extends Error {}

export function sendError(res, err) {
  const status = err instanceof UpstreamError ? 502 : 500;
  res.status(status).json({ error: String(err.message || err) });
}

export function setCache(res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
}

// Valid plotting coordinates only — anything else means "needs location verification".
export function parseLocation(metadata) {
  const m = metadata || {};
  const lat = Number(m.lat);
  const lon = Number(m.lon);
  const valid =
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(lat === 0 && lon === 0);
  return {
    lat: valid ? lat : null,
    lon: valid ? lon : null,
    address: typeof m.address === 'string' && m.address.trim() ? m.address.trim() : null,
    hasLocation: valid,
  };
}

// Best-effort display parsing of the QR-{ST}-{City}-{Location} naming convention.
// Regional batches like QR-TX-DFW-GrandPrairie-Tyre are split to their real
// city (Grand Prairie) so each site ranks and plots individually.
export function parseName(name) {
  const spaced = (s) =>
    s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  const parts = name.split('-');
  const noStateSuffix = (city, st) => city.replace(new RegExp('\\s*' + st + '$', 'i'), '').trim();
  if (parts[0] === 'QR' && parts[2] === 'DFW' && parts.length >= 5) {
    return {
      state: parts[1],
      city: noStateSuffix(spaced(parts[3]), parts[1]),
      location: spaced(parts.slice(4).join(' ')),
    };
  }
  if (parts.length === 3 && parts[0] === 'QR') {
    return { state: parts[1], city: spaced(parts[2]), location: spaced(parts[2]) };
  }
  if (parts.length >= 4 && (parts[0] === 'QR' || parts[0] === 'TL')) {
    return {
      state: parts[1],
      city: spaced(parts[2]),
      location: spaced(parts.slice(3).join(' ')),
    };
  }
  return { state: '', city: '', location: spaced(name) };
}
