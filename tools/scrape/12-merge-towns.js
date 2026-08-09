// Attach the town-scraped menu photos and logos to shops.json.
//
// The town pages carry no coordinates, so matching is on normalised name plus
// city, with a name-only fallback when that name is unique nationwide.
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/vuk/Documents/coding/apps/CannaMap';
const IMAGES = path.join(ROOT, 'coffeeshopmenus');
const SHOPS = path.join(ROOT, 'public', 'data', 'shops.json');
const TOWNS = path.join(__dirname, 'towns.json');
const OUT_MENUS = path.join(ROOT, 'public', 'data', 'menus');
const OUT_LOGOS = path.join(ROOT, 'public', 'data', 'logos');

const norm = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/coffeeshop|coffee shop|\bthe\b|\bde\b|\bhet\b/g, '')
  .replace(/[^a-z0-9]/g, '');

/* The two sources spell cities differently, and one has a typo. Map both sides
 * onto a single key: "'s-Gravenhage ( Den Haag )", "The Hague" and "Den Haag"
 * are the same place. */
const CITY_ALIASES = [
  [/gravenhage|den\s*haag|the\s*hague/i, 'denhaag'],
  [/hertogenbosch|den\s*bosch/i, 'denbosch'],
  [/alkmaarn?/i, 'alkmaar'],
  [/amsterdam/i, 'amsterdam'],
  [/rotterdam/i, 'rotterdam']
];
function cityKey(raw) {
  const s = String(raw || '');
  for (const [re, key] of CITY_ALIASES) if (re.test(s)) return key;
  return norm(s);
}

// House number, for disambiguating two shops that share a name.
const houseNo = s => (String(s || '').match(/\b(\d+)\b/) || [])[1] || '';

const doc = JSON.parse(fs.readFileSync(SHOPS, 'utf8'));
const towns = JSON.parse(fs.readFileSync(TOWNS, 'utf8')).shops;

// Index the map's shops for lookup.
const byNameCity = new Map();
const byName = new Map();
for (const s of doc.shops) {
  const n = norm(s.name);
  if (!n) continue;
  byNameCity.set(n + '|' + cityKey(s.city), s);
  if (!byName.has(n)) byName.set(n, []);
  byName.get(n).push(s);
}

fs.mkdirSync(OUT_MENUS, { recursive: true });
fs.mkdirSync(OUT_LOGOS, { recursive: true });

let matched = 0, unmatched = [], menusAdded = 0, logosAdded = 0, skippedHad = 0;

for (const t of towns) {
  if (!t.name) continue;
  const n = norm(t.name);

  let shop = byNameCity.get(n + '|' + cityKey(t.city));
  if (!shop) {
    const candidates = byName.get(n) || [];
    if (candidates.length === 1) {
      shop = candidates[0];                              // unique name nationwide
    } else if (candidates.length > 1 && houseNo(t.street)) {
      // Same name in several cities: pick the one on the same house number.
      shop = candidates.find(c => houseNo(c.address) === houseNo(t.street));
    }
  }
  if (!shop) { unmatched.push(t.name + ' (' + t.city + ')'); continue; }
  matched++;

  // Don't clobber photos a shop already has (the Amsterdam set).
  if (shop.menu_images && shop.menu_images.length) { skippedHad++; }
  else if (t.menu_files.length) {
    const images = [];
    t.menu_files.forEach((rel, i) => {
      const src = path.join(IMAGES, rel);
      if (!fs.existsSync(src)) return;
      const file = shop.id + '-' + (i + 1) + path.extname(rel).toLowerCase();
      fs.copyFileSync(src, path.join(OUT_MENUS, file));
      images.push({ file: 'data/menus/' + file, label: 'Menu ' + (i + 1) });
      menusAdded++;
    });
    if (images.length) shop.menu_images = images;
  }

  if (!shop.logo && t.logo_file) {
    const src = path.join(IMAGES, t.logo_file);
    if (fs.existsSync(src)) {
      const file = shop.id + path.extname(t.logo_file).toLowerCase();
      fs.copyFileSync(src, path.join(OUT_LOGOS, file));
      shop.logo = 'data/logos/' + file;
      logosAdded++;
    }
  }

  if (!shop.source_page) shop.source_page = 'https://www.coffeeshopmenus.org/' + t.page;
}

doc.generated_at = new Date().toISOString();
fs.writeFileSync(SHOPS, JSON.stringify(doc, null, 2) + '\n');

const open = doc.shops.filter(s => s.status === 'open');
console.log('town shops:', towns.length, '| matched to map:', matched,
            '| unmatched:', unmatched.length);
console.log('menu photos added:', menusAdded, '| logos added:', logosAdded,
            '| already had photos:', skippedHad);
console.log('\nopen shops with menu photos:', open.filter(s => s.menu_images.length).length,
            '/', open.length);
console.log('open shops with a logo   :', open.filter(s => s.logo).length, '/', open.length);
console.log('\nfirst unmatched:', unmatched.slice(0, 12));
