// Scrape coffeeshopmenus.org beyond Amsterdam: town_index.html lists 73 towns,
// each town page lists its shops. Collects menu photos, logos and addresses,
// and downloads the images.
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.coffeeshopmenus.org/';
const IMAGES = '/Users/vuk/Documents/coding/apps/CannaMap/coffeeshopmenus';
const OUT = path.join(__dirname, 'towns.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DELAY = 180;
const CONCURRENCY = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function req(url, binary, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(900 * (i + 1));
    }
  }
}

// Same page shape as the Amsterdam shop pages (see 3-shops-and-logos.js).
function parseShop(html) {
  const logo = (html.match(/<img[^>]+src="([^"]+)"[^>]*class="ShopPageLogo"/i)
    || html.match(/<h1>\s*<img[^>]+src="([^"]+)"/i) || [])[1] || null;

  const m = html.match(/<b>([^<]+)<\/b>\s*(\([^)]*\))?\s*,\s*([^<]*?)<br\s*\/?>/i);
  const name = m ? decode(m[1]) : null;
  const marker = m && m[2] ? decode(m[2]) : '';
  const addr = m ? decode(m[3]) : null;
  const status = /closed/i.test(marker) ? 'closed' : 'open';

  let street = addr || '', postcode = '', city = '';
  if (addr) {
    let rest = addr;
    const pc = rest.match(/\b(\d{4}\s?[A-Za-z]{2})\b/);
    if (pc) { postcode = pc[1].replace(/\s+/, ' ').toUpperCase(); rest = rest.replace(pc[0], ' '); }
    const parts = rest.split(',').map(decode).filter(Boolean);
    if (parts.length > 1) { city = parts.pop(); street = parts.join(', '); }
    else street = parts[0] || '';
  }

  const imgs = [...new Set(
    [...html.matchAll(/src="([^"]*\/Menus\/[^"]+\.(?:jpg|jpeg|png|gif|webp))"/gi)].map(x => x[1])
  )];

  return { name, status, address: addr, street, postcode, city, logo, imgs };
}

// "0-Alkmaar/AnyTime/Menus/x.jpg" -> folder "0-Alkmaar/AnyTime", file "x.jpg"
function splitAsset(webPath) {
  const parts = webPath.split('/');
  const file = parts[parts.length - 1];
  const folder = parts.slice(0, -2).join('/') || parts[0];
  return { folder, file };
}

(async () => {
  console.log('fetching town index...');
  const index = await req(BASE + 'town_index.html');
  const townPages = [...new Set(
    [...index.matchAll(/href="(town_[^"#]+\.html?)"/g)].map(m => m[1])
  )];
  console.log('town pages:', townPages.length);

  // town page -> shop pages
  const shopPages = new Map();   // cs-page -> town name
  for (const tp of townPages) {
    const html = await req(BASE + encodeURI(tp));
    if (!html) continue;
    const town = decode((html.match(/<title>([^<]*)<\/title>/) || [])[1] || tp);
    [...new Set([...html.matchAll(/href="(cs-[^"#]+\.html?)"/g)].map(m => m[1]))]
      .forEach(p => { if (!shopPages.has(p)) shopPages.set(p, town); });
    await sleep(DELAY);
  }
  console.log('shop pages found across towns:', shopPages.size);

  const results = [];
  const problems = [];
  let done = 0, menusSaved = 0, logosSaved = 0, bytes = 0;

  const worker = async (queue) => {
    while (queue.length) {
      const [page, town] = queue.shift();
      try {
        const html = await req(BASE + encodeURI(page));
        if (!html) { problems.push({ page, issue: '404' }); done++; continue; }
        const info = parseShop(html);

        const menu_files = [];
        for (let i = 0; i < info.imgs.length; i++) {
          const { folder, file } = splitAsset(info.imgs[i]);
          const dest = path.join(IMAGES, folder, file);
          try {
            if (!fs.existsSync(dest)) {
              const buf = await req(BASE + encodeURI(info.imgs[i]), true);
              if (!buf || buf.length < 100) throw new Error('empty image');
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, buf);
              bytes += buf.length;
              await sleep(DELAY);
            }
            menusSaved++;
            menu_files.push(path.relative(IMAGES, dest));
          } catch (e) {
            problems.push({ page, issue: 'menu image failed: ' + e.message });
          }
        }

        let logo_file = '';
        if (info.logo) {
          const parts = info.logo.split('/');
          const folder = parts.slice(0, -2).join('/') || parts[0];
          const dest = path.join(IMAGES, folder, 'logo' + (path.extname(info.logo) || '.png'));
          try {
            if (!fs.existsSync(dest)) {
              const buf = await req(BASE + encodeURI(info.logo), true);
              if (!buf || buf.length < 100) throw new Error('empty logo');
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, buf);
              bytes += buf.length;
              await sleep(DELAY);
            }
            logosSaved++;
            logo_file = path.relative(IMAGES, dest);
          } catch (e) {
            problems.push({ page, issue: 'logo failed: ' + e.message });
          }
        }

        results.push({
          page, town,
          name: info.name,
          status: info.status,
          address: info.address,
          street: info.street,
          postcode: info.postcode,
          city: info.city || town,
          menu_files, logo_file
        });
      } catch (e) {
        problems.push({ page, issue: String(e.message || e) });
      }
      done++;
      if (done % 50 === 0) console.log(' ...', done, '/', shopPages.size);
      await sleep(DELAY);
    }
  };

  const queue = [...shopPages.entries()];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  fs.writeFileSync(OUT, JSON.stringify({
    source: BASE + 'town_index.html',
    generated_at: new Date().toISOString(),
    count: results.length,
    shops: results
  }, null, 2) + '\n');

  const towns = {};
  results.forEach(r => { towns[r.city] = (towns[r.city] || 0) + 1; });
  console.log('\nshops parsed:', results.length, '| problems:', problems.length);
  console.log('menu photos:', menusSaved, '| logos:', logosSaved,
              '|', (bytes / 1048576).toFixed(1), 'MB downloaded');
  console.log('with >=1 menu photo:', results.filter(r => r.menu_files.length).length);
  console.log('towns covered:', Object.keys(towns).length);
  problems.slice(0, 8).forEach(p => console.log('  !', p.page, p.issue));
})();
