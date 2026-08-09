/* Turn OCR'd menu text into a searchable product index.
 *
 * Input : tools/ocr/menu-ocr.jsonl  (one JSON object per menu image, from ocr.swift)
 * Output: public/data/products.json — an inverted index, product term -> shop ids,
 *         plus per-shop product lists for display.
 *
 *   node tools/scrape/20-build-products.js
 *
 * The hard part is not the OCR, it is deciding what on a menu board is a
 * PRODUCT and what is furniture: prices, weights, section headers, the
 * coffeeshopmenus.org watermark, opening hours, phone numbers. Everything
 * below is that filter. It is heuristic and will never be perfect — the goal
 * is a search aid, not a price list.
 */
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/vuk/Documents/coding/apps/CannaMap';
const OCR = path.join(__dirname, '..', 'ocr', 'menu-ocr.jsonl');
const SHOPS = path.join(ROOT, 'public', 'data', 'shops.json');
const OUT = path.join(ROOT, 'public', 'data', 'products.json');

// Section headers and menu furniture — never products in their own right.
const HEADERS = new Set([
  'weed', 'wiet', 'hash', 'hasj', 'hashish', 'joints', 'joint', 'prerolls',
  'pre rolls', 'pre roll', 'preroll', 'edibles', 'edible', 'drinks', 'drank',
  'space cake', 'spacecake', 'menu', 'menukaart', 'prijslijst', 'price list',
  'prices', 'prijzen', 'gram', 'grams', 'per gram', 'indica', 'sativa',
  'hybrid', 'hybride', 'local', 'lokaal', 'premium', 'imported', 'import',
  'specials', 'special', 'aanbieding', 'new', 'nieuw', 'sale', 'top',
  'flowers', 'flower', 'bloemen', 'concentrates', 'extractions', 'extracts',
  'iceolator', 'bubble hash', 'rosin', 'live rosin', 'static', 'filtered',
  'imported hash', 'moroccan', 'marokkaanse', 'afghan', 'tobacco', 'tabak',
  'coffee', 'koffie', 'thee', 'tea', 'soft drinks', 'frisdrank', 'cake',
  'muffin', 'brownie', 'lighter', 'papers', 'vloei', 'filters', 'tips',
  'open', 'gesloten', 'closed', 'opening hours', 'openingstijden',
  'discount', 'korting', 'cash only', 'pin', 'id', 'legitimatie', 'age',
  'total', 'totaal', 'info', 'nl', 'eng', 'www', 'com', 'org',
  'cali', 'cali weed', 'usa', 'amsterdam', 'coffeeshop', 'coffeeshops',
  'quality', 'kwaliteit', 'strain', 'strains', 'soort', 'soorten',
  'per', 'stuk', 'stuks', 'piece', 'pieces', 'each', 'mix', 'pure',
  'pre rolled', 'pre rolled joints', 'rolled joints', 'thc', 'cbd',
  'voorgedraaid', 'voorgedraaide joints', 'space', 'wietsoorten',
  'hasjsoorten', 'soorten wiet', 'soorten hasj', 'bio', 'organic'
]);

// Lines matching these are structural, not products.
const NOISE = [
  /coffeeshopmenus/i,
  /^\W*\d[\d.,\s]*\W*$/,                 // only digits/punctuation
  /^[€$]/,                                // starts with a currency symbol
  /^\d{1,2}[:.]\d{2}/,                    // a time
  /^\+?\d[\d\s\-()]{6,}$/,                // phone number
  /^(1|2|3|5|10|20|25)\s*(g|gr|gram)\b/i, // weight column heading
  /\bmenu is powered by\b/i,
  /software\s*support/i,
  /^(ma|di|wo|do|vr|za|zo|mon|tue|wed|thu|fri|sat|sun)\b/i
];

const PRICE = /[€$]\s*\d+[.,]?\d*|\b\d+[.,]\d{2}\b/g;
const WEIGHT = /\b\d+[.,]?\d*\s*(g|gr|gram|grams|mg|ml|x)\b/gi;

