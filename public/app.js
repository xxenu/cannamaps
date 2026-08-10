/* CannaMap — Phase 1
 * Vanilla JS. Data comes from data/shops.json (placeholder data for now;
 * Phase 2 replaces the file contents, not this code).
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- config

  var DATA_URL = 'data/shops.json';
  // Public-space rules drawn on the map (currently Amsterdam's blowverbod).
  // A missing or broken file must never stop the shops from rendering.
  var ZONES_URL = 'data/zones.json';
  // Strain/product names OCR'd from the menu photos, so search can find a shop
  // by what it sells. Loaded lazily — search works without it.
  var PRODUCTS_URL = 'data/products.json';
  // Centred on the Netherlands as a whole; the map covers every city now.
  var NETHERLANDS = [52.15, 5.35];
  var DEFAULT_ZOOM = 8;

  /* Basemap. All of these are plain raster tiles — no API key, no extra
   * library — so switching is a one-word change to BASEMAP below. CARTO's
   * styles are OSM data rendered differently, so street coverage is identical.
   * `{r}` becomes '@2x' on retina screens for sharp labels. */
  var BASEMAPS = {
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    voyager: {
      url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    light: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      subdomains: 'abcd',
      maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    osm: {
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      subdomains: 'abc',
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }
  };
  var BASEMAP = 'dark';
  var BASEMAP_LABELS = { dark: 'Dark', voyager: 'Voyager', light: 'Light', osm: 'OpenStreetMap' };
  var FAVORITES_KEY = 'cannamap.favorites.v1';
  var PREFS_KEY = 'cannamap.prefs.v1';

  /* Menu choices, remembered between visits. Unknown keys are ignored, so an
   * older stored object never breaks a newer build. */
  var prefs = (function () {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; }
    catch (err) { return {}; }
  })();

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
    catch (err) { /* private mode */ }
  }

  var baseLayer = null;    // the live tile layer, swapped by the menu
  var zonesLayer = null;   // the blowverbod polygons, toggled by the menu

  /* Where the three "something's wrong" menu items point. A page of our own
   * rather than a mailto:, so the address can change without touching the app. */
  var CONTACT_URL = 'contact.html';

  // ---------------------------------------------------------------- i18n

  var I18N = window.CANNAMAP_I18N || { langs: [{ code: 'en', label: 'English' }], en: {} };

  /* Stored choice, else the closest match for the browser's language, else
   * English. Only the primary subtag is compared, so en-GB finds en. */
  function initialLang() {
    var have = I18N.langs.map(function (l) { return l.code; });
    if (have.indexOf(prefs.lang) !== -1) return prefs.lang;
    var wanted = (navigator.languages || [navigator.language || 'en']);
    for (var i = 0; i < wanted.length; i++) {
      var primary = String(wanted[i]).toLowerCase().split('-')[0];
      if (have.indexOf(primary) !== -1) return primary;
    }
    return 'en';
  }

  var lang = initialLang();

  /* English is the fallback for a missing key, and the key itself is the
   * fallback for that — a typo shows up as text rather than as a blank. */
  function t(key, vars) {
    var s = (I18N[lang] && I18N[lang][key]);
    if (s === undefined) s = (I18N.en && I18N.en[key]);
    if (s === undefined) return key;
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, function (whole, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole;
    });
  }

  /* Markup carries data-i18n="key" for text and data-i18n-attr="attr:key,..."
   * for attributes, so static strings live next to the elements they label. */
  function applyI18n() {
    document.documentElement.lang = lang;

    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-attr]').forEach(function (node) {
      node.getAttribute('data-i18n-attr').split(',').forEach(function (pair) {
        var bits = pair.split(':');
        if (bits.length === 2) node.setAttribute(bits[0].trim(), t(bits[1].trim()));
      });
    });
  }

  function setLang(code) {
    if (!I18N[code]) return;
    lang = code;
    prefs.lang = code;
    savePrefs();
    applyI18n();
    // Anything rendered from script has to be rebuilt in the new language.
    if (railState.panel) renderPanel(railState.panel);
    if (!el.sheet.hidden && state.selectedId) openSheet(state.selectedId);
    setLocateState(el.locate.dataset.state || 'off');
    if (el.search.value) renderSearchResults(el.search.value);
  }

  // ---------------------------------------------------------------- theme

  function theme() { return prefs.theme === 'light' ? 'light' : 'dark'; }

  /* One switch drives both: the palette via data-theme, and the basemap, since
   * dark chrome over light tiles (or the reverse) reads as a bug. */
  function setTheme(name) {
    prefs.theme = name === 'light' ? 'light' : 'dark';
    savePrefs();
    document.documentElement.setAttribute('data-theme', prefs.theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content',
        getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    }
    setBasemap(prefs.theme === 'light' ? 'light' : 'dark');
  }

  /* The supplied white leaf artwork, used instead of the 🌿 emoji so the pin
   * looks the same on every platform. Types without an `icon` fall back to
   * their emoji. */
  var LEAF_ICON = '<img class="pin-glyph" src="icons/leaf.png" alt="">';

  // Shop types are loose strings from the data. These are presentation hints
  // only — an unknown type still renders, it just falls back to a generic
  // colour/icon and appears as a filter chip automatically.
  var TYPE_HINTS = {
    coffeeshop: { label: 'Coffeeshops', color: '#63A47E', icon: LEAF_ICON, emoji: '🌿' },
    smartshop:  { label: 'Smartshops',  color: '#a78bfa', emoji: '🍄' },
    alcohol:    { label: 'Alcohol',     color: '#fb923c', emoji: '🍾' }
  };
  var FALLBACK_COLORS = ['#60a5fa', '#f472b6', '#facc15', '#2dd4bf', '#c084fc'];

  // Types shown without the user opting in. Everything else starts hidden
  // behind its filter chip.
  var ALWAYS_ON_TYPES = ['coffeeshop'];

  // Flip to true to also map shops the source marks as permanently closed.
  var SHOW_CLOSED = false;

  // Amenity keys kept in the data but not rendered. `tourists_allowed` is true
  // for 604 of 697 shops, so the chip is noise on almost every card — but the
  // 93 negatives are the residents-only rule (ingezetenencriterium), which
  // clusters hard in border towns: Maastricht 15/18, Breda 8/8. Worth a
  // dedicated warning or filter later rather than a chip; remove the key from
  // this list to show it again.
  var HIDDEN_AMENITIES = ['tourists_allowed'];

  var DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  // ---------------------------------------------------------------- state

  var state = {
    shops: [],
    types: [],              // [{ id, label, color, emoji, count, locked }]
    visibleTypes: new Set(),
    favorites: loadFavorites(),
    favoritesOnly: false,
    selectedId: null
  };

  var markers = Object.create(null); // shop id -> L.Marker
  var map;

  var el = {
    filters: document.getElementById('filters'),
    rail: document.getElementById('rail'),
    railAll: document.getElementById('rail-all'),
    railExplore: document.getElementById('rail-explore'),
    railSaved: document.getElementById('rail-saved'),
    railSavedCount: document.getElementById('rail-saved-count'),
    railRecent: document.getElementById('rail-recent'),
    railCities: document.getElementById('rail-cities'),
    panel: document.getElementById('rail-panel'),
    panelTitle: document.getElementById('panel-title'),
    panelBody: document.getElementById('panel-body'),
    panelClose: document.getElementById('panel-close'),
    locate: document.getElementById('locate'),
    toast: document.getElementById('toast'),
    search: document.getElementById('search-input'),
    searchBox: document.querySelector('.search'),
    searchClear: document.getElementById('search-clear'),
    searchResults: document.getElementById('search-results'),
    favToggle: document.getElementById('favorites-toggle'),
    favCount: document.getElementById('favorites-count'),
    empty: document.getElementById('empty-state'),
    scrim: document.getElementById('sheet-scrim'),
    sheet: document.getElementById('sheet'),
    close: document.getElementById('sheet-close'),
    name: document.getElementById('sheet-name'),
    logo: document.getElementById('sheet-logo'),
    address: document.getElementById('sheet-address'),
    type: document.getElementById('sheet-type'),
    rating: document.getElementById('sheet-rating'),
    status: document.getElementById('sheet-status'),
    fav: document.getElementById('sheet-fav'),
    directions: document.getElementById('sheet-directions'),
    contact: document.getElementById('sheet-contact'),
    hours: document.getElementById('sheet-hours'),
    menuTitle: document.getElementById('menu-title'),
    amenitiesTitle: document.getElementById('amenities-title'),
    amenities: document.getElementById('sheet-amenities'),
    gallery: document.getElementById('sheet-gallery'),
    menu: document.getElementById('sheet-menu'),
    lightbox: document.getElementById('lightbox'),
    lbImg: document.getElementById('lightbox-img'),
    lbStage: document.getElementById('lightbox-stage'),
    lbLabel: document.getElementById('lightbox-label'),
    lbZoom: document.getElementById('lightbox-zoom'),
    lbClose: document.getElementById('lightbox-close'),
    lbPrev: document.getElementById('lightbox-prev'),
    lbNext: document.getElementById('lightbox-next')
  };

  // Fullscreen viewer state: which shop's images, and where we are in them.
  var viewer = { images: [], index: 0, zoomed: false };

  // ---------------------------------------------------------------- storage

  function loadFavorites() {
    try {
      var raw = localStorage.getItem(FAVORITES_KEY);
      var ids = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(ids) ? ids : []);
    } catch (err) {
      console.warn('Could not read favorites:', err);
      return new Set();
    }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(state.favorites)));
    } catch (err) {
      console.warn('Could not save favorites:', err);
    }
  }

  // ---------------------------------------------------------------- helpers

  function typeInfo(typeId) {
    var hint = TYPE_HINTS[typeId];
    if (hint) return hint;
    var idx = Math.abs(hashCode(typeId)) % FALLBACK_COLORS.length;
    return { label: titleCase(typeId), color: FALLBACK_COLORS[idx], emoji: '📍' };
  }

  function hashCode(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return h;
  }

  function titleCase(str) {
    return String(str).replace(/[-_]+/g, ' ').replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  function todayKey(now) {
    // Date.getDay(): 0 = Sunday. DAYS is Monday-first.
    return DAYS[(now.getDay() + 6) % 7];
  }

  function toMinutes(hhmm) {
    var parts = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
    if (!parts) return null;
    return Number(parts[1]) * 60 + Number(parts[2]);
  }

  function parseRange(range) {
    if (!range || typeof range !== 'string') return null;
    var halves = range.split('-');
    if (halves.length !== 2) return null;
    var open = toMinutes(halves[0]);
    var close = toMinutes(halves[1]);
    if (open === null || close === null) return null;
    return { open: open, close: close };
  }

  function formatRange(range) {
    var parsed = parseRange(range);
    return parsed ? range.replace('-', ' – ') : t('day.closed');
  }

  function hasHours(shop) {
    var hours = shop.opening_hours || {};
    return DAYS.some(function (day) { return parseRange(hours[day]); });
  }

  /* Open now? Handles ranges that spill past midnight (e.g. 09:00-01:00) by
   * also checking whether yesterday's range is still running. */
  function isOpenNow(shop, now) {
    var hours = shop.opening_hours || {};
    var minutes = now.getHours() * 60 + now.getMinutes();
    var dayIdx = (now.getDay() + 6) % 7;

    var today = parseRange(hours[DAYS[dayIdx]]);
    if (today) {
      if (today.close > today.open) {
        if (minutes >= today.open && minutes < today.close) return true;
      } else if (minutes >= today.open) {
        return true; // runs into tomorrow
      }
    }

    var yesterday = parseRange(hours[DAYS[(dayIdx + 6) % 7]]);
    if (yesterday && yesterday.close <= yesterday.open && minutes < yesterday.close) {
      return true;
    }
    return false;
  }

  function formatPrice(price) {
    if (typeof price !== 'number' || !isFinite(price)) return '';
    return '€' + price.toFixed(2);
  }

  function directionsUrl(shop) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' +
      encodeURIComponent(shop.lat + ',' + shop.lng);
  }

  function isVisible(shop) {
    // Shops the source marks as permanently closed stay in the data (their
    // menu archive is still worth keeping) but off the map.
    if (shop.status === 'closed' && !SHOW_CLOSED) return false;
    if (!state.visibleTypes.has(shop.shop_type)) return false;
    if (state.favoritesOnly && !state.favorites.has(shop.id)) return false;
    return true;
  }

  // ---------------------------------------------------------------- map

  function initMap() {
    map = L.map('map', {
      center: NETHERLANDS,
      zoom: DEFAULT_ZOOM,
      zoomControl: false,
      preferCanvas: false
    });

    setTheme(theme());   // also installs the matching tile layer

    // Bottom right, stacked under the locate button (see .leaflet-bottom.leaflet-right).
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    // Attribution defaults to the same corner and would push the zoom card up
    // into the locate button; it belongs out of the way anyway.
    map.attributionControl.setPosition('bottomleft');
    // A click on the map itself dismisses whatever is open. Markers and zone
    // polygons stop propagation, so this only fires on bare map.
    map.on('click', function () {
      closeSheet();
      closePanel();
      closeSearchResults();
    });
    map.on('moveend zoomend', function () {
      if (state.shops.length) renderMarkers();
    });

    // Marks the whole zoom gesture, pinch included — Leaflet's own
    // leaflet-zoom-anim class only covers animated zooms. See .is-zooming.
    map.on('zoomstart', function () {
      L.DomUtil.addClass(map.getContainer(), 'is-zooming');
    });
    map.on('zoomend', function () {
      L.DomUtil.removeClass(map.getContainer(), 'is-zooming');
    });
  }

  /* Swaps the tile layer in place. The attribution belongs to the basemap, so
   * it goes with it — OSM's tiles and CARTO's carry different credits. */
  function setBasemap(key) {
    var base = BASEMAPS[key] || BASEMAPS[BASEMAP] || BASEMAPS.osm;
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = L.tileLayer(base.url, {
      subdomains: base.subdomains,
      maxZoom: base.maxZoom,
      attribution: base.attribution,
      r: L.Browser.retina ? '@2x' : ''
    }).addTo(map);
  }

  function zonesVisible() { return prefs.zones !== false; }   // on unless turned off

  function setZonesVisible(on) {
    prefs.zones = !!on;
    savePrefs();
    if (!zonesLayer) return;                 // not loaded yet; renderZones honours the pref
    if (on) zonesLayer.addTo(map); else map.removeLayer(zonesLayer);
  }

  function makeIcon(shop) {
    var info = typeInfo(shop.shop_type);
    var classes = 'pin';
    if (state.favorites.has(shop.id)) classes += ' is-fav';
    if (state.selectedId === shop.id) classes += ' is-active';

    return L.divIcon({
      className: 'pin-wrap',
      html: '<div class="' + classes + '" style="--pin-color:' + info.color + '">' +
            '<span>' + (info.icon || info.emoji) + '</span></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 26],
      popupAnchor: [0, -26]
    });
  }

  function createMarkers() {
    state.shops.forEach(function (shop) {
      var marker = L.marker([shop.lat, shop.lng], {
        icon: makeIcon(shop),
        title: shop.name,
        alt: shop.name + ' (' + typeInfo(shop.shop_type).label + ')',
        riseOnHover: true
      });
      marker.on('click', function (ev) {
        L.DomEvent.stopPropagation(ev);
        openSheet(shop.id);
      });
      markers[shop.id] = marker;
    });
  }

  function refreshMarker(shopId) {
    var shop = getShop(shopId);
    if (shop && markers[shopId]) markers[shopId].setIcon(makeIcon(shop));
  }

  function renderMarkers() {
    // With ~750 shops nationwide, only markers inside the current view (plus a
    // margin) are attached to the map. Keeps the DOM small when zoomed out.
    var bounds = map.getBounds().pad(0.35);
    var shown = 0;
    state.shops.forEach(function (shop) {
      var marker = markers[shop.id];
      if (isVisible(shop)) {
        shown++;
        if (bounds.contains(marker.getLatLng())) {
          if (!map.hasLayer(marker)) marker.addTo(map);
        } else if (map.hasLayer(marker)) {
          map.removeLayer(marker);
        }
      } else if (map.hasLayer(marker)) {
        map.removeLayer(marker);
      }
    });

    if (shown === 0) {
      el.empty.textContent = state.favoritesOnly
        ? 'No favorites yet in the selected categories. Tap save on a shop to keep it.'
        : 'Nothing to show — turn on a category filter above.';
      el.empty.hidden = false;
    } else {
      el.empty.hidden = true;
    }

    // A hidden shop should not stay open in the sheet.
    if (state.selectedId) {
      var selected = getShop(state.selectedId);
      if (!selected || !isVisible(selected)) closeSheet();
    }
  }

  function getShop(id) {
    for (var i = 0; i < state.shops.length; i++) {
      if (state.shops[i].id === id) return state.shops[i];
    }
    return null;
  }

  // ---------------------------------------------------------------- filters

  function buildTypes() {
    // Count only shops that can actually appear, so the chip never promises
    // more pins than the map draws.
    var counts = Object.create(null);
    state.shops.forEach(function (shop) {
      if (shop.status === 'closed' && !SHOW_CLOSED) return;
      counts[shop.shop_type] = (counts[shop.shop_type] || 0) + 1;
    });

    state.types = Object.keys(counts).sort(function (a, b) {
      var aLocked = ALWAYS_ON_TYPES.indexOf(a) !== -1;
      var bLocked = ALWAYS_ON_TYPES.indexOf(b) !== -1;
      if (aLocked !== bLocked) return aLocked ? -1 : 1;
      return a.localeCompare(b);
    }).map(function (id) {
      var info = typeInfo(id);
      return {
        id: id,
        label: info.label,
        color: info.color,
        emoji: info.emoji,
        count: counts[id],
        locked: ALWAYS_ON_TYPES.indexOf(id) !== -1
      };
    });

    state.types.forEach(function (type) {
      if (type.locked) state.visibleTypes.add(type.id);
    });
  }

  /* The chip row was removed from the UI, but the type model behind it stays:
   * `state.visibleTypes` still decides what is mapped, and a new shop_type in
   * the data still works. Re-add the #filters element to bring the chips back. */
  function renderFilters() {
    if (!el.filters) return;
    el.filters.innerHTML = '';
    state.types.forEach(function (type) {
      var on = state.visibleTypes.has(type.id);
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.style.setProperty('--chip-color', type.color);
      chip.setAttribute('aria-pressed', String(on));
      chip.dataset.type = type.id;
      if (type.locked) {
        chip.dataset.locked = 'true';
        chip.title = type.label + ' are always shown';
      }
      chip.innerHTML = '<span class="dot"></span>' + type.label +
        ' <span class="count">' + type.count + '</span>';

      if (!type.locked) {
        chip.addEventListener('click', function () {
          if (state.visibleTypes.has(type.id)) state.visibleTypes.delete(type.id);
          else state.visibleTypes.add(type.id);
          renderFilters();
          renderMarkers();
        });
      }
      el.filters.appendChild(chip);
    });
  }

  // ---------------------------------------------------------------- rail

  var RECENT_KEY = 'cannamap.recent.v1';
  var RECENT_MAX = 12;
  var RAIL_CITIES = 6;

  function loadRecent() {
    try {
      var raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (err) { return []; }
  }

  function pushRecent(id) {
    var list = loadRecent().filter(function (x) { return x !== id; });
    list.unshift(id);
    list = list.slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (err) { /* private mode */ }
    if (railState.panel === 'recent') renderPanel('recent');
  }

  var railState = { panel: '' };

  /* City shortcuts, biggest first — the rail should reflect where the shops
   * actually are rather than a hardcoded list. */
  function buildRailCities() {
    if (!el.railCities) return;
    var counts = Object.create(null);
    state.shops.forEach(function (s) {
      if (s.status === 'closed' && !SHOW_CLOSED) return;
      if (!s.city) return;
      counts[s.city] = (counts[s.city] || 0) + 1;
    });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })
      .slice(0, RAIL_CITIES);

    el.railCities.innerHTML = '';
    top.forEach(function (city) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rail-city';
      btn.title = counts[city] + ' shops in ' + city;

      var mark = document.createElement('span');
      mark.className = 'city-mark';
      mark.textContent = String(counts[city]);

      var name = document.createElement('span');
      name.className = 'city-name';
      name.textContent = city;

      btn.appendChild(mark);
      btn.appendChild(name);
      btn.addEventListener('click', function () { flyToCity(city); });
      el.railCities.appendChild(btn);
    });
  }

  function flyToCity(city) {
    var pts = state.shops.filter(function (s) {
      return s.city === city && (s.status !== 'closed' || SHOW_CLOSED);
    }).map(function (s) { return [s.lat, s.lng]; });
    if (!pts.length) return;
    closePanel();
    map.fitBounds(L.latLngBounds(pts).pad(0.12), { animate: true });
  }

  function setRailPressed() {
    // Explore carries data-panel="", so it lights up exactly when nothing else
    // does — no special case needed.
    [el.railExplore, el.railAll, el.railSaved, el.railRecent].forEach(function (btn) {
      if (!btn) return;
      var mine = btn.dataset.panel || '';
      btn.setAttribute('aria-pressed', String(mine === railState.panel));
    });
  }

  function closePanel() {
    railState.panel = '';
    el.panel.hidden = true;
    setRailPressed();
    syncSearchChrome();
  }

  function togglePanel(which) {
    if (railState.panel === which) { closePanel(); return; }
    railState.panel = which;
    if (!el.sheet.hidden) closeSheet();   // same drawer slot
    el.panel.hidden = false;
    renderPanel(which);
    setRailPressed();
    syncSearchChrome();
  }

  /* With a panel open the omnibox rearranges: the magnifier moves to the
   * leading edge and the ✕ moves to the trailing one, where it doubles as the
   * panel's close button. That is why the panel's own header ✕ is gone — it
   * sat underneath the floating search card. */
  function syncSearchChrome() {
    // The shop detail is the same drawer in wide layouts, so it drives the
    // omnibox the same way a rail panel does.
    var drawerOpen = !!railState.panel || !el.sheet.hidden;
    if (el.searchBox) el.searchBox.classList.toggle('is-panel', drawerOpen);
    // Phone layout hangs the city strip under the search bar; it has to get
    // out of the way when something opens over the map.
    document.body.classList.toggle('has-drawer', drawerOpen);
    el.searchClear.hidden = !drawerOpen && !el.search.value;
    el.searchClear.setAttribute('aria-label', drawerOpen ? 'Close' : 'Clear search');
  }

  /* Row thumbnail: the shop's logo, else its first menu photo, else a tile in
   * the type colour. A file that fails to load drops back to that same tile,
   * so a row never shows a broken image. */
  function shopThumb(shop) {
    var wrap = document.createElement('span');
    wrap.className = 'panel-row-thumb';
    wrap.style.background = typeInfo(shop.shop_type).color;

    var logo = shop.logo || '';
    var src = logo || ((shop.menu_images || [])[0] || {}).file || '';
    if (!src) return wrap;

    var img = document.createElement('img');
    // Logos are usually artwork on a flat ground, so they are fitted whole;
    // menu photos are cropped to fill.
    if (logo) img.className = 'is-logo';
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', function () { img.remove(); });
    img.src = src;
    wrap.appendChild(img);
    return wrap;
  }

  function shopRow(shop, subtitle) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'panel-row';

    var text = document.createElement('div');
    text.className = 'panel-row-text';
    var name = document.createElement('div');
    name.className = 'panel-row-name';
    name.textContent = shop.name;
    var sub = document.createElement('div');
    sub.className = 'panel-row-sub';
    sub.textContent = subtitle || shop.address || shop.city || '';
    text.appendChild(name);
    text.appendChild(sub);

    row.appendChild(shopThumb(shop));
    row.appendChild(text);
    row.addEventListener('click', function () {
      map.setView([shop.lat, shop.lng], Math.max(map.getZoom(), 16), { animate: true });
      renderMarkers();
      openSheet(shop.id);
    });
    return row;
  }

  // ---- menu ---------------------------------------------------------------

  function menuGroup() {
    var g = document.createElement('div');
    g.className = 'menu-group';
    el.panelBody.appendChild(g);
    return g;
  }

  function menuItem(group, label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.addEventListener('click', onClick);
    group.appendChild(b);
    return b;
  }

  function menuSwitch(group, label, on, onChange) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item menu-switch';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(on));
    b.innerHTML = '<span class="menu-label"></span><span class="switch" aria-hidden="true"></span>';
    b.querySelector('.menu-label').textContent = label;
    b.addEventListener('click', function () {
      var next = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', String(next));
      onChange(next);
    });
    group.appendChild(b);
    return b;
  }

  function menuHeading(group, key) {
    var h = document.createElement('h3');
    h.className = 'menu-heading';
    h.textContent = t(key);
    group.appendChild(h);
  }

  /* Opens our own contact page rather than a mailto:, so the address can
   * change without shipping a new build. The topic rides in the query string
   * and picks the heading over there. */
  function menuContact(group, key, topic) {
    var a = document.createElement('a');
    a.className = 'menu-item';
    a.setAttribute('role', 'menuitem');
    a.href = CONTACT_URL + '?topic=' + encodeURIComponent(topic) + '&lang=' + encodeURIComponent(lang);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = t(key);
    group.appendChild(a);
    return a;
  }

  function renderRailMenu() {
    // Appearance: one switch, since the palette and the basemap move together.
    var look = menuGroup();
    menuHeading(look, 'menu.appearance');
    menuSwitch(look, t(theme() === 'light' ? 'menu.light' : 'menu.dark'),
      theme() === 'light', function (on) {
        setTheme(on ? 'light' : 'dark');
        renderPanel('menu');   // the switch relabels itself dark <-> light
      });

    var langs = menuGroup();
    menuHeading(langs, 'menu.language');
    I18N.langs.forEach(function (entry) {
      var b = menuItem(langs, entry.label, function () {
        setLang(entry.code);
        renderPanel('menu');
      });
      b.classList.add('menu-choice');
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(entry.code === lang));
      b.lang = entry.code;
    });

    var loc = menuGroup();
    menuItem(loc, t('menu.shareLocation'), function () {
      closePanel();
      // Asked for explicitly, so problems are worth reporting: no silent flag.
      me.silent = false;
      if (me.following) { map.setView(me.latlng || NETHERLANDS, FOLLOW_ZOOM); return; }
      startLocating();
    });

    var layers = menuGroup();
    menuHeading(layers, 'menu.layers');
    menuSwitch(layers, t('menu.zones'), zonesVisible(), setZonesVisible);

    var help = menuGroup();
    menuHeading(help, 'menu.help');
    menuContact(help, 'menu.updateMenu', 'outdated-menu');
    menuContact(help, 'menu.addPlace', 'missing-place');
    menuContact(help, 'menu.addCompany', 'add-company');

    var about = menuGroup();
    var p = document.createElement('p');
    p.className = 'menu-about';
    p.textContent = t('menu.credits') + ' ';
    var src = document.createElement('a');
    src.href = 'https://github.com/xxenu/cannamaps';
    src.target = '_blank';
    src.rel = 'noopener noreferrer';
    src.textContent = t('menu.source');
    p.appendChild(src);
    about.appendChild(p);
  }

  function renderPanel(which) {
    el.panelBody.innerHTML = '';
    el.panelTitle.textContent = t('panel.' + (which || 'menu'));

    if (which === 'menu') { renderRailMenu(); return; }

    var ids = which === 'saved' ? Array.from(state.favorites) : loadRecent();
    var shops = ids.map(getShop).filter(Boolean);

    if (which === 'saved') {
      // The map filter lives with the list it filters, rather than as a
      // separate floating button.
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'panel-toggle';
      toggle.setAttribute('aria-pressed', String(state.favoritesOnly));
      toggle.innerHTML = '<span class="tick"></span>';
      toggle.appendChild(document.createTextNode(t('panel.onlySaved')));
      toggle.addEventListener('click', function () {
        state.favoritesOnly = !state.favoritesOnly;
        toggle.setAttribute('aria-pressed', String(state.favoritesOnly));
        renderMarkers();
      });
      el.panelBody.appendChild(toggle);
    }

    if (!shops.length) {
      var empty = document.createElement('p');
      empty.className = 'panel-empty';
      empty.textContent = which === 'saved'
        ? t('panel.savedEmpty')
        : t('panel.recentEmpty');
      el.panelBody.appendChild(empty);
      return;
    }

    shops.forEach(function (shop) { el.panelBody.appendChild(shopRow(shop)); });
  }

  function initRail() {
    if (!el.rail) return;
    // Explore is the empty state rather than a panel of its own: it puts the
    // map back by dismissing whatever is covering it.
    el.railExplore.addEventListener('click', function () {
      closePanel();
      closeSheet();
      closeSearchResults();
    });
    el.railAll.addEventListener('click', function () { togglePanel('menu'); });
    el.railSaved.addEventListener('click', function () { togglePanel('saved'); });
    el.railRecent.addEventListener('click', function () { togglePanel('recent'); });
    el.panelClose.addEventListener('click', closePanel);
    setRailPressed();
  }

  function renderSavedCount() {
    if (!el.railSavedCount) return;
    var n = state.favorites.size;
    el.railSavedCount.textContent = String(n);
    el.railSavedCount.hidden = n === 0;
  }

  // ---------------------------------------------------------------- favorites

  function isFavorite(id) { return state.favorites.has(id); }

  function toggleFavorite(id) {
    if (state.favorites.has(id)) state.favorites.delete(id);
    else state.favorites.add(id);
    saveFavorites();
    refreshMarker(id);
    renderFavoritesUi();
    if (state.selectedId === id) renderSheetFav(id);
    if (state.favoritesOnly) renderMarkers();
  }

  /* Favourites still exist — the star in the sheet still works and favourited
   * pins still carry it. Only the favourites-only toggle button is gone, so
   * there is nothing left to update when there is no button. */
  function renderFavoritesUi() {
    renderSavedCount();
    if (railState.panel === 'saved') renderPanel('saved');
    if (!el.favToggle || !el.favCount) return;
    var count = state.favorites.size;
    el.favCount.textContent = String(count);
    el.favCount.hidden = count === 0;
    el.favToggle.setAttribute('aria-pressed', String(state.favoritesOnly));
    el.favToggle.title = state.favoritesOnly ? 'Show all shops' : 'Show favorites only';
  }

  function renderSheetFav(id) {
    var fav = isFavorite(id);
    el.fav.setAttribute('aria-pressed', String(fav));
    el.fav.setAttribute('aria-label', fav ? 'Remove from favorites' : 'Add to favorites');
  }

  // ---------------------------------------------------------------- sheet

  function openSheet(id) {
    var shop = getShop(id);
    if (!shop) return;

    var previous = state.selectedId;
    state.selectedId = id;
    if (previous && previous !== id) refreshMarker(previous);
    refreshMarker(id);
    pushRecent(id);

    var info = typeInfo(shop.shop_type);
    var now = new Date();
    var open = isOpenNow(shop, now);

    el.name.textContent = shop.name;
    el.address.textContent = shop.address || '';
    el.type.textContent = info.label;
    el.type.style.setProperty('--badge-color', info.color);

    // Ratings come from the app's own system; nothing is imported. Until one
    // exists the field is null and the badge stays hidden.
    if (typeof shop.rating === 'number') {
      el.rating.textContent = '★ ' + shop.rating.toFixed(1) +
        (shop.rating_count ? ' (' + shop.rating_count + ')' : '');
      el.rating.hidden = false;
    } else {
      el.rating.hidden = true;
    }

    if (shop.logo) {
      el.logo.src = shop.logo;
      el.logo.alt = shop.name + ' logo';
      el.logo.hidden = false;
    } else {
      el.logo.hidden = true;
      el.logo.removeAttribute('src');
    }

    // Only claim a shop is open or closed when hours are actually known.
    if (shop.status === 'closed') {
      el.status.textContent = t('sheet.permClosed');
      el.status.className = 'status closed';
    } else if (!hasHours(shop)) {
      el.status.textContent = t('sheet.hoursUnknown');
      el.status.className = 'status unknown';
    } else {
      el.status.textContent = t(open ? 'sheet.openNow' : 'sheet.closedNow');
      el.status.className = 'status ' + (open ? 'open' : 'closed');
    }

    el.directions.href = directionsUrl(shop);
    el.directions.setAttribute('aria-label', 'Get directions to ' + shop.name);

    renderSheetFav(id);
    renderAmenities(shop);
    renderContact(shop);
    renderHours(shop, now);
    renderMenuImages(shop);
    renderMenu(shop);

    // On wide screens both occupy the same drawer slot beside the rail.
    if (railState.panel) closePanel();

    // Clear anything a previous drag left behind before it re-animates in.
    el.sheet.style.transition = '';
    el.sheet.style.transform = '';
    el.sheet.style.animation = '';
    el.scrim.style.opacity = '';
    el.sheet.hidden = false;
    el.scrim.hidden = false;
    el.sheet.querySelector('.sheet-body').scrollTop = 0;
    syncSearchChrome();
    // The ✕ is hidden in drawer mode; focus the pane itself so the dialog still
    // takes focus and Escape still reaches it.
    if (el.close.offsetParent) el.close.focus({ preventScroll: true });
    else el.sheet.focus({ preventScroll: true });

    map.panTo([shop.lat, shop.lng], { animate: true });
  }

  function closeSheet() {
    if (el.sheet.hidden) return;
    var previous = state.selectedId;
    state.selectedId = null;
    el.sheet.hidden = true;
    el.scrim.hidden = true;
    syncSearchChrome();
    if (previous) refreshMarker(previous);
  }

  /* Drag the sheet's grip down to dismiss it — the gesture the grip has been
   * advertising all along. Only wired for touch, and only while the sheet is
   * the bottom sheet: in the wide layout it is a side drawer and the grip is
   * hidden, so there is nothing to grab. */
  function initSheetDrag() {
    var grip = el.sheet.querySelector('.sheet-grip');
    if (!grip || !window.matchMedia) return;

    var startY = 0;
    var dy = 0;
    var dragging = false;

    grip.addEventListener('touchstart', function (ev) {
      if (!grip.offsetParent) return;          // hidden: wide layout
      dragging = true;
      startY = ev.touches[0].clientY;
      dy = 0;
      // The sheet animates in on open; a transform here would fight it.
      el.sheet.style.animation = 'none';
      el.sheet.style.transition = 'none';
    }, { passive: true });

    grip.addEventListener('touchmove', function (ev) {
      if (!dragging) return;
      dy = Math.max(0, ev.touches[0].clientY - startY);
      el.sheet.style.transform = 'translateY(' + dy + 'px)';
      // Fade the scrim out with the drag, so a half-pull reads as reversible.
      el.scrim.style.opacity = String(Math.max(0, 1 - dy / 260));
      ev.preventDefault();                     // don't scroll the page with it
    }, { passive: false });

    function end() {
      if (!dragging) return;
      dragging = false;
      var far = dy > 110;
      el.sheet.style.transition = 'transform 0.2s ease';
      el.sheet.style.transform = far ? 'translateY(110%)' : '';
      el.scrim.style.opacity = '';
      if (!far) return;
      window.setTimeout(function () {
        closeSheet();
        el.sheet.style.transition = '';
        el.sheet.style.transform = '';
        el.sheet.style.animation = '';
      }, 200);
    }
    grip.addEventListener('touchend', end);
    grip.addEventListener('touchcancel', end);
  }

  /* Amenity keys come straight from the data, so a new one added upstream
   * shows up without a code change. Availability is explicit: a shop that is
   * known NOT to have something is worth showing too. */
  function renderAmenities(shop) {
    var keys = Object.keys(shop.amenities || {}).filter(function (key) {
      return HIDDEN_AMENITIES.indexOf(key) === -1;
    });
    el.amenities.innerHTML = '';
    el.amenities.hidden = keys.length === 0;
    el.amenitiesTitle.hidden = keys.length === 0;
    if (!keys.length) return;

    keys.forEach(function (key) {
      var item = shop.amenities[key];
      if (!item || !item.label) return;
      var li = document.createElement('li');
      li.className = 'amenity ' + (item.available ? 'yes' : 'no');
      var mark = document.createElement('span');
      mark.className = 'amenity-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = item.available ? '✓' : '✕';
      var text = document.createElement('span');
      text.textContent = item.label;
      li.appendChild(mark);
      li.appendChild(text);
      li.setAttribute('aria-label', item.label + ': ' + (item.available ? 'yes' : 'no'));
      el.amenities.appendChild(li);
    });
  }

  function renderContact(shop) {
    el.contact.innerHTML = '';
    // Only website and Instagram, and only when the shop actually has them.
    var links = [
      { href: shop.website, label: 'Website' },
      { href: shop.instagram, label: 'Instagram' }
    ].filter(function (l) { return l.href; });

    el.contact.hidden = links.length === 0;
    links.forEach(function (link) {
      var a = document.createElement('a');
      a.className = 'contact-link';
      a.href = link.href;
      a.textContent = link.label;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      el.contact.appendChild(a);
    });
  }

  function renderHours(shop, now) {
    var hours = shop.opening_hours || {};
    var today = todayKey(now);
    el.hours.innerHTML = '';

    // No hours in the data at all — say so once instead of printing seven
    // "Closed" rows, which would read as a claim the shop never opens.
    if (!hasHours(shop)) {
      var unknown = document.createElement('li');
      unknown.className = 'hours-unknown';
      unknown.textContent = t('sheet.noHours');
      el.hours.appendChild(unknown);
      return;
    }

    DAYS.forEach(function (day) {
      var li = document.createElement('li');
      if (day === today) {
        li.className = 'today';
        li.setAttribute('aria-current', 'date');
      }
      var name = document.createElement('span');
      name.className = 'day';
      name.textContent = t('day.' + day);
      var value = document.createElement('span');
      value.textContent = formatRange(hours[day]);
      li.appendChild(name);
      li.appendChild(value);
      el.hours.appendChild(li);
    });
  }

  /* Menus are photos of the shop's own board. Every shop lays theirs out
   * differently — tiered gram pricing, per-piece edibles, sections that exist
   * nowhere else — so the image is the source of truth and `menu` is only an
   * optional structured extra for shops where a flat list actually fits. */
  function renderMenuImages(shop) {
    var images = Array.isArray(shop.menu_images) ? shop.menu_images : [];
    el.gallery.innerHTML = '';
    el.gallery.hidden = images.length === 0;
    if (images.length === 0) return;

    images.forEach(function (image, i) {
      var figure = document.createElement('figure');
      figure.className = 'menu-shot';

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-shot-btn';
      button.setAttribute('aria-label', 'Enlarge ' + (image.label || 'menu') + ' for ' + shop.name);

      var img = document.createElement('img');
      img.src = image.file;
      img.alt = (image.label || 'Menu') + ' for ' + shop.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      button.appendChild(img);

      button.addEventListener('click', function () { openViewer(shop, i); });
      figure.appendChild(button);

      if (images.length > 1 || image.label) {
        var caption = document.createElement('figcaption');
        caption.textContent = (image.label || 'Menu') +
          (images.length > 1 ? ' · ' + (i + 1) + ' of ' + images.length : '');
        figure.appendChild(caption);
      }
      el.gallery.appendChild(figure);
    });
  }

  function renderMenu(shop) {
    var items = Array.isArray(shop.menu) ? shop.menu : [];
    var hasImages = Array.isArray(shop.menu_images) && shop.menu_images.length > 0;
    el.menu.innerHTML = '';

    el.menu.hidden = false;

    if (items.length === 0) {
      if (hasImages) { el.menu.hidden = true; return; }
      var empty = document.createElement('li');
      empty.className = 'menu-empty';
      empty.textContent = t('sheet.noMenu');
      el.menu.appendChild(empty);
      return;
    }

    if (hasImages) {
      var note = document.createElement('li');
      note.className = 'menu-note';
      note.textContent = t('sheet.alsoText');
      el.menu.appendChild(note);
    }

    items.forEach(function (item) {
      var li = document.createElement('li');

      var row = document.createElement('div');
      row.className = 'menu-row';
      var name = document.createElement('span');
      name.textContent = item.name || 'Unnamed item';
      var price = document.createElement('span');
      price.className = 'menu-price';
      price.textContent = formatPrice(item.price);
      row.appendChild(name);
      row.appendChild(price);
      li.appendChild(row);

      if (item.description) {
        var desc = document.createElement('p');
        desc.className = 'menu-desc';
        desc.textContent = item.description;
        li.appendChild(desc);
      }
      el.menu.appendChild(li);
    });
  }

  // ---------------------------------------------------------------- search

  var SEARCH_LIMIT = 8;
  var searchState = { results: [], active: -1 };

  /* Menu products, read off the menu photos by OCR. Loaded after the map so a
   * slow or missing products.json never delays the shops; until it arrives,
   * search simply works on place fields alone. */
  var products = { index: null, keys: [] };

  function loadProducts() {
    return fetch(PRODUCTS_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        products.index = data.index || {};
        products.keys = Object.keys(products.index);
        // A query typed before this landed should now see product hits.
        if (el.search.value) renderSearchResults(el.search.value);
      });
  }

  /* The index key is normalised ("og kush"); each entry carries the spelling
   * as it appeared on the board ("OG Kush") for display. */
  function displayProduct(term) {
    var entry = products.index && products.index[term];
    return (entry && entry.d) || term;
  }

  /* Normalise for matching, and record which source character every key
   * character came from. Punctuation collapses ("Oudegracht 208, Utrecht" ->
   * "oudegracht 208 utrecht"), so a plain indexOf on the key would land at the
   * wrong offset in the original string when highlighting. */
  function keyWithMap(str) {
    var src = String(str || '');
    var key = '';
    var map = [];
    for (var i = 0; i < src.length; i++) {
      var ch = src.charAt(i).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (!/^[a-z0-9]+$/.test(ch)) {
        if (!key || key.charAt(key.length - 1) === ' ') continue;  // collapse + trim left
        key += ' ';
        map.push(i);
        continue;
      }
      for (var j = 0; j < ch.length; j++) { key += ch.charAt(j); map.push(i); }
    }
    while (key && key.charAt(key.length - 1) === ' ') { key = key.slice(0, -1); map.pop(); }
    return { key: key, map: map };
  }

  function searchKey(str) { return keyWithMap(str).key; }

  function buildSearchIndex() {
    state.shops.forEach(function (shop) {
      shop._name = searchKey(shop.name);
      shop._city = searchKey(shop.city);
      shop._addr = searchKey(shop.address);
    });
  }

  /* Rank: name prefix beats name substring beats city beats street. Closed
   * shops never surface — they are not on the map to fly to. */
  /* Products come from OCR of the menu photos, so they are the least reliable
   * signal — they rank below every place match, and a product hit always says
   * which product matched so the user can judge it. */
  function productMatches(q) {
    if (!products.index || q.length < 3) return null;
    var byShop = Object.create(null);
    var keys = products.keys;
    for (var i = 0; i < keys.length; i++) {
      var term = keys[i];
      if (term.indexOf(q) === -1) continue;
      // Prefer whole-word hits: "haze" should not rank "hazelnut" first.
      var rank = term === q ? 0 : (term.indexOf(q) === 0 || term.indexOf(' ' + q) !== -1) ? 1 : 2;
      var ids = products.index[term].s;
      for (var j = 0; j < ids.length; j++) {
        var cur = byShop[ids[j]];
        if (!cur || rank < cur.rank) byShop[ids[j]] = { rank: rank, term: term };
      }
    }
    return byShop;
  }

  function runSearch(query) {
    var q = searchKey(query);
    if (!q) return [];
    var scored = [];
    var hits = productMatches(q);

    for (var i = 0; i < state.shops.length; i++) {
      var shop = state.shops[i];
      if (shop.status === 'closed' && !SHOW_CLOSED) continue;

      var score = -1;
      if (shop._name.indexOf(q) === 0) score = 0;
      else if (shop._name.indexOf(' ' + q) !== -1) score = 1;
      else if (shop._name.indexOf(q) !== -1) score = 2;
      else if (shop._city.indexOf(q) === 0) score = 3;
      else if (shop._city.indexOf(q) !== -1) score = 4;
      else if (shop._addr.indexOf(q) !== -1) score = 5;

      var hit = hits && hits[shop.id];
      if (score === -1 && !hit) continue;
      // 6, 7, 8 — always below an address match.
      if (score === -1) score = 6 + hit.rank;

      scored.push({ shop: shop, score: score, product: hit ? hit.term : null });
      if (scored.length > 400) break;
    }

    /* A place query has one right answer, so ties break alphabetically. A
     * product query has hundreds — 164 shops sell Amnesia — and the only
     * ordering anyone wants there is "nearest to what I'm looking at". */
    var centre = map.getCenter();
    scored.forEach(function (s) {
      s.dist = s.score >= 6 ? metresBetween(centre.lat, centre.lng, s.shop.lat, s.shop.lng) : 0;
    });
    scored.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      if (a.score >= 6) return a.dist - b.dist;
      return a.shop.name.localeCompare(b.shop.name);
    });

    var productHits = scored.filter(function (s) { return s.score >= 6; }).length;
    var out = scored.slice(0, SEARCH_LIMIT).map(function (s) {
      // The chosen product rides along on the shop for the result row.
      s.shop._hitProduct = s.score >= 6 ? s.product : null;
      s.shop._hitDist = s.score >= 6 ? s.dist : null;
      return s.shop;
    });
    out.productHits = productHits;
    out.productTerm = productHits ? displayProduct(scored.find(function (s) {
      return s.score >= 6;
    }).product) : '';
    return out;
  }

  function metresBetween(lat1, lng1, lat2, lng2) {
    var R = 6371000, rad = function (d) { return d * Math.PI / 180; };
    var dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function prettyDistance(m) {
    if (m == null) return '';
    return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  function highlight(text, query) {
    var frag = document.createDocumentFragment();
    var q = searchKey(query);
    var k = keyWithMap(text);
    var at = q ? k.key.indexOf(q) : -1;
    if (at === -1) { frag.appendChild(document.createTextNode(text)); return frag; }

    var from = k.map[at];
    var to = k.map[at + q.length - 1] + 1;
    frag.appendChild(document.createTextNode(text.slice(0, from)));
    var mark = document.createElement('mark');
    mark.textContent = text.slice(from, to);
    frag.appendChild(mark);
    frag.appendChild(document.createTextNode(text.slice(to)));
    return frag;
  }

  function renderSearchResults(query) {
    var results = runSearch(query);
    searchState.results = results;
    searchState.active = -1;
    el.searchResults.innerHTML = '';

    if (!query.trim()) {
      el.searchResults.hidden = true;
      el.search.setAttribute('aria-expanded', 'false');
      return;
    }

    if (!results.length) {
      var empty = document.createElement('li');
      empty.className = 'search-empty';
      empty.textContent = t('search.noMatch', { q: query });
      el.searchResults.appendChild(empty);
    } else {
      results.forEach(function (shop, i) {
        var info = typeInfo(shop.shop_type);
        var li = document.createElement('li');
        li.className = 'search-result';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.dataset.index = String(i);

        var dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = info.color;

        var text = document.createElement('div');
        text.className = 'search-result-text';
        var name = document.createElement('div');
        name.className = 'search-result-name';
        name.appendChild(highlight(shop.name, query));
        var sub = document.createElement('div');
        sub.className = 'search-result-sub';
        sub.appendChild(highlight(shop.address || shop.city, query));

        text.appendChild(name);
        text.appendChild(sub);

        // Matched on the menu rather than the place — say so, and show the
        // product, since a machine-read menu deserves visible evidence.
        if (shop._hitProduct) {
          var why = document.createElement('div');
          why.className = 'search-result-why';
          var tag = document.createElement('span');
          tag.className = 'why-tag';
          tag.textContent = t('search.menuTag');
          why.appendChild(tag);
          why.appendChild(highlight(displayProduct(shop._hitProduct), query));
          if (shop._hitDist != null) {
            var dist = document.createElement('span');
            dist.className = 'why-dist';
            dist.textContent = prettyDistance(shop._hitDist);
            why.appendChild(dist);
          }
          text.appendChild(why);
        }
        li.appendChild(dot);
        li.appendChild(text);
        // mousedown only holds focus; selecting here would open the sheet
        // before mouseup, and the same physical click would then land on the
        // freshly-shown scrim and close it again.
        li.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        li.addEventListener('click', function () { selectSearchResult(shop); });
        el.searchResults.appendChild(li);
      });
    }

    // Say how many shops sell it, so "8 results" isn't mistaken for "only 8".
    if (results.productHits > results.length) {
      var foot = document.createElement('li');
      foot.className = 'search-foot';
      foot.textContent = results.productHits + ' shops have “' + results.productTerm +
                         '” on their menu — nearest ' + results.length + ' shown';
      el.searchResults.appendChild(foot);
    }

    el.searchResults.hidden = false;
    el.search.setAttribute('aria-expanded', 'true');
  }

  function moveSearchActive(delta) {
    if (!searchState.results.length) return;
    // States are -1 (nothing highlighted) plus 0..count-1. Shift by one so the
    // wrap-around is a plain modulo over count+1 slots.
    var count = searchState.results.length;
    var slot = (searchState.active + 1 + delta + count + 1) % (count + 1);
    searchState.active = slot - 1;

    Array.prototype.forEach.call(el.searchResults.children, function (li, i) {
      var on = i === searchState.active;
      li.classList.toggle('active', on);
      li.setAttribute('aria-selected', String(on));
      if (on && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    });
  }

  function closeSearchResults() {
    el.searchResults.hidden = true;
    el.search.setAttribute('aria-expanded', 'false');
    searchState.active = -1;
  }

  function selectSearchResult(shop) {
    // A hidden category shouldn't swallow a shop the user explicitly searched.
    if (!state.visibleTypes.has(shop.shop_type)) {
      state.visibleTypes.add(shop.shop_type);
      renderFilters();
    }
    if (state.favoritesOnly && !state.favorites.has(shop.id)) {
      state.favoritesOnly = false;
      renderFavoritesUi();
    }

    closeSearchResults();
    el.search.blur();

    map.setView([shop.lat, shop.lng], Math.max(map.getZoom(), 17), { animate: true });
    renderMarkers();          // marker may have been culled out of view
    openSheet(shop.id);
  }

  // ---------------------------------------------------------------- zones

  /* Rules that apply to the street rather than to a shop. Drawn in their own
   * pane so the polygon sits above the tiles but under every pin — a shop must
   * never be hidden by the zone it stands in. */

  function initZonesPane() {
    map.createPane('zones');
    map.getPane('zones').style.zIndex = 350;   // tiles 200, overlay 400, markers 600
  }

  function zonePopup(props) {
    var wrap = document.createElement('div');
    wrap.className = 'zone-popup';

    var title = document.createElement('strong');
    title.textContent = props.name || 'Restricted area';
    wrap.appendChild(title);

    if (props.note) {
      var note = document.createElement('p');
      note.textContent = props.note;
      wrap.appendChild(note);
    }
    if (props.authority || props.url) {
      var src = document.createElement('p');
      src.className = 'zone-source';
      if (props.url) {
        var link = document.createElement('a');
        link.href = props.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = props.authority || 'Official rule';
        src.appendChild(link);
      } else {
        src.textContent = props.authority;
      }
      wrap.appendChild(src);
    }
    return wrap;
  }

  function renderZones(collection) {
    var features = (collection && collection.features) || [];
    if (!features.length) return;

    zonesLayer = L.geoJSON(collection, {
      pane: 'zones',
      style: function (feature) {
        var color = (feature.properties && feature.properties.color) || '#fb7185';
        // Light fill only — on the dark basemap anything heavier turns the
        // whole district into a block and buries the street names.
        return {
          color: color, weight: 2.5, opacity: 0.95,
          fillColor: color, fillOpacity: 0.1,
          dashArray: '6 4'
        };
      },
      onEachFeature: function (feature, layer) {
        var props = feature.properties || {};
        layer.bindPopup(zonePopup(props), { className: 'zone-popup-wrap', maxWidth: 260 });
        if (props.name) layer.bindTooltip(props.name, { sticky: true });
        // Without this the map's own click handler closes the shop sheet
        // underneath the popup we just opened.
        layer.on('click', function (ev) { L.DomEvent.stopPropagation(ev); });
      }
    });
    if (zonesVisible()) zonesLayer.addTo(map);
  }

  function loadZones() {
    return fetch(ZONES_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  // ---------------------------------------------------------------- my location

  /* A Maps-style blue dot: a live marker plus a translucent accuracy circle.
   * Nothing starts until the user asks, so the app never fires a permission
   * prompt on first load — except when permission is already granted, where
   * resuming costs the user nothing. */

  var GEO_KEY = 'cannamap.location.v1';
  var FOLLOW_ZOOM = 15;

  var me = {
    watchId: null,
    marker: null,
    halo: null,
    latlng: null,
    following: false,
    recentring: false,     // guards our own setView against the pan-cancels-follow rule
    silent: false          // true while the automatic on-load request is in flight
  };

  var meIcon = L.divIcon({
    className: 'me-wrap',
    html: '<div class="me-dot"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  var toastTimer = null;

  function toast(message, ms) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, ms || 4000);
  }

  function setLocateState(name) {
    el.locate.dataset.state = name;
    el.locate.setAttribute('aria-pressed', String(me.following));
    el.locate.title = t(
      name === 'locating' ? 'locate.finding' :
      me.following ? 'locate.following' :
      name === 'on' ? 'locate.recentre' :
      'locate.show');
  }

  function startLocating() {
    if (!navigator.geolocation) {
      if (!me.silent) toast(t('toast.noGeo'));
      return;
    }
    if (!window.isSecureContext) {
      // file:// and plain http on a LAN address silently fail in most browsers.
      if (!me.silent) toast(t('toast.needsHttps'), 6000);
      return;
    }

    me.following = true;
    setLocateState('locating');

    if (me.watchId !== null) return;   // already watching, just re-followed
    me.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 10000,
      timeout: 20000
    });
  }

  function stopLocating() {
    if (me.watchId !== null) navigator.geolocation.clearWatch(me.watchId);
    me.watchId = null;
    me.following = false;
    me.latlng = null;
    if (me.marker) { map.removeLayer(me.marker); me.marker = null; }
    if (me.halo) { map.removeLayer(me.halo); me.halo = null; }
    setLocateState('off');
    try { localStorage.removeItem(GEO_KEY); } catch (err) { /* private mode */ }
  }

  function onPosition(pos) {
    var latlng = [pos.coords.latitude, pos.coords.longitude];
    var accuracy = pos.coords.accuracy || 0;
    me.latlng = latlng;

    if (!me.marker) {
      me.marker = L.marker(latlng, {
        icon: meIcon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000      // the dot stays on top of the shop pins
      }).addTo(map);
    } else {
      me.marker.setLatLng(latlng);
    }

    // A tight fix needs no circle; a vague one should say so.
    if (accuracy > 25) {
      if (!me.halo) {
        me.halo = L.circle(latlng, {
          radius: accuracy,
          interactive: false,
          color: '#4a90ff', weight: 1, opacity: 0.5,
          fillColor: '#4a90ff', fillOpacity: 0.12
        }).addTo(map);
      } else {
        me.halo.setLatLng(latlng).setRadius(accuracy);
      }
    } else if (me.halo) {
      map.removeLayer(me.halo);
      me.halo = null;
    }

    if (me.following) {
      me.recentring = true;
      map.setView(latlng, Math.max(map.getZoom(), FOLLOW_ZOOM), { animate: true });
      setTimeout(function () { me.recentring = false; }, 0);
    }

    setLocateState('on');
    me.silent = false;             // a fix landed; later problems are worth saying
    try { localStorage.setItem(GEO_KEY, '1'); } catch (err) { /* private mode */ }
  }

  function onPositionError(err) {
    var silent = me.silent;
    me.silent = false;
    me.following = false;
    if (err.code === 1) {           // PERMISSION_DENIED
      setLocateState('denied');
      // Nothing to complain about when the ask was ours, not the user's.
      if (!silent) toast(t('toast.blocked'), 6000);
      if (me.watchId !== null) { navigator.geolocation.clearWatch(me.watchId); me.watchId = null; }
      try { localStorage.removeItem(GEO_KEY); } catch (e) { /* private mode */ }
      return;
    }
    // Timeout and position-unavailable are transient: keep watching, the next
    // fix may well succeed.
    setLocateState(me.latlng ? 'on' : 'off');
    if (!silent) {
      toast(t(err.code === 3 ? 'toast.stillLooking' : 'toast.failed'));
    }
  }

  function toggleLocate() {
    if (me.following) { stopLocating(); return; }   // following -> off
    startLocating();                                // off, or located-but-panned -> follow
    if (me.latlng) {                                // already have a fix: move now
      me.recentring = true;
      map.setView(me.latlng, Math.max(map.getZoom(), FOLLOW_ZOOM), { animate: true });
      setTimeout(function () { me.recentring = false; }, 0);
      setLocateState('on');
    }
  }

  /* Dragging the map means the user wants to look elsewhere — stop yanking the
   * view back, but keep the dot live. */
  function releaseFollow() {
    if (me.recentring || !me.following) return;
    me.following = false;
    setLocateState(me.latlng ? 'on' : 'off');
  }

  /* Requested by us rather than by the user, so it reports nothing on failure:
   * a prompt they ignored or dismissed is not an error worth a toast. Pressing
   * the button still surfaces errors normally. */
  function autoLocate() {
    me.silent = true;
    startLocating();
  }

  /* Browsers treat a gesture-backed permission request as a normal prompt,
   * while one fired on load can be shown quietly or suppressed outright once
   * dismissed — so the ask waits for the first tap, click or keypress. */
  function askOnFirstGesture() {
    function cleanup() {
      document.removeEventListener('pointerdown', fire, true);
      document.removeEventListener('keydown', fire, true);
    }
    function fire(ev) {
      cleanup();
      // If that first gesture was the locate button, let its own handler make
      // the request — routing it through here would swallow the errors the
      // user is entitled to see, and the pointerdown/click pair would toggle
      // the watch straight back off.
      var t = ev && ev.target;
      if (t && t.closest && t.closest('#locate')) return;
      if (me.watchId === null && !me.following) autoLocate();
    }
    document.addEventListener('pointerdown', fire, true);
    document.addEventListener('keydown', fire, true);
  }

  function initLocation() {
    setLocateState('off');
    el.locate.addEventListener('click', toggleLocate);
    map.on('dragstart', releaseFollow);

    if (!navigator.permissions || !navigator.permissions.query) {
      askOnFirstGesture();
      return;
    }

    navigator.permissions.query({ name: 'geolocation' }).then(function (status) {
      // Already granted: there is no dialog to raise, so resume right away.
      if (status.state === 'granted') { autoLocate(); return; }
      // Denied: the browser will not ask again regardless, and calling in would
      // only strand the button in its blocked state.
      if (status.state === 'denied') {
        try { localStorage.removeItem(GEO_KEY); } catch (err) { /* private mode */ }
        return;
      }
      askOnFirstGesture();
    }).catch(function () { askOnFirstGesture(); });   // Permissions API not available here
  }

  // ---------------------------------------------------------------- viewer

  function openViewer(shop, index) {
    viewer.images = shop.menu_images || [];
    viewer.index = index;
    viewer.shopName = shop.name;
    if (viewer.images.length === 0) return;

    el.lightbox.hidden = false;
    setZoom(false);
    showViewerImage();
    el.lbClose.focus({ preventScroll: true });
  }

  function closeViewer() {
    if (el.lightbox.hidden) return;
    el.lightbox.hidden = true;
    el.lbImg.removeAttribute('src');
    setZoom(false);
  }

  function showViewerImage() {
    var image = viewer.images[viewer.index];
    var many = viewer.images.length > 1;

    el.lbImg.src = image.file;
    el.lbImg.alt = (image.label || 'Menu') + ' for ' + viewer.shopName;
    el.lbLabel.textContent = viewer.shopName +
      (many ? ' · ' + (viewer.index + 1) + '/' + viewer.images.length : '');

    el.lbPrev.hidden = !many;
    el.lbNext.hidden = !many;
    setZoom(false);
    el.lbStage.scrollTop = 0;
    el.lbStage.scrollLeft = 0;
  }

  function stepViewer(delta) {
    if (viewer.images.length < 2) return;
    var count = viewer.images.length;
    viewer.index = (viewer.index + delta + count) % count;
    showViewerImage();
  }

  /* Two states rather than free pinch-zoom: fit-to-screen, or natural width
   * with the stage scrolling. Menu boards are wide and dense, and this keeps
   * the text legible without a gesture library. */
  function setZoom(on) {
    viewer.zoomed = on;
    el.lightbox.classList.toggle('is-zoomed', on);
    el.lbZoom.setAttribute('aria-pressed', String(on));
    el.lbZoom.textContent = t(on ? 'viewer.zoomOut' : 'viewer.zoomIn');
  }

  // ---------------------------------------------------------------- events

  function bindEvents() {
    el.close.addEventListener('click', closeSheet);
    el.scrim.addEventListener('click', closeSheet);

    el.fav.addEventListener('click', function () {
      if (state.selectedId) toggleFavorite(state.selectedId);
    });

    if (el.favToggle) {
      el.favToggle.addEventListener('click', function () {
        state.favoritesOnly = !state.favoritesOnly;
        renderFavoritesUi();
        renderMarkers();
      });
    }

    el.search.addEventListener('input', function () {
      syncSearchChrome();
      renderSearchResults(el.search.value);
    });
    el.search.addEventListener('focus', function () {
      if (el.search.value) renderSearchResults(el.search.value);
    });
    el.search.addEventListener('blur', function () {
      // let a click on a result land first
      setTimeout(closeSearchResults, 120);
    });
    el.search.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSearchActive(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSearchActive(-1); }
      else if (ev.key === 'Enter') {
        var pick = searchState.active >= 0
          ? searchState.results[searchState.active]
          : searchState.results[0];
        if (pick) { ev.preventDefault(); selectSearchResult(pick); }
      } else if (ev.key === 'Escape') {
        ev.stopPropagation();
        if (!el.searchResults.hidden) closeSearchResults();
        else { el.search.value = ''; syncSearchChrome(); el.search.blur(); }
      }
    });
    var goBtn = document.getElementById('search-go');
    if (goBtn) {
      goBtn.addEventListener('click', function () {
        // Same as pressing Enter: take the top hit, or just focus the field.
        if (searchState.results.length) selectSearchResult(searchState.results[0]);
        else el.search.focus();
      });
    }
    el.searchClear.addEventListener('click', function () {
      el.search.value = '';
      closeSearchResults();
      // While a drawer is open the ✕ is its close button; clearing the query
      // alone would leave the drawer standing with nothing to dismiss it.
      if (!el.sheet.hidden) { closeSheet(); return; }
      if (railState.panel) { closePanel(); return; }
      syncSearchChrome();
      el.search.focus();
    });

    el.lbClose.addEventListener('click', closeViewer);
    el.lbZoom.addEventListener('click', function () { setZoom(!viewer.zoomed); });
    el.lbPrev.addEventListener('click', function () { stepViewer(-1); });
    el.lbNext.addEventListener('click', function () { stepViewer(1); });

    // Click the backdrop (but not the image itself) to dismiss.
    el.lbStage.addEventListener('click', function (ev) {
      if (ev.target === el.lbStage) closeViewer();
    });
    el.lbImg.addEventListener('click', function () { setZoom(!viewer.zoomed); });

    document.addEventListener('keydown', function (ev) {
      if (!el.lightbox.hidden) {
        if (ev.key === 'Escape') closeViewer();
        else if (ev.key === 'ArrowLeft') stepViewer(-1);
        else if (ev.key === 'ArrowRight') stepViewer(1);
        return; // viewer sits on top of the sheet, so it eats the key
      }
      if (ev.key === 'Escape') closeSheet();
    });
  }

  // ---------------------------------------------------------------- boot

  function normalize(shop, index) {
    return {
      id: shop.id || 'shop-' + index,
      name: shop.name || 'Unnamed shop',
      shop_type: String(shop.shop_type || 'unknown').toLowerCase(),
      lat: Number(shop.lat),
      lng: Number(shop.lng),
      address: shop.address || '',
      opening_hours: shop.opening_hours || {},
      status: shop.status || 'open',
      note: shop.note || '',
      logo: shop.logo || '',
      website: shop.website || '',
      instagram: shop.instagram || '',
      hours_source: shop.hours_source || '',
      city: shop.city || '',
      amenities: shop.amenities && typeof shop.amenities === 'object' ? shop.amenities : {},
      rating_count: typeof shop.rating_count === 'number' ? shop.rating_count : null,
      rating: typeof shop.rating === 'number' ? shop.rating : null,
      menu_images: Array.isArray(shop.menu_images)
        ? shop.menu_images.filter(function (m) { return m && m.file; })
        : [],
      menu: Array.isArray(shop.menu) ? shop.menu : []
    };
  }

  function loadShops() {
    return fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        // Accept both { shops: [...] } and a bare array, so Phase 2 has room.
        var list = Array.isArray(payload) ? payload : (payload.shops || []);
        return list.map(normalize).filter(function (shop) {
          return isFinite(shop.lat) && isFinite(shop.lng);
        });
      });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return; // needs http(s)
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  function init() {
    applyI18n();      // before anything renders, so nothing shows English first
    initMap();
    initZonesPane();
    bindEvents();
    initLocation();
    initRail();
    initSheetDrag();
    renderFavoritesUi();

    // Independent of the shop data: a zone failure must not blank the map.
    loadZones().then(renderZones).catch(function (err) {
      console.warn('Could not load zones:', err);
    });
    // Menu products are a search enhancement, never a dependency.
    loadProducts().catch(function (err) {
      console.warn('Menu product search unavailable:', err.message);
    });
    registerServiceWorker();

    loadShops().then(function (shops) {
      state.shops = shops;
      // Keep render failures distinguishable from fetch failures — otherwise a
      // plain coding error reports itself as an unreachable server.
      try {
        buildSearchIndex();
        buildTypes();
        createMarkers();
        renderFilters();
        renderMarkers();
        buildRailCities();
      } catch (err) {
        console.error('Shop data loaded, but rendering failed:', err);
        el.empty.textContent = 'Loaded ' + shops.length +
          ' shops but could not draw the map: ' + err.message;
        el.empty.hidden = false;
      }
    }).catch(function (err) {
      console.error('Could not load shop data:', err);
      el.empty.textContent = 'Could not load shop data. Check that ' + DATA_URL +
        ' is reachable (the app must be served over http, not opened as a file).';
      el.empty.hidden = false;
    });
  }

  init();
})();
