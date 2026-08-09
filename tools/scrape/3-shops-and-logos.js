// Re-crawl shop pages for logo URL + address, download logos, emit CSV.
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.coffeeshopmenus.org/';
const MENUS = '/Users/vuk/Documents/coding/apps/CannaMap/coffeeshopmenus';
const CSVDIR = '/Users/vuk/Documents/coding/apps/CannaMap/coffeeshopdata';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DELAY = 150;
const CONCURRENCY = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function req(url, binary, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(900 * (i + 1));
    }
  }
}

function parseShop(html, page) {
  // Logo: <img src="Amnesia/GFX/logo.png" ... class="ShopPageLogo">
  const logo = (html.match(/<img[^>]+src="([^"]+)"[^>]*class="ShopPageLogo"/i)
    || html.match(/<h1>\s*<img[^>]+src="([^"]+)"/i) || [])[1] || null;

  // Address line, with an optional status marker before the comma:
  //   <b>Amnesia</b>, Herengracht 133, 1015 BG Amsterdam<br>
  //   <b>Abraxas Too</b> (Closed), Spuistraat 51, 1012 ST Amsterdam<br>
  const m = html.match(/<b>([^<]+)<\/b>\s*(\([^)]*\))?\s*,\s*([^<]*?)<br\s*\/?>/i);
  const name = m ? decode(m[1]) : null;
  const marker = m && m[2] ? decode(m[2]) : '';
  const addr = m ? decode(m[3]) : null;
  const status = /closed/i.test(marker) ? 'closed' : 'open';

  // The postcode sits either before or after the city depending on the page,
  // so pull it out wherever it is and treat the last comma field as the city.
  let street = addr || '', postcode = '', city = '';
  if (addr) {
    let rest = addr;
    const pc = rest.match(/\b(\d{4}\s?[A-Za-z]{2})\b/);
    if (pc) { postcode = pc[1].replace(/\s+/, ' ').toUpperCase(); rest = rest.replace(pc[0], ' '); }
    const parts = rest.split(',').map(s => decode(s)).filter(Boolean);
    if (parts.length > 1) { city = parts.pop(); street = parts.join(', '); }
    else { street = parts[0] || ''; }
  }

  // Free-text note on the following line, e.g. "(Historic coffeeshop)".
  const noteM = html.match(/<br\s*\/?>\s*\(((?:Previously|Historic|Later|Now|Formerly)[^)]*)\)\s*<br/i);
  const note = noteM ? decode(noteM[1].replace(/<[^>]+>/g, '')) : '';

  const date = (html.match(/<hr>\s*<br>\s*([0-9]{1,2}\s+\w+\s+[0-9]{4})/i) || [])[1] || '';
  const archive = (html.match(/complete archive of (\d+)/i) || [])[1] || '';

  return { page, name, status, note, address: addr, street, postcode, city,
           logo, latest_menu: date, archive_count: archive };
}

const csvCell = v => {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

(async () => {
  const { results } = JSON.parse(fs.readFileSync(__dirname + '/menu-index.json', 'utf8'));
  const menuFolder = {};
  results.forEach(r => { if (r.imgs[0]) menuFolder[r.page] = r.imgs[0].split('/')[0]; });

  const pages = results.map(r => r.page);
  console.log('shop pages:', pages.length);

  const rows = [];
  const problems = [];
  let done = 0, logosSaved = 0, logoBytes = 0;

  const worker = async (queue) => {
    while (queue.length) {
      const page = queue.shift();
      try {
        const html = await req(BASE + encodeURI(page), false);
        const info = parseShop(html, page);
        info.folder = menuFolder[page] || (info.logo ? info.logo.split('/')[0] : '');
        info.menu_count = results.find(r => r.page === page).imgs.length;

        if (!info.address) problems.push({ page, issue: 'no address parsed' });
        if (!info.logo) problems.push({ page, issue: 'no logo found' });

        // Download the logo into the shop's existing folder.
        if (info.logo && info.folder) {
          const ext = path.extname(info.logo.split('?')[0]) || '.png';
          const dest = path.join(MENUS, info.folder, 'logo' + ext);
          try {
            if (!fs.existsSync(dest)) {
              const buf = await req(BASE + encodeURI(info.logo), true);
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, buf);
              logoBytes += buf.length;
              await sleep(DELAY);
            }
            info.logo_file = path.relative(MENUS, dest);
            logosSaved++;
          } catch (e) {
            problems.push({ page, issue: 'logo download failed: ' + e.message });
            info.logo_file = '';
          }
        } else {
          info.logo_file = '';
        }

        rows.push(info);
      } catch (e) {
        problems.push({ page, issue: 'page failed: ' + e.message });
      }
      done++;
      if (done % 50 === 0) console.log(' ...', done, '/', pages.length);
      await sleep(DELAY);
    }
  };

  const queue = pages.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const cols = ['name', 'status', 'street', 'postcode', 'city', 'address', 'folder',
                'logo_file', 'menu_count', 'archive_count', 'latest_menu', 'note', 'source_page'];
  const csv = [cols.join(',')].concat(rows.map(r => cols.map(c =>
    csvCell(c === 'source_page' ? BASE + r.page : r[c])).join(','))).join('\n') + '\n';

  fs.mkdirSync(CSVDIR, { recursive: true });
  fs.writeFileSync(path.join(CSVDIR, 'amsterdam-coffeeshops.csv'), csv);
  fs.writeFileSync(path.join(CSVDIR, 'amsterdam-coffeeshops.json'),
    JSON.stringify({ source: BASE + 'ams_index.html', generated_at: new Date().toISOString(),
                     count: rows.length, shops: rows }, null, 2) + '\n');

  console.log('\nrows:', rows.length, '| logos saved:', logosSaved,
              '|', (logoBytes / 1048576).toFixed(1), 'MB');
  console.log('with address:', rows.filter(r => r.address).length,
              '| with postcode:', rows.filter(r => r.postcode).length);
  console.log('problems:', problems.length);
  problems.slice(0, 15).forEach(p => console.log('  -', p.page, p.issue));
})();
