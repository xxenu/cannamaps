// Expand shops.json from Amsterdam-only to the whole Netherlands.
//
// Greenmeister supplies the nationwide list plus amenities, per-day hours and
// 5-star ratings. Where a Greenmeister shop is the same place as one we already
// scraped for Amsterdam, the existing menu photos and logo are carried over.
const fs = require('fs');
const path = require('path');

const SHOPS = '/Users/vuk/Documents/coding/apps/CannaMap/public/data/shops.json';
const GM = path.join(__dirname, 'greenmeister.json');

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const MATCH_METRES = 150;

const doc = JSON.parse(fs.readFileSync(SHOPS, 'utf8'));
const gm = JSON.parse(fs.readFileSync(GM, 'utf8')).shops;

const R = 6371000, rad = d => d * Math.PI / 180;
function metres(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const norm = s => String(s || '').toLowerCase()
  .replace(/coffeeshop|coffee shop|\bthe\b/g, '').replace(/[^a-z0-9]/g, '');

/* Greenmeister shipped at least one shop with latitude and longitude the wrong
 * way round (Aarden in Vlissingen landed in the Indian Ocean). Anything outside
 * the Netherlands gets swapped if that fixes it, and dropped if it doesn't. */
const inNL = (lat, lng) => lat > 50.7 && lat < 53.6 && lng > 3.3 && lng < 7.3;
function saneCoords(lat, lng, name) {
  if (inNL(lat, lng)) return { lat: lat, lng: lng };
  if (inNL(lng, lat)) {
    console.log('  ! swapped lat/lng for', name);
    return { lat: lng, lng: lat };
  }
  console.log('  ! coordinates outside NL, dropped:', name, lat, lng);
  return null;
}

const slugify = s => String(s).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shop';

const existing = doc.shops.slice();
const usedExisting = new Set();
const out = [];
const ids = new Set();

function uniqueId(base) {
  let id = base, n = 2;
  while (ids.has(id)) id = base + '-' + n++;
  ids.add(id);
  return id;
}

let merged = 0, fresh = 0;

for (const g of gm) {
  if (!Number.isFinite(g.lat) || !Number.isFinite(g.lng)) continue;
  const fixed = saneCoords(g.lat, g.lng, g.name);
  if (!fixed) continue;
  g.lat = fixed.lat;
  g.lng = fixed.lng;

  // Find the same shop in what we already have: close by, ideally same name.
  let best = null, bestScore = Infinity;
  for (const e of existing) {
    if (usedExisting.has(e)) continue;
    const d = metres(g, e);
    if (d > MATCH_METRES) continue;
    const nameHit = norm(g.name) && norm(e.name) &&
      (norm(g.name) === norm(e.name) ||
       norm(g.name).includes(norm(e.name)) || norm(e.name).includes(norm(g.name)));
    const score = d - (nameHit ? 200 : 0);
    if (score < bestScore) { bestScore = score; best = { e, d, nameHit }; }
  }
  // Without a name match, only a very close pin counts as the same shop.
  if (best && !best.nameHit && best.d > 40) best = null;

  const e = best ? best.e : null;
  if (e) { usedExisting.add(e); merged++; } else { fresh++; }

  const id = uniqueId(e ? e.id : slugify(g.name + '-' + g.city));

  out.push({
    id: id,
    name: g.name || (e && e.name) || 'Unnamed',
    shop_type: 'coffeeshop',
    status: 'open',                     // Greenmeister lists operating shops
    city: g.city || '',
    lat: Number(g.lat.toFixed(7)),
    lng: Number(g.lng.toFixed(7)),
    address: [g.street, g.postcode, g.city].filter(Boolean).join(', '),
    logo: e ? e.logo : '',
    website: (e && e.website) || '',
    instagram: (e && e.instagram) || '',
    // Greenmeister hours are per-day and current; fall back to what we had.
    opening_hours: g.opening_hours || (e ? e.opening_hours : {}) || {},
    hours_source: g.opening_hours ? 'greenmeister.com' : (e ? e.hours_source : ''),
    // Ratings are deliberately not imported — the app has its own rating
    // system. These stay null as placeholders for it.
    rating: null,
    rating_count: null,
    amenities: g.amenities || {},
    menu_images: e ? e.menu_images : [],
    menu: [],
    note: (e && e.note) || '',
    gm_url: g.gm_url,
    source_page: (e && e.source_page) || ''
  });
}

// Anything we already had that Greenmeister doesn't list (closed / historic
// Amsterdam shops) is kept, so their menu archive isn't lost.
let keptOld = 0;
for (const e of existing) {
  if (usedExisting.has(e)) continue;
  keptOld++;
  out.push(Object.assign({}, e, {
    id: uniqueId(e.id),
    city: e.city || 'Amsterdam',
    amenities: e.amenities || {},
    rating: null,
    rating_count: null
  }));
}

out.sort((a, b) => (a.city + a.name).localeCompare(b.city + b.name));

doc.version = 3;
doc.generated_at = new Date().toISOString();
doc.source = 'greenmeister.com (nationwide list, amenities, hours, ratings) + ' +
             'coffeeshopmenus.org (menu photos, logos) + coffeeshopdirect.com (contact)';
doc.shops = out;
fs.writeFileSync(SHOPS, JSON.stringify(doc, null, 2) + '\n');

const open = out.filter(s => s.status === 'open');
const cities = {};
open.forEach(s => { cities[s.city] = (cities[s.city] || 0) + 1; });

console.log('greenmeister shops:', gm.length);
console.log('  merged with existing:', merged, '| new:', fresh);
console.log('kept (not on greenmeister, mostly closed):', keptOld);
console.log('total shops:', out.length, '| open:', open.length);
console.log('open with hours   :', open.filter(s => DAYS.some(d => s.opening_hours[d])).length);
console.log('open with rating  :', open.filter(s => typeof s.rating === 'number').length);
console.log('open with amenities:', open.filter(s => Object.keys(s.amenities).length).length);
console.log('open with menu pic:', open.filter(s => s.menu_images.length).length);
console.log('cities:', Object.keys(cities).length);
