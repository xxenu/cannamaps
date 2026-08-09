// Merge ACD + OSM detail into public/data/shops.json:
//   opening_hours  ACD first, OSM to fill gaps
//   lat/lng        ACD where present (fixes PDOK street mismatches), else PDOK
//   contact        website / Instagram only (no phone numbers)
// No third-party ratings are imported; the app maintains its own.
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const SHOPS = '/Users/vuk/Documents/coding/apps/CannaMap/public/data/shops.json';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const acd = JSON.parse(fs.readFileSync(path.join(HERE, 'acd-details.json'), 'utf8')).details;
const osm = fs.existsSync(path.join(HERE, 'osm-hours.json'))
  ? JSON.parse(fs.readFileSync(path.join(HERE, 'osm-hours.json'), 'utf8')).hours : {};

const doc = JSON.parse(fs.readFileSync(SHOPS, 'utf8'));

const R = 6371000, rad = d => d * Math.PI / 180;
function metres(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

let fromAcd = 0, fromOsm = 0, none = 0, moved = [], contacts = 0;

for (const shop of doc.shops) {
  const page = (shop.source_page || '').split('/').pop();
  const a = acd[page];
  const o = osm[page];

  // --- opening hours -------------------------------------------------------
  if (a && a.opening_hours) {
    shop.opening_hours = a.opening_hours;
    shop.hours_source = 'coffeeshopdirect.com';
    fromAcd++;
  } else if (o && o.opening_hours) {
    shop.opening_hours = o.opening_hours;
    shop.hours_source = 'OpenStreetMap (ODbL)';
    fromOsm++;
  } else {
    shop.opening_hours = {};
    shop.hours_source = '';
    none++;
  }

  // --- coordinates ---------------------------------------------------------
  if (a && Number.isFinite(a.lat) && Number.isFinite(a.lng)) {
    const shift = metres(shop, { lat: a.lat, lng: a.lng });
    if (shift > 150) moved.push({ name: shop.name, metres: Math.round(shift) });
    shop.lat = Number(a.lat.toFixed(7));
    shop.lng = Number(a.lng.toFixed(7));
    shop.coords_source = 'coffeeshopdirect.com';
  } else {
    shop.coords_source = 'PDOK Locatieserver';
  }

  // --- contact + ACD rating ------------------------------------------------
  // Website and Instagram only — no phone numbers.
  shop.website = (a && a.website) || '';
  shop.instagram = (a && a.instagram) || '';
  if (shop.website || shop.instagram) contacts++;

  // No third-party ratings are imported at all — the app keeps its own.
  if (a && a.acd_url) shop.acd_url = a.acd_url;
}

doc.generated_at = new Date().toISOString();
doc.source = 'coffeeshopmenus.org (menus, logos) + coffeeshopdirect.com (hours, contact, coords) + PDOK (fallback coords)';
fs.writeFileSync(SHOPS, JSON.stringify(doc, null, 2) + '\n');

const open = doc.shops.filter(s => s.status === 'open');
const openWithHours = open.filter(s => DAYS.some(d => s.opening_hours[d]));
console.log('hours from ACD:', fromAcd, '| from OSM:', fromOsm, '| none:', none);
console.log('open shops with hours:', openWithHours.length, '/', open.length,
            '(' + (openWithHours.length / open.length * 100).toFixed(0) + '%)');
console.log('contact details:', contacts);
console.log('coordinates corrected by >150m:', moved.length, moved);
