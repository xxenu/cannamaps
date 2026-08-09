// Repair logos that collided in the original scrape.
//
// 3-shops-and-logos.js saved every logo as "<folder>/logo.png". Where two shops
// share a source folder but have different logo filenames (Dutch Flowers/GFX/
// dflogo.png vs Dutch Flowers/GFX/logo.png), the second download hit the
// existsSync guard and silently reused the first shop's file.
//
// This re-fetches each shop's own logo straight into public/data/logos/<id>.png,
// keyed by the source path, so shared folders can no longer collide.
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/vuk/Documents/coding/apps/CannaMap';
const SHOPS = path.join(ROOT, 'public', 'data', 'shops.json');
const AMS = path.join(ROOT, 'coffeeshopdata', 'amsterdam-coffeeshops.json');
const OUT_LOGOS = path.join(ROOT, 'public', 'data', 'logos');
const BASE = 'https://www.coffeeshopmenus.org/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBuf(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error('empty');
      return buf;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

(async () => {
  const doc = JSON.parse(fs.readFileSync(SHOPS, 'utf8'));
  const ams = JSON.parse(fs.readFileSync(AMS, 'utf8')).shops;

  // page -> true source logo path, e.g. "Dutch Flowers/GFX/dflogo.png"
  const logoByPage = {};
  ams.forEach(s => { if (s.logo) logoByPage[s.page] = s.logo; });

  let fixed = 0, unchanged = 0, failed = [];

  for (const shop of doc.shops) {
    const page = (shop.source_page || '').split('/').pop();
    const srcPath = logoByPage[page];
    if (!srcPath) continue;

    try {
      const buf = await fetchBuf(BASE + encodeURI(srcPath));
      const dest = path.join(OUT_LOGOS, shop.id + path.extname(srcPath).toLowerCase());
      const before = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
      fs.writeFileSync(dest, buf);
      shop.logo = 'data/logos/' + path.basename(dest);
      if (before && before.equals(buf)) unchanged++; else fixed++;
      await sleep(150);
    } catch (e) {
      failed.push(shop.name + ': ' + e.message);
    }
  }

  doc.generated_at = new Date().toISOString();
  fs.writeFileSync(SHOPS, JSON.stringify(doc, null, 2) + '\n');

  console.log('logos re-fetched from their own source path');
  console.log('  changed  :', fixed);
  console.log('  identical:', unchanged);
  console.log('  failed   :', failed.length, failed.slice(0, 6));
})();
