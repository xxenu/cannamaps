// Geocode shop addresses. PDOK Locatieserver (Dutch government, WGS84) first,
// Nominatim as a fallback for anything it can't place.
const fs = require('fs');

const DATA = '/Users/vuk/Documents/coding/apps/CannaMap/coffeeshopdata/amsterdam-coffeeshops.json';
const PDOK = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';
const NOMI = 'https://nominatim.openstreetmap.org/search';
const UA = 'CannaMap/0.1 (personal project; contact vukismiljanic@gmail.com)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Amsterdam bounding box — anything outside is a bad match.
const BOX = { minLat: 52.28, maxLat: 52.45, minLng: 4.72, maxLng: 5.08 };
const inBox = (lat, lng) => lat >= BOX.minLat && lat <= BOX.maxLat && lng >= BOX.minLng && lng <= BOX.maxLng;

async function pdok(query) {
  const url = PDOK + '?q=' + encodeURIComponent(query) + '&fq=type:adres&rows=1';
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('pdok HTTP ' + res.status);
  const json = await res.json();
  const doc = (json.response && json.response.docs || [])[0];
  if (!doc || !doc.centroide_ll) return null;
  const m = doc.centroide_ll.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/);
  if (!m) return null;
  return { lat: parseFloat(m[2]), lng: parseFloat(m[1]), via: 'pdok', matched: doc.weergavenaam || '' };
}

async function nominatim(query) {
  const url = NOMI + '?format=json&limit=1&countrycodes=nl&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('nominatim HTTP ' + res.status);
  const arr = await res.json();
  if (!arr.length) return null;
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon), via: 'nominatim', matched: arr[0].display_name || '' };
}

(async () => {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const shops = data.shops;
  console.log('to geocode:', shops.length);

  let ok = 0, viaN = 0, done = 0;
  const failed = [];

  // PDOK pass, small concurrency.
  const worker = async (queue) => {
    while (queue.length) {
      const s = queue.shift();
      const queries = [
        [s.street, s.postcode, s.city || 'Amsterdam'].filter(Boolean).join(' '),
        [s.postcode, s.city || 'Amsterdam'].filter(Boolean).join(' '),
        [s.street, 'Amsterdam'].filter(Boolean).join(' ')
      ].filter(q => q.trim());

      for (const q of queries) {
        try {
          const hit = await pdok(q);
          if (hit && inBox(hit.lat, hit.lng)) {
            Object.assign(s, hit, { geocode_query: q });
            ok++;
            break;
          }
        } catch (e) { /* try next query form */ }
        await sleep(120);
      }
      if (!s.lat) failed.push(s);
      done++;
      if (done % 50 === 0) console.log(' pdok ...', done, '/', shops.length);
      await sleep(120);
    }
  };
  const queue = shops.slice();
  await Promise.all(Array.from({ length: 3 }, () => worker(queue)));

  // Nominatim fallback, strictly sequential at 1 req/sec per their usage policy.
  console.log('\npdok placed:', ok, '| falling back for:', failed.length);
  for (const s of failed) {
    const q = [s.street, s.postcode, s.city || 'Amsterdam', 'Netherlands'].filter(Boolean).join(', ');
    try {
      const hit = await nominatim(q);
      if (hit && inBox(hit.lat, hit.lng)) { Object.assign(s, hit, { geocode_query: q }); viaN++; }
    } catch (e) { /* leave unplaced */ }
    await sleep(1100);
  }

  const placed = shops.filter(s => s.lat);
  const unplaced = shops.filter(s => !s.lat);
  data.geocoded_at = new Date().toISOString();
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');

  console.log('\nplaced:', placed.length, '/', shops.length, '(nominatim fallback:', viaN + ')');
  console.log('unplaced:', unplaced.map(s => s.name + ' | ' + s.address));
})();
