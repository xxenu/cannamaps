/* Replay manual corrections on top of a freshly-scraped shops.json.
 *
 * The scrape steps rebuild shops.json from the sources, which silently undoes
 * every hand correction: renames, address fixes, merges, deletions, brand
 * logos. This is the last step in the pipeline and puts them back.
 *
 * Everything here is declarative and idempotent — running it twice changes
 * nothing the second time, so it is safe to run after any step.
 *
 *   node tools/scrape/19-apply-overrides.js            # dry run (default)
 *   node tools/scrape/19-apply-overrides.js --apply    # write
 *
 * Order matters: retype/patch/rename touch records, merge folds one into
 * another, delete removes, and brand logos are stamped last so a renamed shop
 * still picks up its brand mark.
 */
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/vuk/Documents/coding/apps/CannaMap';
const SHOPS = path.join(ROOT, 'public', 'data', 'shops.json');
const OVERRIDES = path.join(__dirname, 'overrides.json');
const LOGO_DIR = path.join(ROOT, 'public', 'data', 'logos');
const DRY = process.argv[2] !== '--apply';

const doc = JSON.parse(fs.readFileSync(SHOPS, 'utf8'));
const ov = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));

const byId = id => doc.shops.find(s => s.id === id);
const log = [];
const warn = [];
const noop = [];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 1. shop_type corrections ---------------------------------------------
(ov.retype || []).forEach(r => {
  const s = byId(r.id);
  if (!s) return warn.push(`retype: no shop "${r.id}"`);
  if (s.shop_type === r.shop_type) return noop.push(`retype ${r.id} (already ${r.shop_type})`);
  log.push(`retype ${r.id}: ${s.shop_type} -> ${r.shop_type}`);
  if (!DRY) s.shop_type = r.shop_type;
});

// ---- 2. field patches (address, coords, hours) -----------------------------
(ov.patch || []).forEach(p => {
  const s = byId(p.id);
  if (!s) return warn.push(`patch: no shop "${p.id}"`);
  const changed = Object.keys(p.set).filter(k => !same(s[k], p.set[k]));
  if (!changed.length) return noop.push(`patch ${p.id} (already correct)`);
  log.push(`patch ${p.id}: ${changed.join(', ')}`);
  if (!DRY) changed.forEach(k => { s[k] = p.set[k]; });
});

// ---- 3. renames ------------------------------------------------------------
(ov.rename || []).forEach(r => {
  const s = byId(r.id);
  if (!s) return warn.push(`rename: no shop "${r.id}"`);
  if (s.name === r.name) return noop.push(`rename ${r.id} (already "${r.name}")`);
  log.push(`rename ${r.id}: "${s.name}" -> "${r.name}"`);
  if (!DRY) s.name = r.name;
});

// ---- 4. merges -------------------------------------------------------------
// Fold `from` into `into`, filling only fields the survivor lacks, then drop
// the source record. Never overwrites good data on the survivor.
const FILLABLE = ['website', 'instagram', 'logo', 'address', 'note', 'gm_url'];
(ov.merge || []).forEach(m => {
  const from = byId(m.from);
  const into = byId(m.into);
  if (!into) return warn.push(`merge: no target "${m.into}"`);
  if (!from) return noop.push(`merge ${m.from} -> ${m.into} (source already gone)`);

  const filled = FILLABLE.filter(k => !into[k] && from[k]);
  const hoursFrom = Object.values(from.opening_hours || {}).filter(Boolean).length;
  const hoursInto = Object.values(into.opening_hours || {}).filter(Boolean).length;
  const takeHours = hoursInto === 0 && hoursFrom > 0;
  // Only carry over images that are actually on disk. A record can outlive its
  // files (the source shop's photos get deleted when it is retired), and a
  // dangling reference shows up as a broken image in the gallery.
  const menus = (from.menu_images || [])
    .filter(mi => !(into.menu_images || []).some(x => x.file === mi.file))
    .filter(mi => {
      const there = fs.existsSync(path.join(ROOT, 'public', mi.file));
      if (!there) noop.push(`merge ${m.from}: skipped missing ${mi.file}`);
      return there;
    });

  log.push(`merge ${m.from} -> ${m.into}` +
    (filled.length ? ` (fills ${filled.join(', ')})` : '') +
    (takeHours ? ' (+hours)' : '') +
    (menus.length ? ` (+${menus.length} menu images)` : ''));
  if (!DRY) {
    filled.forEach(k => { into[k] = from[k]; });
    if (takeHours) into.opening_hours = from.opening_hours;
    if (menus.length) {
      into.menu_images = (into.menu_images || []).concat(menus)
        .map(function (mi, i) { return { file: mi.file, label: 'Menu ' + (i + 1) }; });
    }
    doc.shops = doc.shops.filter(s => s.id !== m.from);
  }
});

