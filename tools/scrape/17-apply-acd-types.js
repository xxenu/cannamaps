// Apply ACD's authoritative type + open/closed status to shops.json.
// Dry run by default; pass --apply to write.
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/vuk/Documents/coding/apps/CannaMap';
const SHOPS = path.join(ROOT, 'public', 'data', 'shops.json');
const ACD = path.join(__dirname, 'acd-nationwide.json');
const DRY = process.argv[2] !== '--apply';

// ACD slug -> our shop_type (loose string, drives the map's filter chips)
const TYPE_MAP = { coffeeshop: 'coffeeshop', ss: 'smartshop', bar: 'bar', mus: 'museum' };

const doc = JSON.parse(fs.readFileSync(SHOPS, 'utf8'));
const acd = JSON.parse(fs.readFileSync(ACD, 'utf8')).shops;

const norm = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/coffeeshop|coffee shop|\bthe\b|\bde\b|\bhet\b/g, '')
  .replace(/[^a-z0-9]/g, '');
const cityKey = raw => {
  const s = String(raw || '');
  if (/gravenhage|den\s*haag|the\s*hague/i.test(s)) return 'denhaag';
  if (/hertogenbosch|den\s*bosch/i.test(s)) return 'denbosch';
  return norm(s);
};

const R = 6371000, rad = d => d * Math.PI / 180;
const metres = (a, b) => {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

const withCoords = acd.filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lng));
const byNameCity = new Map();
acd.forEach(a => {
  const k = norm(a.name) + '|' + cityKey(a.city);
  if (a.name && !byNameCity.has(k)) byNameCity.set(k, a);
});

const changes = { retype: [], toClosed: [], unmatched: [], matched: 0 };

for (const shop of doc.shops) {
  // 1) nearest ACD venue within 60m whose name also agrees
  let hit = null, best = Infinity;
  for (const a of withCoords) {
    const d = metres(shop, a);
    if (d > 60) continue;
    const nameHit = norm(a.name) && norm(shop.name) &&
      (norm(a.name) === norm(shop.name) ||
       norm(a.name).includes(norm(shop.name)) || norm(shop.name).includes(norm(a.name)));
    const score = d - (nameHit ? 200 : 0);
    if (score < best) { best = score; hit = { a, d, nameHit }; }
  }
  if (hit && !hit.nameHit && hit.d > 25) hit = null;

  // 2) fall back to exact name + city
  let a = hit ? hit.a : byNameCity.get(norm(shop.name) + '|' + cityKey(shop.city));
  if (!a) { if (shop.status === 'open') changes.unmatched.push(shop.name + ' — ' + shop.city); continue; }

  changes.matched++;
  const newType = TYPE_MAP[a.type] || shop.shop_type;
  if (newType !== shop.shop_type) {
    changes.retype.push({ name: shop.name, city: shop.city, from: shop.shop_type, to: newType, band: a.type_band });
    if (!DRY) shop.shop_type = newType;
  }
  if (a.closed && shop.status !== 'closed') {
    changes.toClosed.push({ name: shop.name, city: shop.city, band: a.type_band });
    if (!DRY) { shop.status = 'closed'; shop.closed_source = 'coffeeshopdirect.com'; }
  }
}

console.log(DRY ? '=== DRY RUN ===' : '=== APPLYING ===');
console.log('shops in map      :', doc.shops.length, '| open:', doc.shops.filter(s => s.status === 'open').length);
console.log('matched to ACD    :', changes.matched);
console.log('unmatched (open)  :', changes.unmatched.length);

const byTo = {};
changes.retype.forEach(c => (byTo[c.to] = byTo[c.to] || []).push(c));
console.log('\nreclassified      :', changes.retype.length);
Object.entries(byTo).forEach(([t, list]) => {
  console.log('  -> ' + t + ' (' + list.length + ')');
  list.slice(0, 12).forEach(c => console.log('       ', c.name.padEnd(30), c.city.padEnd(14), '|', c.band));
  if (list.length > 12) console.log('        ... and', list.length - 12, 'more');
});

console.log('\nmarked closed by ACD:', changes.toClosed.length);
changes.toClosed.slice(0, 15).forEach(c => console.log('   ', c.name.padEnd(30), c.city.padEnd(14), '|', c.band));
if (changes.toClosed.length > 15) console.log('    ... and', changes.toClosed.length - 15, 'more');

if (DRY) {
  const openAfter = doc.shops.filter(s => s.status === 'open').length
    - changes.toClosed.length
    - changes.retype.filter(c => c.to !== 'coffeeshop').length;
  console.log('\nprojected coffeeshops still on the map:', openAfter);
  console.log('\nno changes written. re-run with --apply');
  process.exit(0);
}

doc.generated_at = new Date().toISOString();
fs.writeFileSync(SHOPS, JSON.stringify(doc, null, 2) + '\n');
const open = doc.shops.filter(s => s.status === 'open');
const types = {};
open.forEach(s => types[s.shop_type] = (types[s.shop_type] || 0) + 1);
console.log('\nafter — open shops:', open.length);
console.log('by type:', types);
