// Add shops that exist on coffeeshopmenus.org but not in Greenmeister's list.
// They arrive with menus, logos and an address but no coordinates, so they are
// geocoded through PDOK (same source used for the original Amsterdam set).
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/vuk/Documents/coding/apps/CannaMap';
const IMAGES = path.join(ROOT, 'coffeeshopmenus');
const SHOPS = path.join(ROOT, 'public', 'data', 'shops.json');
const TOWNS = path.join(__dirname, 'towns.json');
const OUT_MENUS = path.join(ROOT, 'public', 'data', 'menus');
const OUT_LOGOS = path.join(ROOT, 'public', 'data', 'logos');

const PDOK = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';
const UA = 'CannaMap/0.1 (personal project; contact vukismiljanic@gmail.com)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Roughly the Netherlands.
const inNL = (lat, lng) => lat > 50.7 && lat < 53.6 && lng > 3.3 && lng < 7.3;

const norm = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/coffeeshop|coffee shop|\bthe\b|\bde\b|\bhet\b/g, '')
  .replace(/[^a-z0-9]/g, '');
const slugify = s => String(s).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shop';

// Town pages spell some cities oddly; clean for geocoding and display.
function cleanCity(raw) {
  let c = String(raw || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (/gravenhage|den\s*haag|the\s*hague/i.test(raw)) c = 'Den Haag';
  else if (/hertogenbosch|den\s*bosch/i.test(raw)) c = "'s-Hertogenbosch";
  else if (/alkmaarn/i.test(raw)) c = 'Alkmaar';
  return c;
}

async function geocode(query) {
  const url = PDOK + '?q=' + encodeURIComponent(query) + '&fq=type:adres&rows=1';
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const doc = (json.response && json.response.docs || [])[0];
  if (!doc || !doc.centroide_ll) return null;
  const m = doc.centroide_ll.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/);
  if (!m) return null;
  return { lat: parseFloat(m[2]), lng: parseFloat(m[1]), matched: doc.weergavenaam || '' };
}

(async () => {
  const doc = JSON.parse(fs.readFileSync(SHOPS, 'utf8'));
  const towns = JSON.parse(fs.readFileSync(TOWNS, 'utf8')).shops;

  const mapNames = new Set(doc.shops.map(s => norm(s.name)));
  const ids = new Set(doc.shops.map(s => s.id));
  const candidates = towns.filter(t =>
    t.name && t.status !== 'closed' && !mapNames.has(norm(t.name)));

  console.log('town-only shops to add:', candidates.length);

  let added = 0, failed = [];

  for (const t of candidates) {
    const city = cleanCity(t.city);
    const queries = [
      [t.street, t.postcode, city].filter(Boolean).join(' '),
      [t.postcode, city].filter(Boolean).join(' '),
      [t.street, city].filter(Boolean).join(' ')
    ].filter(q => q.trim());

    let hit = null;
    for (const q of queries) {
      try {
        const r = await geocode(q);
        if (r && inNL(r.lat, r.lng)) { hit = r; break; }
      } catch (e) { /* try next form */ }
      await sleep(150);
    }
    await sleep(150);

    if (!hit) { failed.push(t.name + ' (' + city + ')'); continue; }

    let id = slugify(t.name + '-' + city), n = 2;
    while (ids.has(id)) id = slugify(t.name + '-' + city) + '-' + n++;
    ids.add(id);

    const menu_images = [];
    t.menu_files.forEach((rel, i) => {
      const src = path.join(IMAGES, rel);
      if (!fs.existsSync(src)) return;
      const file = id + '-' + (i + 1) + path.extname(rel).toLowerCase();
      fs.copyFileSync(src, path.join(OUT_MENUS, file));
      menu_images.push({ file: 'data/menus/' + file, label: 'Menu ' + (i + 1) });
    });

    let logo = '';
    if (t.logo_file) {
      const src = path.join(IMAGES, t.logo_file);
      if (fs.existsSync(src)) {
        const file = id + path.extname(t.logo_file).toLowerCase();
        fs.copyFileSync(src, path.join(OUT_LOGOS, file));
        logo = 'data/logos/' + file;
      }
    }

    doc.shops.push({
      id: id,
      name: t.name,
      shop_type: 'coffeeshop',
      status: 'open',
      city: city,
      lat: Number(hit.lat.toFixed(7)),
      lng: Number(hit.lng.toFixed(7)),
      address: [t.street, t.postcode, city].filter(Boolean).join(', '),
      logo: logo,
      website: '',
      instagram: '',
      opening_hours: {},
      hours_source: '',
      rating: null,
      rating_count: null,
      // Not corroborated by Greenmeister — listed only on coffeeshopmenus.org,
      // so it may be less current than the rest of the map.
      amenities: {},
      unverified: true,
      menu_images: menu_images,
      menu: [],
      note: '',
      coords_source: 'PDOK Locatieserver',
      source_page: 'https://www.coffeeshopmenus.org/' + t.page
    });
    added++;
  }

  doc.shops.sort((a, b) => (a.city + a.name).localeCompare(b.city + b.name));
  doc.generated_at = new Date().toISOString();
  fs.writeFileSync(SHOPS, JSON.stringify(doc, null, 2) + '\n');

  const open = doc.shops.filter(s => s.status === 'open');
  console.log('added:', added, '| could not geocode:', failed.length, failed.slice(0, 8));
  console.log('\ntotal shops:', doc.shops.length, '| open:', open.length);
  console.log('open with menu photos:', open.filter(s => s.menu_images.length).length);
  console.log('open with logo       :', open.filter(s => s.logo).length);
  console.log('cities:', new Set(open.map(s => s.city)).size);
})();
