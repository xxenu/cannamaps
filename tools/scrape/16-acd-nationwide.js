// Crawl coffeeshopdirect.com nationwide for an authoritative shop TYPE and
// OPEN/CLOSED status for every venue in the Netherlands.
//
// ACD distinguishes a licensed coffeeshop from a cannabis-friendly bar and from
// a smartshop — the distinction Greenmeister does not make, which is why our
// map over-counts. Each page carries:
//   <h1 class="shopName Closed">          -> closed
//   <div class="typeBand">closed coffeeshop in Amsterdam</div>
//   <a href="gen-intro-coffeeshop.html">  -> type slug
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.coffeeshopdirect.com/';
const OUT = path.join(__dirname, 'acd-nationwide.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DELAY = 160;
const CONCURRENCY = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

// Navigation pages, not shops.
const NAV = /^(tix-|nix-|pix-|aix-|set-|gen-|map-|index|about|sendamenu|forum)/i;

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(900 * (i + 1));
    }
  }
}

function parseShop(html, page) {
  const h1 = html.match(/<h1[^>]*class="([^"]*shopName[^"]*)"[^>]*>([\s\S]*?)<\/h1>/i);
  const name = h1 ? strip(h1[2]) : '';
  const closedByClass = h1 ? /\bClosed\b/.test(h1[1]) : false;

  const band = strip((html.match(/<div class="typeBand">([\s\S]*?)<\/div>/i) || [])[1] || '');
  const closedByBand = /^closed\b/i.test(band);

  // gen-intro-<slug>.html is ACD's own type vocabulary
  const slugs = [...new Set([...html.matchAll(/gen-intro-([a-z0-9]+)\.html/gi)].map(m => m[1].toLowerCase()))];
  const type = slugs[0] || '';

  // JSON-LD carries address + coordinates for open venues
  let lat = null, lng = null, street = '', city = '', postcode = '';
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const b of blocks) {
    let json;
    try { json = JSON.parse(b.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '')); }
    catch (e) { continue; }
    const items = (json.itemListElement || []).map(i => i.item).filter(Boolean);
    const biz = items.find(i => i['@type'] === 'LocalBusiness' || i['@type'] === 'Place');
    if (!biz) continue;
    if (biz.geo) { lat = Number(biz.geo.latitude); lng = Number(biz.geo.longitude); }
    if (biz.address) {
      street = biz.address.streetAddress || '';
      city = biz.address.addressLocality || '';
      postcode = biz.address.postalCode || '';
    }
    break;
  }

  return {
    page, name, type, type_band: band,
    closed: closedByClass || closedByBand,
    street, city, postcode,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null
  };
}

(async () => {
  console.log('fetching town index...');
  const index = await get(BASE + 'tix-list.html');
  const towns = [...new Set([...index.matchAll(/href="(tix-[^"#]+\.html)"/g)].map(m => m[1]))]
    .filter(t => t !== 'tix-list.html');
  console.log('town pages:', towns.length);

  // town pages -> shop pages
  const shopPages = new Set();
  let t = 0;
  for (const town of towns) {
    const html = await get(BASE + encodeURI(town));
    if (html) {
      [...new Set([...html.matchAll(/href="([a-z0-9][a-z0-9-]*\.html)"/gi)].map(m => m[1]))]
        .filter(l => !NAV.test(l))
        .forEach(l => shopPages.add(l));
    }
    if (++t % 40 === 0) console.log('  towns', t, '/', towns.length, '| shops so far:', shopPages.size);
    await sleep(DELAY);
  }
  console.log('unique shop pages:', shopPages.size);

  const results = [];
  const problems = [];
  let done = 0;

  const worker = async (queue) => {
    while (queue.length) {
      const page = queue.shift();
      try {
        const html = await get(BASE + encodeURI(page));
        if (!html) { problems.push(page + ': 404'); done++; continue; }
        const info = parseShop(html, page);
        if (info.name) results.push(info);
        else problems.push(page + ': no name');
      } catch (e) {
        problems.push(page + ': ' + e.message);
      }
      done++;
      if (done % 150 === 0) console.log('  shops', done, '/', shopPages.size);
      await sleep(DELAY);
    }
  };

  const queue = [...shopPages];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  fs.writeFileSync(OUT, JSON.stringify({
    source: BASE, generated_at: new Date().toISOString(),
    count: results.length, shops: results
  }, null, 2) + '\n');

  const byType = {}, openByType = {};
  results.forEach(r => {
    byType[r.type || '(none)'] = (byType[r.type || '(none)'] || 0) + 1;
    if (!r.closed) openByType[r.type || '(none)'] = (openByType[r.type || '(none)'] || 0) + 1;
  });

  console.log('\nparsed:', results.length, '| problems:', problems.length);
  console.log('closed:', results.filter(r => r.closed).length,
              '| open:', results.filter(r => !r.closed).length);
  console.log('\ntype breakdown (all / still open):');
  Object.keys(byType).sort((a, b) => byType[b] - byType[a]).forEach(k =>
    console.log('   ', String(byType[k]).padStart(4), '/', String(openByType[k] || 0).padStart(4), k));
  console.log('\nwith coordinates:', results.filter(r => r.lat).length);
  problems.slice(0, 6).forEach(p => console.log('  !', p));
})();
