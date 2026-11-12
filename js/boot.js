/* ============================================================
   STOCKFLOW — dimuat paling awal di setiap halaman
   1. Tolak dibuka di dalam iframe situs lain (clickjacking).
   2. Daftarkan service worker (bisa dipasang & dibuka offline).
   ============================================================ */
(function () {
  try {
    if (window.top !== window.self && location.protocol === 'https:') {
      document.documentElement.style.display = 'none';
      window.top.location = window.self.location.href;
    }
  } catch (e) {
    /* Akses ke window.top ditolak = dibingkai origin lain */
    document.documentElement.style.display = 'none';
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
