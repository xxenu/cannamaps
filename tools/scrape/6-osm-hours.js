// Pull opening_hours for Amsterdam coffeeshops from OpenStreetMap via Overpass,
// match them to our shops by proximity + name, and convert OSM's opening_hours
// syntax into the "HH:MM-HH:MM" per-day format shops.json uses.
const fs = require('fs');
const path = require('path');

const DATA = '/Users/vuk/Documents/coding/apps/CannaMap/coffeeshopdata/amsterdam-coffeeshops.json';
const OUT = path.join(__dirname, 'osm-hours.json');
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const UA = 'CannaMap/0.1 (personal project; contact vukismiljanic@gmail.com)';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const OSM_DAYS = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };

// Amsterdam bounding box (south, west, north, east).
const BBOX = '52.28,4.72,52.45,5.08';

// Dutch coffeeshops are tagged shop=cannabis in OSM (shop=coffeeshop is not a
// real tag — that returns nothing). The name regex catches the stragglers that
// are tagged as plain cafes.
const QUERY = `[out:json][timeout:120];
(
  nwr["shop"="cannabis"](${BBOX});
  nwr["name"~"[Cc]offee[ ]?shop"](${BBOX});
);
out tags center;`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function overpass() {
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(QUERY)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      console.log('  endpoint failed (' + url + '):', e.message);
      await sleep(1500);
    }
  }
  throw new Error('all Overpass endpoints failed');
}

// --- opening_hours parsing -------------------------------------------------

const toMin = t => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const toHHMM = mins => String(Math.floor(mins / 60)).padStart(2, '0') + ':' +
                       String(mins % 60).padStart(2, '0');

/* Handles the common subset: "Mo-Su 09:00-01:00", "Mo-Th 10:00-24:00; Fr,Sa
 * 10:00-02:00", "24/7", "Su off". Anything with holidays, month ranges,
 * "sunrise", or week numbers is rejected outright rather than half-guessed. */
const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i;

function parseOpeningHours(raw) {
  if (!raw) return null;
  let value = raw.trim();
  if (/easter|sunrise|sunset|week\s/i.test(value)) return null;

  // Some values separate rules with commas rather than semicolons:
  // "Su-Th 08:00-24:00, Fr,Sa 08:00-01:00". A comma only starts a new rule
  // when the text before it ended with a time, otherwise it's a day list.
  value = value.replace(/(?<=\d{1,2}:\d{2})\s*,\s*(?=[A-Za-z])/g, '; ');

  const out = {};
  DAYS.forEach(d => { out[d] = null; });

  if (/^24\/7$/i.test(value)) {
    DAYS.forEach(d => { out[d] = '00:00-24:00'; });
    return { hours: out, split: 0 };
  }

  let splitDays = 0;
  const rules = value.split(';').map(s => s.trim()).filter(Boolean);
  if (!rules.length) return null;

  for (const rule of rules) {
    const m = /^([A-Za-z,\-\s]+?)\s+(.+)$/.exec(rule) ||
              (/^\d/.test(rule) ? [null, 'Mo-Su', rule] : null);
    if (!m) return null;

    const dayPart = m[1].trim();
    const timePart = m[2].trim();

    // Which days does this rule cover?
    const idxs = [];
    for (const token of dayPart.split(',')) {
      const t = token.trim().toLowerCase();
      if (!t) continue;
      const range = /^([a-z]{2})\s*-\s*([a-z]{2})$/.exec(t);
      if (range) {
        const a = OSM_DAYS[range[1]], b = OSM_DAYS[range[2]];
        if (a === undefined || b === undefined) return null;
        for (let i = a; ; i = (i + 1) % 7) { idxs.push(i); if (i === b) break; }
      } else {
        const d = OSM_DAYS[t];
        if (d === undefined) return null;
        idxs.push(d);
      }
    }
    if (!idxs.length) return null;

    if (/^(off|closed)$/i.test(timePart)) {
      idxs.forEach(i => { out[DAYS[i]] = null; });
      continue;
    }

    // One or more spans: "09:00-12:00,13:00-18:00"
    const spans = timePart.split(',').map(s => s.trim()).filter(Boolean);
    const parsed = [];
    for (const span of spans) {
      const sm = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(span);
      if (!sm) return null;
      const open = toMin(sm[1]), close = toMin(sm[2]);
      if (open === null || close === null) return null;
      parsed.push({ open, close });
    }
    if (!parsed.length) return null;
    if (parsed.length > 1) splitDays += idxs.length;

    // shops.json holds one span per day; for split hours take first open to
    // last close and record that we did so.
    const open = parsed[0].open;
    const close = parsed[parsed.length - 1].close;
    idxs.forEach(i => { out[DAYS[i]] = toHHMM(open) + '-' + toHHMM(close); });
  }

  return DAYS.some(d => out[d]) ? { hours: out, split: splitDays } : null;
}

// --- matching --------------------------------------------------------------

const R = 6371000;
const rad = d => d * Math.PI / 180;
function metres(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const norm = s => String(s || '').toLowerCase()
  .replace(/coffeeshop|coffee shop|the |'s\b/g, '')
  .replace(/[^a-z0-9]/g, '');

(async () => {
  console.log('querying Overpass for Amsterdam cannabis POIs...');
  const json = await overpass();
  const elements = (json.elements || []).map(e => ({
    name: (e.tags || {}).name || '',
    hours_raw: (e.tags || {}).opening_hours || '',
    lat: e.lat != null ? e.lat : (e.center || {}).lat,
    lng: e.lon != null ? e.lon : (e.center || {}).lon
  })).filter(e => e.lat != null && e.lng != null);

  const withHours = elements.filter(e => e.hours_raw);
  console.log('OSM POIs:', elements.length, '| with opening_hours:', withHours.length);

  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const shops = data.shops;

  let matched = 0, parsedOk = 0, unparsed = [], splitTotal = 0;
  const result = {};

  for (const shop of shops) {
    let best = null, bestScore = Infinity;
    for (const e of withHours) {
      const d = metres(shop, e);
      if (d > 150) continue;
      const nameHit = norm(shop.name) && norm(e.name) &&
        (norm(shop.name) === norm(e.name) ||
         norm(e.name).includes(norm(shop.name)) ||
         norm(shop.name).includes(norm(e.name)));
      // Distance, with a strong bonus for a name match.
      const score = d - (nameHit ? 120 : 0);
      if (score < bestScore) { bestScore = score; best = { e, d, nameHit }; }
    }
    if (!best) continue;
    // Accept a close name match further out, or any POI very close by.
    if (!best.nameHit && best.d > 45) continue;
    matched++;

    const parsed = parseOpeningHours(best.e.hours_raw);
    if (!parsed) { unparsed.push({ shop: shop.name, raw: best.e.hours_raw }); continue; }
    parsedOk++;
    splitTotal += parsed.split;
    result[shop.page] = {
      shop: shop.name,
      osm_name: best.e.name,
      distance_m: Math.round(best.d),
      name_match: best.nameHit,
      raw: best.e.hours_raw,
      opening_hours: parsed.hours
    };
  }

  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    source: 'OpenStreetMap via Overpass API (ODbL)',
    matched: parsedOk,
    hours: result
  }, null, 2) + '\n');

  console.log('\nmatched to our shops:', matched, '| hours parsed:', parsedOk,
              '(' + (parsedOk / shops.length * 100).toFixed(0) + '% of 250)');
  console.log('days with split hours (merged to first open -> last close):', splitTotal);
  console.log('unparsed formats:', unparsed.length);
  unparsed.slice(0, 10).forEach(u => console.log('  -', u.shop, '=>', u.raw));
})();
