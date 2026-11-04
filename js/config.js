/* ============================================================
   STOCKFLOW v5 — Konfigurasi
   ------------------------------------------------------------
   GANTI 2 NILAI DI BAWAH dengan milik project Supabase kamu.

   Project URL:
     Project Settings > Data API > Project URL

   Key publik — ambil SALAH SATU, keduanya berfungsi sama:
     Project Settings > API Keys
       - "Publishable key"  -> sb_publishable_...   (format baru, disarankan)
       - "anon public"      -> eyJhbGciOi...        (legacy, berhenti 2026)

   JANGAN pakai "secret key" atau "service_role" di sini —
   keduanya untuk server, bukan browser.

   Kedua nilai di bawah AMAN berada di browser dan boleh ikut
   ter-upload ke GitHub. Key publik memang dirancang untuk
   dipublikasikan; yang melindungi data adalah RLS di database,
   bukan kerahasiaan key ini.

   Secret key Midtrans dan service_role key TIDAK PERNAH ada di
   file ini. Keduanya hanya hidup di environment Edge Function.
   ============================================================ */

let SUPABASE_URL      = 'https://epqlcuwyhkhjavtwlihl.supabase.co/rest/v1';
let SUPABASE_ANON_KEY = 'sb_publishable_I6wyVmbF_ozk2WYNy1sNRA_X1Yi-aCo';

/* ====== Jangan ubah di bawah ini ======

   Pembersihan otomatis. Kesalahan paling sering adalah URL ikut terbawa
   garis miring di ujung ("https://abc.supabase.co/"), yang membuat
   permintaan jadi "//auth/v1/signup" dan ditolak Supabase dengan pesan
   "Invalid path specified in request URL". Dibereskan di sini supaya
   tidak perlu dipikirkan. */

SUPABASE_URL = String(SUPABASE_URL).trim()
  .replace(/\/+$/, '')                 // buang garis miring di ujung
  .replace(/\/(rest|auth|storage)\/v1$/, '');  // kalau tanpa sengaja copy URL endpoint

SUPABASE_ANON_KEY = String(SUPABASE_ANON_KEY).trim();

const SF_CONFIGURED =
  !SUPABASE_URL.includes('GANTI-INI') && !SUPABASE_ANON_KEY.includes('GANTI');

/* Peringatan dini kalau isinya kelihatan keliru */
const SF_CONFIG_PROBLEM = (function () {
  if (!SF_CONFIGURED) return null;
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL)) {
    return 'Project URL tidak sesuai format. Seharusnya persis seperti ' +
           '"https://abcdefgh.supabase.co" — tanpa garis miring di ujung ' +
           'dan tanpa tambahan path. Yang terisi sekarang: ' + SUPABASE_URL;
  }
  if (/^sb_secret_/.test(SUPABASE_ANON_KEY)) {
    return 'Anda memakai SECRET key. Key itu untuk server dan tidak boleh ada ' +
           'di browser. Pakai "Publishable key" (sb_publishable_...) atau ' +
           '"anon public".';
  }
  if (/^eyJ/.test(SUPABASE_ANON_KEY)) {
    try {
      var role = JSON.parse(atob(SUPABASE_ANON_KEY.split('.')[1] || '')).role;
      if (role === 'service_role') {
        return 'Anda memakai service_role key. Key itu melewati semua ' +
               'pengamanan dan tidak boleh ada di browser. Pakai "anon public".';
      }
    } catch (e) {}
  } else if (!/^sb_publishable_/.test(SUPABASE_ANON_KEY)) {
    return 'Key tidak dikenali. Seharusnya diawali "sb_publishable_" atau "eyJ".';
  }
  return null;
})();

const STORAGE_BUCKET = 'stockflow';
const FUNCTIONS_URL  = SUPABASE_URL.replace('.supabase.co', '.functions.supabase.co');

/* Berapa sering kasir menanyakan status pembayaran (ms) */
const POLL_INTERVAL_MS = 3000;
