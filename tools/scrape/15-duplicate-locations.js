// Find shops sitting on (almost) the same spot — usually one premises that has
// been renamed, where the old listing should be retired.
//
// Writes a review table with the signals needed to decide which is current.
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/vuk/Documents/coding/apps/CannaMap';
const SHOPS = path.join(ROOT, 'public', 'data', 'shops.json');
const AMS = path.join(ROOT, 'coffeeshopdata', 'amsterdam-coffeeshops.json');
const OUT_CSV = path.join(ROOT, 'coffeeshopdata', 'duplicate-locations.csv');
const OUT_MD = path.join(ROOT, 'coffeeshopdata', 'duplicate-locations.md');

const RADIUS_M = Number(process.argv[2]) || 40;

const doc = JSON.parse(fs.readFileSync(SHOPS, 'utf8'));
const ams = JSON.parse(fs.readFileSync(AMS, 'utf8')).shops;

// Extra evidence from the Amsterdam scrape: when its latest menu was posted.
const extraByPage = {};
ams.forEach(s => { extraByPage[s.page] = s; });

const R = 6371000, rad = d => d * Math.PI / 180;
function metres(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function evidence(shop) {
  const page = (shop.source_page || '').split('/').pop();
  const extra = extraByPage[page] || {};
  const days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  return {
    // Listed by Greenmeister = the up-to-date directory still carries it.
    on_greenmeister: shop.gm_url ? 'yes' : 'no',
    status: shop.status || 'open',
    has_hours: days.some(d => (shop.opening_hours || {})[d]) ? 'yes' : 'no',
    latest_menu: shop.latest_menu || extra.latest_menu || '',
    menu_archive: extra.archive_count || '',
    menus: (shop.menu_images || []).length,
    note: shop.note || ''
  };
}

// Cluster by proximity (simple transitive grouping; clusters are tiny).
const shops = doc.shops.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
const seen = new Set();
const clusters = [];

for (let i = 0; i < shops.length; i++) {
  if (seen.has(shops[i].id)) continue;
  const group = [shops[i]];
  seen.add(shops[i].id);
  for (let j = 0; j < shops.length; j++) {
    if (seen.has(shops[j].id)) continue;
    if (group.some(g => metres(g, shops[j]) <= RADIUS_M)) {
      group.push(shops[j]);
      seen.add(shops[j].id);
      j = -1; // restart: the group grew
    }
  }
  if (group.length > 1) clusters.push(group);
}

clusters.sort((a, b) => b.length - a.length || a[0].city.localeCompare(b[0].city));

// ---- CSV -------------------------------------------------------------------
const cols = ['group', 'name', 'city', 'address', 'metres_from_first',
              'on_greenmeister', 'status', 'has_hours', 'menus', 'latest_menu',
              'menu_archive', 'note', 'id'];
const cell = v => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const rows = [cols.join(',')];
clusters.forEach((group, gi) => {
  group.forEach(s => {
    const e = evidence(s);
    rows.push([gi + 1, s.name, s.city, s.address, Math.round(metres(group[0], s)),
               e.on_greenmeister, e.status, e.has_hours, e.menus, e.latest_menu,
               e.menu_archive, e.note, s.id].map(cell).join(','));
  });
});
fs.writeFileSync(OUT_CSV, rows.join('\n') + '\n');

// ---- Markdown --------------------------------------------------------------
const md = [];
md.push('# Shops on the same location');
md.push('');
md.push('Pins within **' + RADIUS_M + ' m** of each other — usually one premises that');
md.push('changed name. Decide which to keep, then delete the other by `id`.');
md.push('');
md.push('Signals, strongest first:');
md.push('');
md.push('- **greenmeister** — `no` means the up-to-date directory no longer lists it. Strongest hint it is defunct.');
md.push('- **status** — `closed` is coffeeshopmenus.org saying so outright.');
md.push('- **latest menu** — when its last menu was posted. An old date next to a recent one is decisive.');
md.push('- **note** — the source sometimes names the successor outright.');
md.push('');
md.push('_' + clusters.length + ' locations with more than one pin, ' +
        clusters.reduce((n, g) => n + g.length, 0) + ' shops involved._');
md.push('');

clusters.forEach((group, gi) => {
  md.push('## ' + (gi + 1) + '. ' + group[0].city + ' — ' + (group[0].address || ''));
  md.push('');
  md.push('| shop | greenmeister | status | hours | menus | latest menu | note | id |');
  md.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  group.forEach(s => {
    const e = evidence(s);
    const d = Math.round(metres(group[0], s));
    md.push('| ' + s.name + (d ? ' _(' + d + 'm)_' : '') + ' | ' + e.on_greenmeister +
            ' | ' + e.status + ' | ' + e.has_hours + ' | ' + e.menus + ' | ' +
            (e.latest_menu || '—') + ' | ' + (e.note || '—') + ' | `' + s.id + '` |');
  });
  md.push('');
});
fs.writeFileSync(OUT_MD, md.join('\n'));

// ---- console summary -------------------------------------------------------
const involved = clusters.reduce((n, g) => n + g.length, 0);
console.log('radius:', RADIUS_M + 'm');
console.log('locations with more than one pin:', clusters.length, '| shops involved:', involved);
console.log('cluster sizes:', clusters.reduce((acc, g) => {
  acc[g.length] = (acc[g.length] || 0) + 1; return acc;
}, {}));

const clearCut = clusters.filter(g => g.some(s => !s.gm_url) && g.some(s => s.gm_url));
console.log('clusters where one is on greenmeister and another is not:', clearCut.length,
            '(clearest old-vs-new cases)');
console.log('\nwrote:', path.relative(ROOT, OUT_MD), 'and', path.relative(ROOT, OUT_CSV));
