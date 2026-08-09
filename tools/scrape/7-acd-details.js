// Pull per-shop detail from coffeeshopdirect.com (ACD): opening hours, phone,
// website/socials and coordinates. Ratings are not collected — the app keeps
// its own.
//
// The ACD page for each shop is linked directly from its coffeeshopmenus page,
// so the URL is read rather than guessed from the name.
const fs = require('fs');
const path = require('path');

const BASE_MENUS = 'https://www.coffeeshopmenus.org/';
const DATA = '/Users/vuk/Documents/coding/apps/CannaMap/coffeeshopdata/amsterdam-coffeeshops.json';
const OUT = path.join(__dirname, 'acd-details.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DELAY = 200;
const CONCURRENCY = 3;

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_BY_ABBR = { sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday',
                      thu: 'thursday', fri: 'friday', sat: 'saturday' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE_MENUS } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(900 * (i + 1));
    }
  }
}

/* "7 a.m." -> "07:00", "1 a.m." -> "01:00", "7.30 p.m." -> "19:30",
 * "noon" -> "12:00", "midnight" -> "00:00". Returns null for anything else. */
function parseClock(raw) {
  const t = strip(raw).toLowerCase().replace(/\./g, m => m).trim();
  if (!t || /closed/.test(t)) return null;
  if (/^noon$/.test(t)) return '12:00';
  if (/^midnight$/.test(t)) return '00:00';

  const m = /^(\d{1,2})(?:[.:](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const mer = (m[3] || '').replace(/\./g, '');
  if (mer === 'pm' && h !== 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  if (h > 24 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

function parseHours(html) {
  const i = html.indexOf('hoursBox');
  if (i === -1) return null;
  const end = html.indexOf('</table>', i);
  if (end === -1) return null;
  const table = html.slice(i, end);

  const out = {};
  DAYS.forEach(d => { out[d] = null; });
  let found = 0;

  const rows = table.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(strip);
    if (cells.length < 4) continue;
    const day = DAY_BY_ABBR[cells[0].slice(0, 3).toLowerCase()];
    if (!day) continue;
    const open = parseClock(cells[1]);
    const close = parseClock(cells[3]);
    if (open && close) { out[day] = open + '-' + close; found++; }
  }
  return found ? out : null;
}

function parseJsonLd(html) {
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const block of blocks) {
    const raw = block.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    let json;
    try { json = JSON.parse(raw); } catch (e) { continue; }
    const items = (json.itemListElement || []).map(i => i.item).filter(Boolean);
    const biz = items.find(i => i['@type'] === 'LocalBusiness');
    if (biz) return biz;
  }
  return null;
}

function parseLink(html, label) {
  // <div class="itemLabel">Official Website</div> ... <a href="...">
  const i = html.indexOf('>' + label + '<');
  if (i === -1) return '';
  const seg = html.slice(i, i + 900);
  const m = /<a[^>]+href="(https?:\/\/[^"]+)"/i.exec(seg);
  return m ? m[1] : '';
}

(async () => {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const shops = data.shops;
  console.log('shops:', shops.length);

  const out = {};
  const problems = [];
  let done = 0, withHours = 0, noAcd = 0;

  const worker = async (queue) => {
    while (queue.length) {
      const shop = queue.shift();
      try {
        // 1. find the ACD link on the coffeeshopmenus page
        const menuHtml = await get(BASE_MENUS + encodeURI(shop.page));
        const acdUrl = menuHtml &&
          (menuHtml.match(/https?:\/\/(?:www\.)?coffeeshopdirect\.com\/[^"']+\.html/i) || [])[0];
        if (!acdUrl) { noAcd++; problems.push({ shop: shop.name, issue: 'no ACD link' }); done++; continue; }

        await sleep(DELAY);

        // 2. fetch and parse the ACD page
        const html = await get(acdUrl);
        if (!html) { problems.push({ shop: shop.name, issue: 'ACD 404: ' + acdUrl }); done++; continue; }

        const biz = parseJsonLd(html);
        const hours = parseHours(html);
        if (hours) withHours++;

        // ACD's aggregateRating is deliberately not collected — the app keeps
        // its own ratings.
        out[shop.page] = {
          shop: shop.name,
          acd_url: acdUrl,
          opening_hours: hours,
          lat: biz && biz.geo ? Number(biz.geo.latitude) : null,
          lng: biz && biz.geo ? Number(biz.geo.longitude) : null,
          description: (biz && biz.description) || '',
          website: parseLink(html, 'Official Website'),
          instagram: parseLink(html, 'Instagram Page')
        };
      } catch (e) {
        problems.push({ shop: shop.name, issue: String(e.message || e) });
      }
      done++;
      if (done % 50 === 0) console.log(' ...', done, '/', shops.length);
      await sleep(DELAY);
    }
  };

  const queue = shops.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  fs.writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    source: 'coffeeshopdirect.com',
    count: Object.keys(out).length,
    details: out
  }, null, 2) + '\n');

  const vals = Object.values(out);
  console.log('\nACD pages parsed:', vals.length, '/', shops.length);
  console.log('with opening hours:', withHours,
              '(' + (withHours / shops.length * 100).toFixed(0) + '%)');
  console.log('with website:', vals.filter(v => v.website).length,
              '| instagram:', vals.filter(v => v.instagram).length);
  console.log('no ACD link:', noAcd, '| other problems:', problems.length - noAcd);
  problems.slice(0, 8).forEach(p => console.log('  -', p.shop, '|', p.issue));
})();
