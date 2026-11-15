/* ============================================================
   STOCKFLOW — Service Worker
   • Halaman & aset aplikasi disimpan di perangkat supaya kasir
     tetap bisa dibuka saat internet putus.
   • Data (Supabase) TIDAK pernah disimpan di sini; transaksi
     offline ditangani pos.html lewat antrean di localStorage.
   ============================================================ */
const VERSION = 'sf-20261115b';
const SHELL = [
  './', 'index.html', 'masuk.html', 'pos.html', 'orders.html', 'products.html',
  'inventory.html', 'damaged.html', 'reports.html', 'users.html', 'settings.html',
  'audit.html', 'admin.html', 'privasi.html', 'ketentuan.html',
  'css/app.css', 'css/landing.css',
  'js/icons.js', 'js/printer.js', 'js/config.js', 'js/demo.js', 'js/api.js', 'js/auth.js', 'js/ui.js',
  'img/icon-192.png', 'img/icon-512.png', 'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // Supabase, Midtrans, dll: selalu ke jaringan

  /* Halaman: coba jaringan dulu (selalu versi terbaru), cadangan dari cache */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('pos.html'))),
    );
    return;
  }

  /* Aset: langsung dari cache, sambil diperbarui di belakang */
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    }),
  );
});
