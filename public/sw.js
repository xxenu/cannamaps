/* CannaMap service worker — offline shell, shop data and map tiles.
 * Bump CACHE_VERSION whenever the shell files change. */

var CACHE_VERSION = 'v15';
var SHELL_CACHE = 'cannamap-shell-' + CACHE_VERSION;
var DATA_CACHE = 'cannamap-data-' + CACHE_VERSION;
var TILE_CACHE = 'cannamap-tiles-' + CACHE_VERSION;
var MENU_CACHE = 'cannamap-menus-' + CACHE_VERSION;

var MAX_TILES = 400;

/* On localhost, stale-while-revalidate means every edit needs two reloads: the
 * first serves the old file and only then fetches the new one. Serve the shell
 * and data network-first while developing, cache-first everywhere else. Tiles
 * and menu photos stay cached either way — they never change. */
var DEV = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';

var SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icons/icon.svg',
  './icons/leaf.png',
  './icons/gps.png',
  './icons/save.png',
  './icons/save-filled.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

var DATA_URL_PATTERN = /\/data\/(shops|zones|products)\.json(\?|$)/;
var MENU_URL_PATTERN = /\/data\/menus\//;
var TILE_HOSTS = ['tile.openstreetmap.org', 'a.tile.openstreetmap.org',
                  'b.tile.openstreetmap.org', 'c.tile.openstreetmap.org',
                  'a.basemaps.cartocdn.com', 'b.basemaps.cartocdn.com',
                  'c.basemaps.cartocdn.com', 'd.basemaps.cartocdn.com'];

// ------------------------------------------------------------------ install

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      // Individually, so one bad CDN response doesn't fail the whole install.
      return Promise.all(SHELL_ASSETS.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function (err) {
          console.warn('[sw] could not precache', url, err);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

// ------------------------------------------------------------------ activate

self.addEventListener('activate', function (event) {
  var keep = [SHELL_CACHE, DATA_CACHE, TILE_CACHE, MENU_CACHE];
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        if (name.indexOf('cannamap-') === 0 && keep.indexOf(name) === -1) {
          return caches.delete(name);
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// ------------------------------------------------------------------ fetch

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);

  if (DATA_URL_PATTERN.test(url.pathname)) {
    event.respondWith(DEV ? networkFirst(request, DATA_CACHE)
                          : staleWhileRevalidate(request, DATA_CACHE));
    return;
  }

  // Menu photos are immutable once published under a given filename, and are
  // the main thing worth having offline. Cache-first, kept in their own bucket.
  if (MENU_URL_PATTERN.test(url.pathname)) {
    event.respondWith(cacheFirst(request, MENU_CACHE));
    return;
  }

  if (TILE_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(cacheFirst(request, TILE_CACHE, MAX_TILES));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match('./index.html', { ignoreSearch: true });
      })
    );
    return;
  }

  // Shell assets: serve from cache immediately, refresh in the background so a
  // changed file lands on the next load without waiting for a version bump.
  event.respondWith(DEV ? networkFirst(request, SHELL_CACHE)
                        : staleWhileRevalidate(request, SHELL_CACHE));
});

// ------------------------------------------------------------------ strategies

function cacheFirst(request, cacheName, maxEntries) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && (response.ok || response.type === 'opaque')) {
          cache.put(request, response.clone()).then(function () {
            if (maxEntries) trimCache(cacheName, maxEntries);
          });
        }
        return response;
      });
    });
  });
}

/* Fresh when online, cached when not. Used on localhost so an edit shows on the
 * first reload; the cache is still filled, so offline keeps working. */
function networkFirst(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return fetch(request).then(function (response) {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    }).catch(function (err) {
      return cache.match(request, { ignoreSearch: true }).then(function (cached) {
        if (cached) return cached;
        throw err;
      });
    });
  });
}

function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request, { ignoreSearch: true }).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      }).catch(function (err) {
        if (cached) return cached;
        throw err;
      });
      return cached || network;
    });
  });
}

/* Crude FIFO eviction — good enough for tiles. */
function trimCache(cacheName, maxEntries) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= maxEntries) return;
      return Promise.all(keys.slice(0, keys.length - maxEntries).map(function (key) {
        return cache.delete(key);
      }));
    });
  });
}