// ---- 5. deletions ----------------------------------------------------------
(ov.delete || []).forEach(d => {
  let victims;
  if (d.id) {
    victims = doc.shops.filter(s => s.id === d.id);
  } else if (d.match) {
    // Matcher form for records whose id may differ between rebuilds. Every
    // supplied field must match, so a name alone can never take out a
    // same-named shop in another city.
    victims = doc.shops.filter(s => Object.keys(d.match).every(k =>
      String(s[k] || '').toLowerCase().indexOf(String(d.match[k]).toLowerCase()) !== -1));
  } else {
    return warn.push('delete: entry has neither id nor match');
  }

  if (!victims.length) return noop.push(`delete ${d.id || JSON.stringify(d.match)} (already gone)`);
  if (victims.length > 1) {
    return warn.push(`delete ${d.id || JSON.stringify(d.match)}: matches ${victims.length} shops ` +
      `(${victims.map(v => v.name + ' @ ' + v.city).join('; ')}) — refusing, tighten the matcher`);
  }
  log.push(`delete ${victims[0].id} — ${victims[0].name}, ${victims[0].city}`);
  if (!DRY) doc.shops = doc.shops.filter(s => s !== victims[0]);
});

// ---- 6. brand logos --------------------------------------------------------
// Stamped last so renamed shops are matched under their new name.
(ov.brand_logos || []).forEach(b => {
  const src = path.join(__dirname, b.file);
  if (!fs.existsSync(src)) return warn.push(`brand logo missing: ${b.file}`);
  const brand = fs.readFileSync(src);
  // Either every shop whose name contains a string (a chain), or an explicit
  // list of ids when only some branches should carry the mark.
  const label = b.name_contains || (b.ids || []).join(', ');
  const hits = b.ids
    ? b.ids.map(byId).filter(Boolean)
    : doc.shops.filter(s => s.name.toLowerCase().indexOf(b.name_contains) !== -1);
  if (!hits.length) return warn.push(`brand logo "${label}": no shops matched`);

  let written = 0, already = 0;
  hits.forEach(s => {
    const rel = 'data/logos/' + s.id + '.png';
    const dest = path.join(LOGO_DIR, s.id + '.png');
    const current = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    if (current && current.equals(brand) && s.logo === rel) { already++; return; }
    written++;
    if (!DRY) {
      fs.mkdirSync(LOGO_DIR, { recursive: true });
      fs.writeFileSync(dest, brand);
      s.logo = rel;
    }
  });
  const line = `brand logo "${label}": ${hits.length} shops` +
               (written ? ` (${written} to write, ${already} already correct)` : '');
  (written ? log : noop).push(line);
});

// ---- 7. owner-supplied menu photos ----------------------------------------
// Photos the owner sent us directly, not scraped. A re-scrape would overwrite
// the file under data/menus/, so the pristine copy lives in owner-assets/ and
// is stamped back over the top.
const MENU_DIR = path.join(ROOT, 'public', 'data', 'menus');
(ov.menu_images || []).forEach(entry => {
  const s = byId(entry.id);
  if (!s) return warn.push(`menu_images: no shop "${entry.id}"`);

  const wanted = [];
  entry.files.forEach((rel, i) => {
    const src = path.join(__dirname, rel);
    if (!fs.existsSync(src)) { warn.push(`menu_images: missing source ${rel}`); return; }
    const destRel = 'data/menus/' + s.id + '-' + (i + 1) + path.extname(rel);
    const dest = path.join(ROOT, 'public', destRel);
    const current = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    const brand = fs.readFileSync(src);
    if (!current || !current.equals(brand)) {
      if (!DRY) { fs.mkdirSync(MENU_DIR, { recursive: true }); fs.writeFileSync(dest, brand); }
      wanted.push({ file: destRel, label: 'Menu ' + (i + 1), wrote: true });
    } else {
      wanted.push({ file: destRel, label: 'Menu ' + (i + 1), wrote: false });
    }
  });

  const list = wanted.map(w => ({ file: w.file, label: w.label }));
  const changed = wanted.some(w => w.wrote) || !same(s.menu_images, list);
  if (!changed) return noop.push(`menu_images ${entry.id} (already correct)`);
  log.push(`menu_images ${entry.id}: ${list.length} owner-supplied photo(s)`);
  if (!DRY) s.menu_images = list;
});

// ---- report ----------------------------------------------------------------
console.log(DRY ? '=== DRY RUN ===' : '=== APPLYING ===');
console.log('shops before:', doc.shops.length);
console.log('\nchanges (' + log.length + '):');
log.forEach(l => console.log('   ' + l));
if (noop.length) {
  console.log('\nalready in place (' + noop.length + '):');
  noop.forEach(l => console.log('   ' + l));
}
if (warn.length) {
  console.log('\nWARNINGS (' + warn.length + '):');
  warn.forEach(l => console.log('   !! ' + l));
}

if (DRY) {
  console.log('\nnothing written. re-run with --apply');
  process.exit(warn.length ? 1 : 0);
}

doc.generated_at = new Date().toISOString();
fs.writeFileSync(SHOPS, JSON.stringify(doc, null, 2) + '\n');
console.log('\nshops after :', doc.shops.length,
            '| open:', doc.shops.filter(s => s.status === 'open').length);
console.log('written to', SHOPS);
process.exit(warn.length ? 1 : 0);