function clean(raw) {
  let s = String(raw || '');
  s = s.replace(PRICE, ' ').replace(WEIGHT, ' ');
  s = s.replace(/[·•*_|]+/g, ' ');
  // Trailing dot leaders on menu boards: "OG KUSH.........12,00"
  s = s.replace(/\.{2,}/g, ' ');
  s = s.replace(/^[\s\-–—:]+|[\s\-–—:,.]+$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function isProduct(s) {
  if (s.length < 3 || s.length > 42) return false;
  if (NOISE.some(re => re.test(s))) return false;
  const letters = (s.match(/[a-zA-Z]/g) || []).length;
  if (letters < 3) return false;
  // Mostly digits => a price/weight fragment
  if (letters / s.length < 0.5) return false;
  const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (!key || HEADERS.has(key)) return false;
  // A single very common word is a header, not a strain
  if (!key.includes(' ') && HEADERS.has(key)) return false;
  return true;
}

const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- run
if (!fs.existsSync(OCR)) {
  console.error('missing', OCR, '\nrun the OCR step first (see tools/ocr/ocr.swift)');
  process.exit(1);
}

const shops = JSON.parse(fs.readFileSync(SHOPS, 'utf8')).shops;
// menu file -> shop id
const fileToShop = new Map();
shops.forEach(s => (s.menu_images || []).forEach(m => {
  fileToShop.set(path.basename(m.file), s.id);
}));

const perShop = new Map();     // shop id -> Set of product strings
let images = 0, unmatched = 0, rawLines = 0, kept = 0, lowConf = 0;

fs.readFileSync(OCR, 'utf8').split('\n').filter(Boolean).forEach(line => {
  let rec;
  try { rec = JSON.parse(line); } catch (e) { return; }
  images++;
  const shopId = fileToShop.get(path.basename(rec.file || ''));
  if (!shopId) { unmatched++; return; }        // menu file no longer referenced
  if (!perShop.has(shopId)) perShop.set(shopId, new Set());
  const bag = perShop.get(shopId);

  (rec.lines || []).forEach(l => {
    rawLines++;
    if (l.conf < 0.45) { lowConf++; return; }  // OCR itself is unsure
    const s = clean(l.text);
    if (!isProduct(s)) return;
    kept++;
    bag.add(s);
  });
});

// ---- inverted index -------------------------------------------------------
// Key on the normalised product name; keep the prettiest spelling seen for
// display. A term appearing at only one shop is still useful, but a term
// appearing at 200 shops is a header we failed to filter — report those.
const terms = new Map();   // norm -> { display, shops:Set }
perShop.forEach((bag, shopId) => {
  bag.forEach(p => {
    const k = norm(p);
    if (!k || k.length < 3) return;
    if (!terms.has(k)) terms.set(k, { display: p, shops: new Set() });
    terms.get(k).shops.add(shopId);
  });
});

// One entry per term: the display spelling plus the shops that sell it.
// Storing per-shop lists as well would duplicate every name and roughly
// double the file for no extra capability.
const index = {};
terms.forEach((v, k) => { index[k] = { d: v.display, s: Array.from(v.shops) }; });

fs.writeFileSync(OUT, JSON.stringify({
  generated_at: new Date().toISOString(),
  source: 'OCR of shop menu photos (Apple Vision), heuristically filtered',
  caveat: 'Machine-read from photos. Names may be misread and prices are not captured.',
  shops: perShop.size,
  terms: Object.keys(index).length,
  index: index
}));

console.log('images read      :', images, '| unmatched files:', unmatched);
console.log('OCR lines        :', rawLines, '| low confidence dropped:', lowConf);
console.log('kept as products :', kept);
console.log('shops with menus :', perShop.size);
console.log('distinct terms   :', Object.keys(index).length);
console.log('output size      :', (fs.statSync(OUT).size / 1048576).toFixed(2), 'MB');

const common = Object.entries(index).sort((a, b) => b[1].s.length - a[1].s.length).slice(0, 25);
console.log('\nmost widespread terms (check these for leftover headers):');
common.forEach(([t, v]) => console.log('   ' + String(v.s.length).padStart(4) + '  ' + t));
