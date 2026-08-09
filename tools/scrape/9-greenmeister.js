// Scrape greenmeister.com for every coffeeshop in the Netherlands.
//
// Each shop page carries schema.org JSON-LD (name, coordinates, address,
// 5-star aggregateRating, per-day opening hours). The amenity flags are only
// in the markup: a struck-through label means the shop does NOT have it.
//
// Shop URLs come from the site's own sitemap. robots.txt permits /coffeeshop/
// (it disallows only /profile, /feed, /favorites, /addme).
const fs = require('fs');
const path = require('path');

const SITEMAP = 'https://en.greenmeister.com/sitemap-main.xml';
const OUT = path.join(__dirname, 'greenmeister.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DELAY = 250;
const CONCURRENCY = 3;

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1200 * (i + 1));
    }
  }
}

function parseStore(html) {
  const m = html.match(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let json;
  try { json = JSON.parse(m[1]); } catch (e) { return null; }
  const graph = json['@graph'] || [json];
  return graph.find(x => x['@type'] === 'Store') || null;
}

function parseHours(store) {
  const spec = store.openingHoursSpecification;
  if (!Array.isArray(spec)) return null;
  const out = {};
  DAYS.forEach(d => { out[d] = null; });
  let found = 0;
  for (const s of spec) {
    const day = String(s.dayOfWeek || '').toLowerCase().replace(/^https?:\/\/schema\.org\//, '');
    if (!DAYS.includes(day)) continue;
    const opens = /^\d{1,2}:\d{2}$/.test(s.opens || '') ? s.opens : null;
    const closes = /^\d{1,2}:\d{2}$/.test(s.closes || '') ? s.closes : null;
    if (opens && closes) {
      // "10:00-00:00" means closes at midnight; keep as-is, the app treats a
      // closing time <= opening time as running past midnight.
      out[day] = opens.padStart(5, '0') + '-' + closes.padStart(5, '0');
      found++;
    }
  }
  return found ? out : null;
}

/* Amenity rows render as an icon plus a label; unavailable ones carry
 * class="line-through" on the label. */
function parseAmenities(html) {
  const re = /<div class="flex items-center text-sm text-gray[^"]*">[\s\S]{0,900}?<span([^>]*)>\s*([^<]+?)\s*<\/span>/g;
  const out = {};
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = m[2].replace(/\s+/g, ' ').trim();
    if (!label || label.length > 40) continue;
    out[slug(label)] = { label: label, available: !/line-through/.test(m[1]) };
  }
  return out;
}

(async () => {
  console.log('fetching sitemap...');
  const xml = await get(SITEMAP);
  const urls = [...new Set(
    (xml.match(/<loc>([^<]+)<\/loc>/g) || [])
      .map(l => l.replace(/<\/?loc>/g, ''))
      .filter(u => /\/coffeeshop\/[^/]+$/.test(u))
  )];
  console.log('coffeeshop pages:', urls.length);

  const shops = [];
  const problems = [];
  let done = 0, withHours = 0, withAmenities = 0;
  const amenitySeen = {};

  const worker = async (queue) => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const html = await get(url);
        if (!html) { problems.push({ url, issue: '404' }); done++; continue; }

        const store = parseStore(html);
        if (!store) { problems.push({ url, issue: 'no JSON-LD Store' }); done++; continue; }

        const hours = parseHours(store);
        if (hours) withHours++;

        const amenities = parseAmenities(html);
        if (Object.keys(amenities).length) withAmenities++;
        Object.values(amenities).forEach(a => {
          amenitySeen[a.label] = (amenitySeen[a.label] || 0) + 1;
        });

        // aggregateRating is intentionally not collected — the app maintains
        // its own ratings, so importing someone else's would only conflict.
        const addr = store.address || {};
        shops.push({
          gm_url: url,
          gm_slug: url.split('/').pop(),
          name: store.name || '',
          street: addr.streetAddress || '',
          city: addr.addressLocality || '',
          postcode: addr.postalCode || '',
          country: addr.addressCountry || 'NL',
          lat: store.geo ? Number(store.geo.latitude) : null,
          lng: store.geo ? Number(store.geo.longitude) : null,
          opening_hours: hours,
          amenities: amenities
        });
      } catch (e) {
        problems.push({ url, issue: String(e.message || e) });
      }
      done++;
      if (done % 100 === 0) console.log(' ...', done, '/', urls.length);
      await sleep(DELAY);
    }
  };

  const queue = urls.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  shops.sort((a, b) => (a.city + a.name).localeCompare(b.city + b.name));
  fs.writeFileSync(OUT, JSON.stringify({
    source: 'greenmeister.com',
    generated_at: new Date().toISOString(),
    count: shops.length,
    shops: shops
  }, null, 2) + '\n');

  const cities = {};
  shops.forEach(s => { cities[s.city] = (cities[s.city] || 0) + 1; });

  console.log('\nshops parsed:', shops.length, '| problems:', problems.length);
  console.log('with coords:', shops.filter(s => s.lat).length,
              '| hours:', withHours, '| amenities:', withAmenities);
  console.log('\namenity labels seen across all shops:');
  Object.entries(amenitySeen).sort((a, b) => b[1] - a[1])
    .forEach(([label, n]) => console.log('   ', String(n).padStart(4), label));
  console.log('\ntop cities:');
  Object.entries(cities).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([c, n]) => console.log('   ', String(n).padStart(4), c));
  problems.slice(0, 8).forEach(p => console.log('  !', p.url, p.issue));
})();
