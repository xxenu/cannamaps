// Build public/data/shops.json from the scraped + geocoded dataset,
// and copy menu photos and logos into public/data/.
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/vuk/Documents/coding/apps/CannaMap';
const SRC_IMAGES = path.join(ROOT, 'coffeeshopmenus');
const DATA = path.join(ROOT, 'coffeeshopdata', 'amsterdam-coffeeshops.json');
const OUT_DATA = path.join(ROOT, 'public', 'data');
const OUT_MENUS = path.join(OUT_DATA, 'menus');
const OUT_LOGOS = path.join(OUT_DATA, 'logos');

const slug = s => String(s).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'shop';

// Menus belong to the shop page they were found on. Several shops share a
// premises folder (a shop and its later renaming), so keying by folder would
// hand each of them the other's menus.
const crawl = JSON.parse(fs.readFileSync(__dirname + '/menu-index.json', 'utf8'));
const menusByPage = {};
crawl.results.forEach(r => { menusByPage[r.page] = r.imgs; });

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));

// Wipe previously copied placeholders so the folders reflect this build only.
[OUT_MENUS, OUT_LOGOS].forEach(dir => {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
});

const ids = new Set();
const shops = [];
let menuCopied = 0, logoCopied = 0, bytes = 0;

for (const s of data.shops) {
  let id = slug(s.name);
  let n = 2;
  while (ids.has(id)) id = slug(s.name) + '-' + n++;
  ids.add(id);

  // Menu photos -> data/menus/<id>-<n>.jpg
  const menu_images = [];
  const page = s.page;
  (menusByPage[page] || []).forEach((webPath, i) => {
    // webPath is site-relative, e.g. "Amnesia/Menus/060626.jpg"; on disk the
    // download flattened it to "<folder>/<file>".
    const parts = webPath.split('/');
    const rel = path.join(parts[0], parts[parts.length - 1]);
    const src = path.join(SRC_IMAGES, rel);
    if (!fs.existsSync(src)) return;
    const file = id + '-' + (i + 1) + path.extname(rel).toLowerCase();
    fs.copyFileSync(src, path.join(OUT_MENUS, file));
    bytes += fs.statSync(src).size;
    menuCopied++;
    menu_images.push({ file: 'data/menus/' + file, label: 'Menu ' + (i + 1) });
  });

  // Logo -> data/logos/<id>.png
  let logo = '';
  if (s.logo_file) {
    const src = path.join(SRC_IMAGES, s.logo_file);
    if (fs.existsSync(src)) {
      const file = id + path.extname(s.logo_file).toLowerCase();
      fs.copyFileSync(src, path.join(OUT_LOGOS, file));
      bytes += fs.statSync(src).size;
      logoCopied++;
      logo = 'data/logos/' + file;
    }
  }

  shops.push({
    id: id,
    name: s.name,
    shop_type: 'coffeeshop',
    status: s.status,
    lat: Number(s.lat.toFixed(7)),
    lng: Number(s.lng.toFixed(7)),
    address: s.address,
    logo: logo,
    // The source publishes no trading hours or ratings; leaving these empty
    // rather than inventing them. The UI renders "not listed" for both.
    opening_hours: {},
    rating: null,
    menu_images: menu_images,
    menu: [],
    note: s.note || '',
    latest_menu: s.latest_menu || '',
    source_page: 'https://www.coffeeshopmenus.org/' + s.page
  });
}

shops.sort((a, b) => a.name.localeCompare(b.name));

fs.writeFileSync(path.join(OUT_DATA, 'shops.json'), JSON.stringify({
  version: 2,
  generated_at: new Date().toISOString(),
  source: 'coffeeshopmenus.org (menus, logos, addresses) + PDOK Locatieserver (coordinates)',
  shops: shops
}, null, 2) + '\n');

const open = shops.filter(s => s.status === 'open');
console.log('shops:', shops.length, '| open:', open.length, '| closed:', shops.length - open.length);
console.log('menu photos copied:', menuCopied, '| logos copied:', logoCopied);
console.log('copied size:', (bytes / 1048576).toFixed(1), 'MB');
console.log('shops with >=1 menu photo:', shops.filter(s => s.menu_images.length).length);
console.log('shops with a logo:', shops.filter(s => s.logo).length);
console.log('open shops missing a menu photo:', open.filter(s => !s.menu_images.length).map(s => s.name));
