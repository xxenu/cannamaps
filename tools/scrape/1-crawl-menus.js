// Stage 1: fetch every shop page, extract menu image URLs.
const fs = require('fs');

const BASE = 'https://www.coffeeshopmenus.org/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DELAY = 150;      // ms between requests
const CONCURRENCY = 4;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE + 'ams_index.html' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

(async () => {
  const index = fs.readFileSync(__dirname + '/ams_index.html', 'utf8');
  const pages = [...new Set(
    [...index.matchAll(/href="([^"#]+\.html?)"/g)].map(m => m[1])
  )].filter(p => /^cs-/.test(p));

  console.log('shop pages:', pages.length);

  const results = [];
  let done = 0, failed = [];

  const worker = async (queue) => {
    while (queue.length) {
      const page = queue.shift();
      try {
        const html = await get(BASE + encodeURI(page));
        const imgs = [...new Set(
          [...html.matchAll(/src="([^"]*\/Menus\/[^"]+\.(?:jpg|jpeg|png|gif|webp))"/gi)].map(m => m[1])
        )];
        const title = (html.match(/<title>([^<]*)<\/title>/i) || [, page])[1].trim();
        results.push({ page, title, imgs });
      } catch (e) {
        failed.push({ page, error: String(e.message || e) });
      }
      done++;
      if (done % 25 === 0) console.log(' ...', done, '/', pages.length);
      await sleep(DELAY);
    }
  };

  const queue = pages.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  const total = results.reduce((n, r) => n + r.imgs.length, 0);
  const noImgs = results.filter(r => r.imgs.length === 0);

  fs.writeFileSync(__dirname + '/menu-index.json', JSON.stringify({ results, failed }, null, 2));

  console.log('\npages ok:', results.length, ' failed:', failed.length);
  console.log('menu images found:', total);
  console.log('pages with no menu image:', noImgs.length);
  console.log('max images on one page:', Math.max(...results.map(r => r.imgs.length)));
  if (failed.length) console.log('failures:', failed.slice(0, 10));
})();
