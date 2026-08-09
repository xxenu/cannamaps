// Stage 2: download every menu image into coffeeshopmenus/<Shop>/<file>.
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.coffeeshopmenus.org/';
const OUT = '/Users/vuk/Documents/coding/apps/CannaMap/coffeeshopmenus';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DELAY = 200;
const CONCURRENCY = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getBuf(url, referer, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': referer } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error('suspiciously small (' + buf.length + 'B)');
      return buf;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

(async () => {
  const { results } = JSON.parse(fs.readFileSync(__dirname + '/menu-index.json', 'utf8'));

  const jobs = [];
  for (const shop of results) {
    for (const img of shop.imgs) {
      // img looks like "Amnesia/Menus/060626.jpg"
      const parts = img.split('/');
      const shopDir = parts[0];
      const file = parts[parts.length - 1];
      jobs.push({
        url: BASE + encodeURI(img),
        referer: BASE + encodeURI(shop.page),
        dest: path.join(OUT, shopDir, file),
        shop: shopDir,
        page: shop.page
      });
    }
  }

  console.log('images to fetch:', jobs.length);

  let done = 0, bytes = 0;
  const failed = [];
  const manifest = [];

  const worker = async (queue) => {
    while (queue.length) {
      const job = queue.shift();
      try {
        fs.mkdirSync(path.dirname(job.dest), { recursive: true });
        if (!fs.existsSync(job.dest)) {
          const buf = await getBuf(job.url, job.referer);
          fs.writeFileSync(job.dest, buf);
          bytes += buf.length;
          await sleep(DELAY);
        }
        manifest.push({
          shop: job.shop,
          source_page: BASE + job.page,
          source_image: job.url,
          file: path.relative(OUT, job.dest)
        });
      } catch (e) {
        failed.push({ url: job.url, error: String(e.message || e) });
      }
      done++;
      if (done % 50 === 0) console.log(' ...', done, '/', jobs.length);
    }
  };

  const queue = jobs.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  manifest.sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    source: BASE + 'ams_index.html',
    downloaded_at: new Date().toISOString(),
    count: manifest.length,
    images: manifest
  }, null, 2));

  console.log('\ndownloaded ok:', manifest.length, ' failed:', failed.length);
  console.log('bytes:', (bytes / 1048576).toFixed(1), 'MB');
  if (failed.length) console.log('failures:', failed.slice(0, 15));
})();
