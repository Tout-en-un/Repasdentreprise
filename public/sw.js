/* ═══ FoodChooseApp Service Worker ═══ */
const CACHE_VERSION = 'v5';
const STATIC_CACHE  = 'fca-static-'  + CACHE_VERSION;
const PAGES_CACHE   = 'fca-pages-'   + CACHE_VERSION;
const API_CACHE     = 'fca-api-'     + CACHE_VERSION;

// Assets statiques à précacher
const PRECACHE_ASSETS = [
  '/assets/css/main.css',
  '/assets/js/utils.js',
  '/assets/images/logo.svg',
  '/assets/images/icon-192.png',
  '/assets/images/icon-512.png',
  '/manifest.json',
  '/offline.html'
];

// Pages HTML à précacher
const PRECACHE_PAGES = [
  '/',
  '/login',
  '/company/login',
  '/company/register',
  '/restaurant/login',
  '/restaurant/register'
];

// ── Installation ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then(c => c.addAll(PRECACHE_ASSETS).catch(() => {})),
      caches.open(PAGES_CACHE).then(c =>
        Promise.all(PRECACHE_PAGES.map(url =>
          fetch(url).then(r => { if (r.ok) c.put(url, r); }).catch(() => {})
        ))
      )
    ]).then(() => self.skipWaiting())
  );
});

// ── Activation : purge vieux caches ──────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => ![STATIC_CACHE, PAGES_CACHE, API_CACHE].includes(k))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Stratégies de cache ───────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorer les requêtes non-GET et cross-origin
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  // ── API : Network Only avec fallback JSON offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(r => {
          // Mettre en cache les réponses GET de lecture
          if (r.ok && isReadableAPI(url.pathname)) {
            caches.open(API_CACHE).then(c => c.put(request, r.clone()));
          }
          return r;
        })
        .catch(() =>
          caches.match(request).then(cached =>
            cached || new Response(
              JSON.stringify({ error: 'Hors ligne — données indisponibles', offline: true }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            )
          )
        )
    );
    return;
  }

  // ── Assets statiques (CSS, JS, images) : Cache First
  if (isStaticAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) {
          // Revalidation en arrière-plan (stale-while-revalidate)
          fetch(request).then(fresh => {
            if (fresh.ok) caches.open(STATIC_CACHE).then(c => c.put(request, fresh));
          }).catch(() => {});
          return cached;
        }
        return fetch(request).then(fresh => {
          if (fresh.ok) caches.open(STATIC_CACHE).then(c => c.put(request, fresh.clone()));
          return fresh;
        });
      })
    );
    return;
  }

  // ── Pages HTML : Network First, cache en fallback
  event.respondWith(
    fetch(request)
      .then(r => {
        if (r.ok) caches.open(PAGES_CACHE).then(c => c.put(request, r.clone()));
        return r;
      })
      .catch(() =>
        caches.match(request).then(cached => cached || caches.match('/offline.html'))
      )
  );
});

// ── Push Notifications ────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'FoodChooseApp', body: 'Nouvelle notification', icon: '/assets/images/icon-192.png' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch(e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/assets/images/icon-192.png',
      badge: '/assets/images/icon-96.png',
      vibrate: [100, 50, 100],
      data: { url: data.url || '/' },
      actions: data.actions || []
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(location.origin) && 'focus' in c);
      if (existing) return existing.focus().then(c => c.navigate(url));
      return clients.openWindow(url);
    })
  );
});

// ── Background Sync ───────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'sync-orders') {
    event.waitUntil(syncPendingOrders());
  }
});

async function syncPendingOrders() {
  const cache = await caches.open('fca-pending-orders');
  const keys  = await cache.keys();
  await Promise.all(keys.map(async req => {
    try {
      const r = await fetch(req);
      if (r.ok) await cache.delete(req);
    } catch(e) {}
  }));
}

// ── Helpers ───────────────────────────────────────────────
function isStaticAsset(pathname) {
  return /\.(css|js|png|svg|jpg|jpeg|webp|woff2?|ico)$/.test(pathname);
}

function isReadableAPI(pathname) {
  const readEndpoints = ['/stats', '/menus', '/ratings', '/affiliations', '/restaurants'];
  return readEndpoints.some(e => pathname.includes(e));
}
