/* ============================================================
   StockFlow v5 — tes logika inti & keamanan (tanpa DOM)
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const SRC = __dirname;

/* ---------- Stub browser ---------- */
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const noop = () => {};
const fakeEl = new Proxy({}, {
  get: (t, p) => {
    if (p === 'classList') return { add: noop, remove: noop, toggle: noop, contains: () => false };
    if (p === 'style') return {};
    if (['appendChild', 'remove', 'setAttribute', 'focus', 'addEventListener'].includes(p)) return noop;
    if (p === 'querySelector') return () => fakeEl;
    if (p === 'querySelectorAll') return () => [];
    return '';
  },
  set: () => true,
});

const sandbox = {
  console, localStorage,
  location: { search: '', href: '', replace: noop },
  document: {
    getElementById: () => fakeEl, createElement: () => fakeEl,
    querySelector: () => fakeEl, querySelectorAll: () => [],
    addEventListener: noop, documentElement: { setAttribute: noop },
    body: { appendChild: noop }, readyState: 'complete',
  },
  URLSearchParams, TextEncoder, TextDecoder,
  crypto: { subtle: nodeCrypto.webcrypto.subtle },
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  unescape, escape, encodeURIComponent, decodeURIComponent,
  fetch: () => Promise.reject(new Error('jaringan tidak dipakai di tes ini')),
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Number, String, Array, Object, Promise, Set, Map,
  RegExp, Error, isNaN, parseInt, parseFloat, Blob: class {},
  FileReader: class { readAsDataURL() { this.onload({ target: { result: 'data:,' } }); } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const ctx = vm.createContext(sandbox);
for (const f of ['icons', 'printer', 'config', 'demo', 'api', 'auth', 'ui']) {
  vm.runInContext(fs.readFileSync(path.join(SRC, 'js', f + '.js'), 'utf8'), ctx, { filename: f + '.js' });
}
const { Demo, API, UI, Auth, Icons, Printer } = vm.runInContext(
  '({ Demo: Demo, API: API, UI: UI, Auth: Auth, Icons: Icons, Printer: Printer })', ctx);

/* ---------- Kerangka ---------- */
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    console.log('  FAIL  ' + name +
      '\n          dapat: ' + JSON.stringify(got) +
      '\n          harap: ' + JSON.stringify(want));
  }
};
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const section = (s) => console.log('\n' + s);

(async function () {

/* ============================================================ */
section('[1] Signature webhook Midtrans — SHA512(order+code+amount+key)');

/* Replika persis fungsi di supabase/functions/_shared/lib.ts */
async function midtransSignature(orderId, statusCode, grossAmount, serverKey) {
  const input = `${orderId}${statusCode}${grossAmount}${serverKey}`;
  const buf = await nodeCrypto.webcrypto.subtle.digest(
    'SHA-512', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Contoh dari dokumentasi resmi Midtrans */
const DOC = {
  orderId: '1111', statusCode: '200', grossAmount: '100000.00',
  serverKey: 'askvnoibnosifnboseofinbofinfgbiufglnbfg',
};
const refSig = nodeCrypto.createHash('sha512')
  .update(DOC.orderId + DOC.statusCode + DOC.grossAmount + DOC.serverKey)
  .digest('hex');
const mySig = await midtransSignature(DOC.orderId, DOC.statusCode, DOC.grossAmount, DOC.serverKey);

eq('cocok dengan SHA512 contoh dokumentasi', mySig, refSig);
eq('panjang hex 128 karakter', mySig.length, 128);
ok('hanya huruf kecil & angka', /^[0-9a-f]{128}$/.test(mySig), mySig.slice(0, 20));

/* Urutan field tidak boleh tertukar */
const wrongOrder = await midtransSignature(
  DOC.statusCode, DOC.orderId, DOC.grossAmount, DOC.serverKey);
ok('urutan field berpengaruh (anti salah susun)', wrongOrder !== mySig);

/* Satu karakter beda -> signature beda total */
const tampered = await midtransSignature('1112', DOC.statusCode, DOC.grossAmount, DOC.serverKey);
ok('order_id dipalsukan -> signature berbeda', tampered !== mySig);
const tamperedAmt = await midtransSignature(DOC.orderId, DOC.statusCode, '1.00', DOC.serverKey);
ok('nominal dipalsukan -> signature berbeda', tamperedAmt !== mySig);
const wrongKey = await midtransSignature(DOC.orderId, DOC.statusCode, DOC.grossAmount, 'kunci-salah');
ok('tanpa server key asli -> tidak bisa dipalsukan', wrongKey !== mySig);

/* ============================================================ */
section('[2] Perbandingan waktu-konstan');

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
ok('sama -> true',                safeEqual(mySig, refSig));
ok('beda -> false',               !safeEqual(mySig, tampered));
ok('panjang beda -> false',       !safeEqual(mySig, mySig.slice(0, 100)));
ok('string kosong sama -> true',  safeEqual('', ''));

/* ============================================================ */
section('[3] Pemetaan status Midtrans -> status internal');

function mapMidtransStatus(ts, fs_) {
  if (fs_ === 'deny') return 'failed';
  switch (ts) {
    case 'capture': case 'settlement': return 'paid';
    case 'pending': return 'pending';
    case 'expire': return 'expired';
    case 'deny': case 'cancel': case 'failure': return 'failed';
    default: return 'pending';
  }
}
eq('settlement -> paid',            mapMidtransStatus('settlement'), 'paid');
eq('capture -> paid',               mapMidtransStatus('capture'), 'paid');
eq('pending -> pending',            mapMidtransStatus('pending'), 'pending');
eq('expire -> expired',             mapMidtransStatus('expire'), 'expired');
eq('deny -> failed',                mapMidtransStatus('deny'), 'failed');
eq('cancel -> failed',              mapMidtransStatus('cancel'), 'failed');
eq('failure -> failed',             mapMidtransStatus('failure'), 'failed');
eq('fraud deny menimpa settlement', mapMidtransStatus('settlement', 'deny'), 'failed');
eq('status asing -> pending (aman)', mapMidtransStatus('entah-apa'), 'pending');

/* ============================================================ */
section('[4] Format & escaping');
eq('rp(0)',        UI.rp(0),        'Rp 0');
eq('rp(18000)',    UI.rp(18000),    'Rp 18.000');
eq('rp(1234567)',  UI.rp(1234567),  'Rp 1.234.567');
eq('rp(null)',     UI.rp(null),     'Rp 0');
eq('num(2,5)',     UI.num(2.5),     '2,5');
eq('mmss(900000)', UI.mmss(900000), '15:00');
eq('mmss(61000)',  UI.mmss(61000),  '01:01');
eq('mmss(negatif)',UI.mmss(-5000),  '00:00');
eq('esc XSS', UI.esc('<img src=x onerror="a">'),
   '&lt;img src=x onerror=&quot;a&quot;&gt;');
eq('esc kutip tunggal', UI.esc("' onclick='x"), '&#39; onclick=&#39;x');
ok('statusBadge pending', UI.statusBadge('pending').includes('Menunggu bayar'));
ok('statusBadge paid',    UI.statusBadge('paid').includes('Lunas'));

/* ============================================================ */
section('[5] URL PostgREST (tanpa business_id di klien)');
const u1 = API.from('products').select('*').eq('active', true).order('name').url();
ok('tidak menyelipkan business_id', !u1.includes('business_id'), u1);
ok('filter & order benar', u1.includes('active=eq.true') && u1.includes('order=name.asc'), u1);

const u2 = API.from('orders').select('*').order('created_at', false).limit(50).url();
ok('order desc + limit', u2.includes('order=created_at.desc') && u2.includes('limit=50'), u2);

/* ============================================================ */
section('[6] Mode demo: login & isolasi');
localStorage.setItem('sf5_demo', '1');
ok('demo aktif', Demo.on());

let a = Demo.login('demo@stockflow.id', 'demo1234');
ok('login owner berhasil', a.ok, JSON.stringify(a));
eq('peran owner', Auth.user().role, 'owner');
ok('isOwner() true', Auth.isOwner());

a = Demo.login('demo@stockflow.id', 'salah');
eq('password salah ditolak', a.msg, 'Email atau password salah');
a = Demo.login('bukan@ada.id', 'demo1234');
eq('email tak ada ditolak (pesan sama)', a.msg, 'Email atau password salah');

a = Demo.login('kasir@stockflow.id', 'demo1234');
ok('login staff berhasil', a.ok);
eq('peran staff', Auth.user().role, 'staff');
ok('isOwner() false untuk staff', !Auth.isOwner());

/* Staff tidak boleh mengelola pengguna */
let r = Demo.invoke('create-staff', { action: 'create', name: 'X', email: 'x@y.id', password: 'abcd1234' });
eq('staff ditolak membuat pengguna', r.error.message, 'Hanya owner yang boleh mengelola pengguna');

/* Staff tidak boleh void */
r = Demo.rpc('void_order', { p_order_id: 'apa-saja' });
eq('staff ditolak void', r.error.message, 'Hanya owner yang boleh void');

Demo.login('demo@stockflow.id', 'demo1234');  // kembali ke owner

/* ============================================================ */
section('[7] Transaksi tunai');
const kopi = { product_id: 'p1', name: 'Kopi Susu Gula Aren', price: 18000, cost: 9000, qty: 2 };
const nasi = { product_id: 'p5', name: 'Nasi Goreng Spesial', price: 25000, cost: 13000, qty: 1 };

let c = Demo.rpc('checkout_cash', {
  p_items: [kopi, nasi], p_discount: 0, p_tax: 0, p_paid: 100000, p_method: 'cash',
});
eq('subtotal 2x18000+25000', c.data.subtotal, 61000);
eq('total', c.data.total, 61000);
eq('kembalian', c.data.change_amount, 39000);
ok('format invoice', /^INV-\d{8}-\d{4}$/.test(c.data.order_no), c.data.order_no);

let db = JSON.parse(localStorage.getItem('sf5_demo_data'));
eq('stok p1 40->38', Number(db.products.find((p) => p.id === 'p1').stock), 38);
eq('stok p5 25->24', Number(db.products.find((p) => p.id === 'p5').stock), 24);
eq('order lunas', db.orders[0].status, 'paid');

c = Demo.rpc('checkout_cash', { p_items: [nasi], p_discount: 5000, p_tax: 2000, p_paid: 30000 });
eq('diskon+pajak: 25000-5000+2000', c.data.total, 22000);
eq('kembalian', c.data.change_amount, 8000);

c = Demo.rpc('checkout_cash', { p_items: [nasi], p_paid: 1000 });
ok('uang kurang ditolak', !!c.error, JSON.stringify(c));

c = Demo.rpc('checkout_cash', {
  p_items: [{ product_id: 'p9', name: 'Roti Bakar', price: 12000, cost: 5000, qty: 1 }], p_paid: 20000,
});
ok('stok habis ditolak', !!c.error && /tidak cukup/.test(c.error.message), JSON.stringify(c));

/* ============================================================ */
section('[8] Alur QRIS: pending -> stok BELUM terpotong');
db = JSON.parse(localStorage.getItem('sf5_demo_data'));
const stokSebelum = Number(db.products.find((p) => p.id === 'p1').stock);

let ord = Demo.rpc('order_create_pending', {
  p_items: [kopi], p_discount: 0, p_tax: 0, p_method: 'qris',
});
ok('order pending dibuat', !ord.error, JSON.stringify(ord.error));
eq('total pending', ord.data.total, 36000);

db = JSON.parse(localStorage.getItem('sf5_demo_data'));
eq('stok BELUM terpotong saat pending',
   Number(db.products.find((p) => p.id === 'p1').stock), stokSebelum);
eq('status order pending',
   db.orders.find((o) => o.id === ord.data.id).status, 'pending');

/* Buat tagihan QRIS */
let pay = Demo.invoke('payment-create', { order_id: ord.data.id });
ok('tagihan QRIS dibuat', !pay.error, JSON.stringify(pay.error));
ok('ada URL QR', !!pay.data.qr_url);
eq('gateway_order_id = order_no', pay.data.gateway_order_id, ord.data.order_no);
eq('nominal tagihan', pay.data.amount, 36000);

/* Polling sebelum tenggat -> masih pending */
let st = Demo.invoke('payment-status', { gateway_order_id: pay.data.gateway_order_id });
eq('polling awal: pending', st.data.status, 'pending');

db = JSON.parse(localStorage.getItem('sf5_demo_data'));
eq('stok tetap utuh selama pending',
   Number(db.products.find((p) => p.id === 'p1').stock), stokSebelum);

/* Percepat simulasi pembayaran */
db = JSON.parse(localStorage.getItem('sf5_demo_data'));
db.payments.find((p) => p.gateway_order_id === pay.data.gateway_order_id)._autoPaidAt = 0;
localStorage.setItem('sf5_demo_data', JSON.stringify(db));

st = Demo.invoke('payment-status', { gateway_order_id: pay.data.gateway_order_id });
eq('setelah dibayar: paid', st.data.status, 'paid');

db = JSON.parse(localStorage.getItem('sf5_demo_data'));
eq('stok terpotong SETELAH lunas',
   Number(db.products.find((p) => p.id === 'p1').stock), stokSebelum - 2);
const paidOrder = db.orders.find((o) => o.id === ord.data.id);
eq('order jadi lunas', paidOrder.status, 'paid');
eq('paid_amount = total', Number(paidOrder.paid_amount), 36000);
eq('pergerakan stok tercatat',
   db.stock_movements.filter((m) => m.note.includes(paidOrder.order_no)).length, 1);

/* Idempotensi: polling lagi tidak boleh memotong stok dua kali */
st = Demo.invoke('payment-status', { gateway_order_id: pay.data.gateway_order_id });
eq('polling ulang: final', st.data.final, true);
db = JSON.parse(localStorage.getItem('sf5_demo_data'));
eq('stok tidak terpotong dua kali',
   Number(db.products.find((p) => p.id === 'p1').stock), stokSebelum - 2);

/* ============================================================ */
section('[9] Batalkan QRIS yang belum dibayar');
ord = Demo.rpc('order_create_pending', { p_items: [nasi], p_method: 'qris' });
db = JSON.parse(localStorage.getItem('sf5_demo_data'));
const stokNasi = Number(db.products.find((p) => p.id === 'p5').stock);

pay = Demo.invoke('payment-create', { order_id: ord.data.id });
ok('tagihan kedua dibuat', !pay.error);

r = Demo.rpc('order_cancel_pending', { p_order_id: ord.data.id });
ok('pembatalan berhasil', !r.error, JSON.stringify(r.error));

db = JSON.parse(localStorage.getItem('sf5_demo_data'));
eq('order jadi failed', db.orders.find((o) => o.id === ord.data.id).status, 'failed');
eq('stok tidak berubah', Number(db.products.find((p) => p.id === 'p5').stock), stokNasi);
eq('payment jadi cancelled',
   db.payments.find((p) => p.gateway_order_id === pay.data.gateway_order_id).status, 'cancelled');

r = Demo.rpc('order_cancel_pending', { p_order_id: ord.data.id });
ok('batalkan dua kali ditolak', !!r.error, JSON.stringify(r));

/* ============================================================ */
section('[10] Retry: percobaan kedua pakai gateway_order_id berbeda');
ord = Demo.rpc('order_create_pending', { p_items: [nasi], p_method: 'qris' });
const pay1 = Demo.invoke('payment-create', { order_id: ord.data.id });
/* paksa order kembali pending agar bisa retry */
db = JSON.parse(localStorage.getItem('sf5_demo_data'));
db.orders.find((o) => o.id === ord.data.id).status = 'pending';
localStorage.setItem('sf5_demo_data', JSON.stringify(db));
const pay2 = Demo.invoke('payment-create', { order_id: ord.data.id });

eq('percobaan 1 tanpa suffix', pay1.data.gateway_order_id, ord.data.order_no);
eq('percobaan 2 pakai -R2',    pay2.data.gateway_order_id, ord.data.order_no + '-R2');
ok('kedua id berbeda (Midtrans tolak duplikat)',
   pay1.data.gateway_order_id !== pay2.data.gateway_order_id);

/* ============================================================ */
section('[11] Void mengembalikan stok');
db = JSON.parse(localStorage.getItem('sf5_demo_data'));
const lunas = db.orders.find((o) => o.status === 'paid');
const itemsLunas = db.order_items.filter((i) => i.order_id === lunas.id);
const stokPra = {};
itemsLunas.forEach((i) => { stokPra[i.product_id] = Number(db.products.find((p) => p.id === i.product_id).stock); });

r = Demo.rpc('void_order', { p_order_id: lunas.id });
ok('void berhasil', !r.error, JSON.stringify(r.error));

db = JSON.parse(localStorage.getItem('sf5_demo_data'));
eq('status jadi void', db.orders.find((o) => o.id === lunas.id).status, 'void');
let allBack = itemsLunas.every((i) =>
  Number(db.products.find((p) => p.id === i.product_id).stock) === stokPra[i.product_id] + Number(i.qty));
ok('semua stok dikembalikan', allBack);

r = Demo.rpc('void_order', { p_order_id: lunas.id });
ok('void dua kali ditolak', !!r.error, JSON.stringify(r));

/* ============================================================ */
section('[12] Pengelolaan pengguna');
r = Demo.invoke('create-staff', {
  action: 'create', name: 'Kasir Baru', email: 'baru@toko.id', password: 'rahasia123', role: 'staff',
});
ok('owner bisa membuat staff', !r.error, JSON.stringify(r.error));

r = Demo.invoke('create-staff', {
  action: 'create', name: 'Dobel', email: 'baru@toko.id', password: 'rahasia123', role: 'staff',
});
eq('email ganda ditolak', r.error.message, 'Email sudah terdaftar');

r = Demo.invoke('create-staff', {
  action: 'create', name: 'Pendek', email: 'pendek@toko.id', password: 'abc', role: 'staff',
});
eq('password pendek ditolak', r.error.message, 'Password minimal 8 karakter');

db = JSON.parse(localStorage.getItem('sf5_demo_data'));
const ownerId = db.profiles.find((p) => p.role === 'owner').id;
r = Demo.invoke('create-staff', { action: 'update', user_id: ownerId, role: 'staff' });
eq('owner terakhir tidak bisa diturunkan',
   r.error.message, 'Toko harus punya minimal satu owner aktif');

r = Demo.invoke('create-staff', { action: 'update', user_id: ownerId, active: false });
eq('owner terakhir tidak bisa dinonaktifkan',
   r.error.message, 'Toko harus punya minimal satu owner aktif');

r = Demo.invoke('create-staff', { action: 'delete', user_id: ownerId });
ok('tidak bisa hapus diri sendiri',
   /akun sendiri|owner aktif/.test(r.error.message), r.error.message);

/* Akun nonaktif tidak bisa masuk */
db = JSON.parse(localStorage.getItem('sf5_demo_data'));
const staffBaru = db.profiles.find((p) => p._email === 'baru@toko.id');
Demo.invoke('create-staff', { action: 'update', user_id: staffBaru.id, active: false });
a = Demo.login('baru@toko.id', 'rahasia123');
ok('akun nonaktif ditolak masuk', !a.ok && /dinonaktifkan/.test(a.msg), JSON.stringify(a));

Demo.login('demo@stockflow.id', 'demo1234');

/* ============================================================ */
section('[13] Audit: tidak ada secret di kode klien');
const clientFiles = ['js/config.js', 'js/api.js', 'js/auth.js', 'js/ui.js', 'js/demo.js'];
const htmlFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.html'));

/* Buang komentar: menyebut "service_role" di komentar penjelasan itu wajar,
   yang berbahaya adalah nilainya benar-benar ada di kode. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
   .replace(/<!--[\s\S]*?-->/g, '');

let leaks = [];
for (const f of clientFiles.concat(htmlFiles)) {
  const s = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
  /* Pola nilai rahasia yang tidak boleh ada di sisi klien */
  if (/Mid-server-[A-Za-z0-9]{8,}/.test(s))        leaks.push(f + ': server key Midtrans');
  if (/SB-Mid-server-/.test(s))                     leaks.push(f + ': server key Midtrans (sandbox)');
  if (/MIDTRANS[_A-Z]*\s*=\s*['"][^'"]{8,}/.test(s)) leaks.push(f + ': kredensial Midtrans');
  if (/SERVICE_ROLE[_A-Z]*\s*=\s*['"][^'"]{8,}/.test(s)) leaks.push(f + ': service_role key');
  if (/eyJ[A-Za-z0-9_-]{30,}\.eyJ/.test(s))         leaks.push(f + ': JWT ter-hardcode');
}
ok('tidak ada nilai rahasia di file klien', leaks.length === 0, leaks.join(' | '));

/* Klien tidak boleh menyentuh endpoint admin Auth atau memakai service_role */
for (const f of clientFiles) {
  const s = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
  ok(f + ': tidak memanggil /auth/v1/admin', !/auth\/v1\/admin/.test(s));
}

/* Pastikan secret HANYA dibaca lewat env di Edge Function */
const edge = fs.readFileSync(path.join(SRC, 'supabase/functions/_shared/lib.ts'), 'utf8');
ok('server key Midtrans dibaca dari env sebagai cadangan',
   /Deno\.env\.get\('MIDTRANS_SERVER_KEY'\)/.test(edge));
ok('key rahasia dibaca dari env', /Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/.test(edge));
ok('key publik dibaca dari env',  /Deno\.env\.get\('SUPABASE_ANON_KEY'\)/.test(edge));
ok('tidak ada key literal di lib.ts',
   !/Mid-server-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{30,}\.eyJ/.test(edge));

/* Webhook harus memverifikasi signature sebelum menyentuh DB */
const whFull = fs.readFileSync(path.join(SRC, 'supabase/functions/payment-webhook/index.ts'), 'utf8');
/* Abaikan blok import di atas — yang diukur urutan di dalam handler */
const wh = whFull.slice(whFull.indexOf('Deno.serve'));
const idxSig = wh.indexOf('midtransSignature');
const idxGuard = wh.indexOf('safeEqual');
const idxRpc = wh.indexOf('sbRpc');
ok('webhook hitung signature sebelum tulis DB',
   idxSig > 0 && idxRpc > idxSig, 'sig@' + idxSig + ' rpc@' + idxRpc);
ok('webhook tolak signature salah sebelum tulis DB',
   idxGuard > idxSig && idxRpc > idxGuard, 'guard@' + idxGuard + ' rpc@' + idxRpc);
ok('webhook membalas 403 saat signature salah',
   /safeEqual[\s\S]{0,400}?403/.test(wh));
ok('webhook pakai perbandingan waktu-konstan', /safeEqual/.test(wh));
ok('webhook konfirmasi ulang ke gateway', /\/status/.test(wh));

/* Fungsi berbahaya tidak boleh bisa dipanggil pengguna biasa */
const sql = fs.readFileSync(path.join(SRC, 'schema.sql'), 'utf8');
ok('order_settle dicabut dari authenticated',
   /revoke execute on function order_settle[^;]*authenticated/i.test(sql));
ok('order_mark_failed dicabut dari authenticated',
   /revoke execute on function order_mark_failed[^;]*authenticated/i.test(sql));
ok('tidak ada kolom password di skema',
   !/^\s*password\s+text/mi.test(sql));
ok('RLS diaktifkan untuk semua tabel inti',
   ['businesses','profiles','categories','products','stock_movements',
    'orders','order_items','expenses','payments']
     .every((t) => new RegExp('alter table ' + t + '\\s+enable row level security', 'i').test(sql)));
ok('payments tidak bisa ditulis dari klien',
   !/create policy[^;]*on payments for (all|insert|update)/i.test(sql));
ok('expenses dibatasi owner',
   /create policy exp_all on expenses[^;]*app_is_owner\(\)/is.test(sql));
ok('helper RLS pakai security definer (anti rekursi)',
   /function app_business_id\(\)[\s\S]{0,200}security definer/i.test(sql));


/* ============================================================ */
section('[14] Dukungan format key Supabase baru (sb_publishable_/sb_secret_)');

/* Key baru BUKAN JWT. Kalau ikut dikirim sebagai Authorization: Bearer,
   Supabase menolak dengan "Invalid JWT". Jadi authHeaders() hanya boleh
   mengirim Authorization kalau ada JWT pengguna sungguhan. */
const apiSrc = fs.readFileSync(path.join(SRC, 'js/api.js'), 'utf8');
ok('authHeaders kirim Authorization hanya jika ada token',
   /if \(tk\)\s*h\.Authorization/.test(apiSrc));
ok('tidak ada fallback Bearer ke anon key',
   !/Bearer['\s+]*\+\s*\(tk\s*\|\|/.test(apiSrc) &&
   !/tk\s*\|\|\s*SUPABASE_ANON_KEY/.test(apiSrc));
ok('apikey selalu dikirim', /apikey:\s*SUPABASE_ANON_KEY/.test(apiSrc));

/* Edge Function harus menerima kedua format key */
const libSrc = fs.readFileSync(path.join(SRC, 'supabase/functions/_shared/lib.ts'), 'utf8');
ok('publicKey() dukung ANON_KEY dan PUBLISHABLE_KEYS',
   /SUPABASE_ANON_KEY'\)\s*\|\|\s*fromJsonEnv\('SUPABASE_PUBLISHABLE_KEYS/.test(libSrc));
ok('adminKey() dukung SERVICE_ROLE_KEY dan SECRET_KEYS',
   /SUPABASE_SERVICE_ROLE_KEY'\)\s*\|\|\s*fromJsonEnv\('SUPABASE_SECRET_KEYS/.test(libSrc));
ok('key non-JWT tidak dikirim sebagai Bearer',
   /isJwt\(key\)\)\s*h\.Authorization/.test(libSrc));
ok('deteksi JWT lewat awalan eyJ', /startsWith\('eyJ'\)/.test(libSrc));

/* Simulasi fromJsonEnv: format SUPABASE_SECRET_KEYS adalah JSON per nama */
function fromJsonEnvSim(raw) {
  if (!raw) return null;
  try { const o = JSON.parse(raw); return o.default || o[Object.keys(o)[0]] || null; }
  catch { return null; }
}
eq('ambil key bernama default',
   fromJsonEnvSim('{"default":"sb_secret_abc"}'), 'sb_secret_abc');
eq('ambil key pertama kalau tanpa default',
   fromJsonEnvSim('{"billing":"sb_secret_xyz"}'), 'sb_secret_xyz');
eq('JSON rusak -> null', fromJsonEnvSim('bukan json'), null);
eq('kosong -> null', fromJsonEnvSim(''), null);

/* create-staff tidak boleh menyusun header key sendiri */
const csSrc = fs.readFileSync(path.join(SRC, 'supabase/functions/create-staff/index.ts'), 'utf8');
ok('create-staff pakai helper authAdmin', /authAdmin\(/.test(csSrc));
ok('create-staff tidak menyusun header key manual',
   !/SERVICE_ROLE_KEY/.test(csSrc));


/* ============================================================ */
section('[15] Normalisasi config (anti "Invalid path specified in request URL")');

function loadConfig(url, key) {
  const src = fs.readFileSync(path.join(SRC, 'js/config.js'), 'utf8')
    .replace(/^let SUPABASE_URL\s*=.*$/m,      `let SUPABASE_URL = ${JSON.stringify(url)};`)
    .replace(/^let SUPABASE_ANON_KEY\s*=.*$/m, `let SUPABASE_ANON_KEY = ${JSON.stringify(key)};`);
  const c = vm.createContext({ atob: sandbox.atob, JSON, String, console });
  vm.runInContext(src, c);
  return vm.runInContext(
    '({url: SUPABASE_URL, key: SUPABASE_ANON_KEY, ok: SF_CONFIGURED, ' +
    'problem: SF_CONFIG_PROBLEM, fn: FUNCTIONS_URL})', c);
}

const GOOD = 'sb_publishable_AbCd1234';

eq('garis miring di ujung dibuang',
   loadConfig('https://abc.supabase.co/', GOOD).url, 'https://abc.supabase.co');
eq('garis miring berlipat dibuang',
   loadConfig('https://abc.supabase.co///', GOOD).url, 'https://abc.supabase.co');
eq('spasi di awal/akhir dibuang',
   loadConfig('  https://abc.supabase.co  ', GOOD).url, 'https://abc.supabase.co');
eq('path /rest/v1 dibuang',
   loadConfig('https://abc.supabase.co/rest/v1', GOOD).url, 'https://abc.supabase.co');
eq('URL benar dibiarkan',
   loadConfig('https://abc.supabase.co', GOOD).url, 'https://abc.supabase.co');
eq('spasi pada key dibuang',
   loadConfig('https://abc.supabase.co', '  ' + GOOD + '  ').key, GOOD);

eq('URL bersih -> tanpa keluhan',
   loadConfig('https://abc.supabase.co/', GOOD).problem, null);
eq('FUNCTIONS_URL ikut bersih',
   loadConfig('https://abc.supabase.co/', GOOD).fn, 'https://abc.functions.supabase.co');

ok('URL ngawur -> ada peringatan',
   !!loadConfig('abc.supabase.co', GOOD).problem);
ok('URL dengan path aneh -> ada peringatan',
   !!loadConfig('https://abc.supabase.co/dashboard', GOOD).problem);

ok('secret key ditolak dengan pesan jelas',
   /SECRET key/i.test(loadConfig('https://abc.supabase.co', 'sb_secret_rahasia').problem || ''));
ok('key tak dikenal diperingatkan',
   /tidak dikenali/i.test(loadConfig('https://abc.supabase.co', 'asal-asalan').problem || ''));

/* JWT service_role harus ditolak; JWT anon harus lolos */
const mkJwt = (role) => 'eyJhbGciOiJIUzI1NiJ9.' +
  Buffer.from(JSON.stringify({ role })).toString('base64').replace(/=+$/, '') + '.sig';
ok('JWT service_role ditolak',
   /service_role/i.test(loadConfig('https://abc.supabase.co', mkJwt('service_role')).problem || ''));
eq('JWT anon diterima',
   loadConfig('https://abc.supabase.co', mkJwt('anon')).problem, null);

eq('placeholder -> belum dikonfigurasi',
   loadConfig('https://GANTI-INI.supabase.co', 'GANTI-DENGAN-ANON-KEY-KAMU').ok, false);


/* ============================================================ */
section('[16] Akun aktif tapi toko belum dibuat (akibat konfirmasi email)');

const authSrc = fs.readFileSync(path.join(SRC, 'js/auth.js'), 'utf8');
const idxSrc  = fs.readFileSync(path.join(SRC, 'masuk.html'), 'utf8');

ok('loadProfile menandai needSetup, bukan error buntu',
   /needSetup:\s*true/.test(authSrc));
ok('sesi TIDAK dihapus saat hanya kurang toko',
   /if \(!p\.ok && !p\.needSetup\)\s*\{\s*wipe\(\)/.test(authSrc));
ok('ada completeSetup\(\) untuk melanjutkan', /completeSetup\(/.test(authSrc));
ok('completeSetup memanggil setup_owner',
   /completeSetup[\s\S]{0,400}setup_owner/.test(authSrc));

ok('isLogged menuntut business_id, bukan sekadar profil ada',
   /isLogged[^\n]*p\.business_id/.test(authSrc));
ok('ada needsSetup\(\)', /needsSetup:/.test(authSrc));

ok('halaman login punya layar vSetup', /id="vSetup"/.test(idxSrc));
ok('login mengarahkan ke vSetup saat needSetup',
   /r\.needSetup[\s\S]{0,200}showSetup\(\)/.test(idxSrc));
ok('sesi tertinggal dilanjutkan otomatis',
   /_resumeSetup[\s\S]{0,200}showSetup\(\)/.test(idxSrc));
ok('show\(\) ikut mengelola vSetup', /'vLogin',\s*'vSignup',\s*'vForgot',\s*'vSetup'/.test(idxSrc));

/* Simulasi perilaku isLogged pada tiga keadaan sesi */
function isLoggedSim(tok, prof) { return !!tok && !!prof && !!prof.business_id; }
function needsSetupSim(tok, prof) { return !!tok && (!prof || !prof.business_id); }

eq('belum login', isLoggedSim(null, null), false);
eq('profil hanya email -> belum dianggap login',
   isLoggedSim({ a: 1 }, { email: 'a@b.id' }), false);
eq('profil hanya email -> perlu setup',
   needsSetupSim({ a: 1 }, { email: 'a@b.id' }), true);
eq('profil lengkap -> sudah login',
   isLoggedSim({ a: 1 }, { email: 'a@b.id', business_id: 'biz1' }), true);
eq('profil lengkap -> tidak perlu setup',
   needsSetupSim({ a: 1 }, { email: 'a@b.id', business_id: 'biz1' }), false);


/* ============================================================ */
section('[17] Kredensial pembayaran per toko');

const sqlSrc  = fs.readFileSync(path.join(SRC, 'schema.sql'), 'utf8');
const libSrc2 = fs.readFileSync(path.join(SRC, 'supabase/functions/_shared/lib.ts'), 'utf8');
const pcSrc   = fs.readFileSync(path.join(SRC, 'supabase/functions/payment-create/index.ts'), 'utf8');
const whSrc2  = fs.readFileSync(path.join(SRC, 'supabase/functions/payment-webhook/index.ts'), 'utf8');
const setSrc  = fs.readFileSync(path.join(SRC, 'settings.html'), 'utf8');

ok('tabel payment_credentials ada', /create table payment_credentials/i.test(sqlSrc));
ok('RLS aktif di payment_credentials',
   /alter table payment_credentials\s+enable row level security/i.test(sqlSrc));
ok('owner boleh menulis kredensial',
   /create policy pc_insert on payment_credentials for insert/i.test(sqlSrc));
/* Inti keamanannya: TIDAK ADA policy SELECT, jadi key tidak bisa dibaca klien */
ok('TIDAK ada policy SELECT di payment_credentials',
   !/create policy[^;]*on payment_credentials for (select|all)/i.test(sqlSrc));
ok('status kredensial lewat fungsi terpisah',
   /function payment_credential_status\(\)/i.test(sqlSrc));
ok('status hanya mengembalikan key_hint, bukan key',
   /payment_credential_status[\s\S]{0,600}key_hint/i.test(sqlSrc) &&
   !/payment_credential_status[\s\S]{0,600}'server_key'/i.test(sqlSrc));

ok('credsFor() membaca key milik toko', /export async function credsFor/.test(libSrc2));
ok('fallback ke env bila toko belum pasang', /return envCreds\(\);/.test(libSrc2));
ok('payment-create memakai kredensial toko', /credsFor\(caller\.businessId\)/.test(pcSrc));
ok('webhook memverifikasi dengan key toko yang bertransaksi',
   /credsForGatewayOrder\(orderId\)/.test(whSrc2));
ok('signature menerima serverKey sebagai argumen',
   /midtransSignature\(\s*orderId,\s*statusCode,\s*grossAmount,\s*creds\.serverKey\s*\)/.test(whSrc2));

ok('Pengaturan tidak pernah menampilkan server_key',
   !/server_key[^:]*:\s*(cred|c)\./.test(setSrc));
ok('Pengaturan menolak Client Key', /Client Key/.test(setSrc));

/* ============================================================ */
section('[18] Hak data pengguna (UU PDP)');

ok('fungsi export_my_data ada', /function export_my_data\(\)/i.test(sqlSrc));

/* Ambil badan fungsinya secara utuh agar tidak bergantung lebar jendela tebakan */
const exportBody = (function () {
  const i = sqlSrc.indexOf('function export_my_data');
  if (i < 0) return '';
  const j = sqlSrc.indexOf('grant execute on function export_my_data', i);
  return sqlSrc.slice(i, j < 0 ? sqlSrc.length : j);
})();

ok('badan export_my_data terbaca', exportBody.length > 200, 'panjang=' + exportBody.length);
ok('export tidak menyertakan kredensial pembayaran',
   !/payment_credentials/i.test(exportBody));
ok('export tidak membocorkan server_key', !/server_key/i.test(exportBody));
ok('export menyembunyikan expenses dari staff', /app_is_owner\(\)/i.test(exportBody));
ok('export mencakup produk dan transaksi',
   /'products'/.test(exportBody) && /'orders'/.test(exportBody));
ok('fungsi delete_my_business ada', /function delete_my_business\(\)/i.test(sqlSrc));
ok('hapus toko hanya untuk owner',
   /delete_my_business[\s\S]{0,500}app_is_owner\(\)/i.test(sqlSrc));

const delSrc = fs.readFileSync(path.join(SRC, 'supabase/functions/delete-account/index.ts'), 'utf8');
ok('delete-account menuntut konfirmasi', /confirm[\s\S]{0,80}'HAPUS'/.test(delSrc));
ok('delete-account hanya owner', /role !== 'owner'/.test(delSrc));
ok('delete-account menghapus akun Auth', /authAdmin\(`\/users\//.test(delSrc));

ok('Pengaturan punya tombol unduh data', /exportData\(\)/.test(setSrc));
ok('Pengaturan punya hapus akun', /doDelete\(\)/.test(setSrc));
ok('tombol hapus terkunci sampai mengetik HAPUS', /delBtn'\)\.disabled\s*=/.test(setSrc));

/* ============================================================ */
section('[19] Halaman publik & legal');

const files = ['index.html', 'masuk.html', 'privasi.html', 'ketentuan.html'];
files.forEach((f) => ok(f + ' ada', fs.existsSync(path.join(SRC, f))));

const land = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
ok('landing menaut ke masuk.html', /href="masuk\.html/.test(land));
ok('landing menaut ke privasi', /href="privasi\.html"/.test(land));
ok('landing menaut ke ketentuan', /href="ketentuan\.html"/.test(land));
ok('landing punya deskripsi meta', /name="description"/.test(land));
ok('landing memakai css halaman depan', /css\/landing\.css/.test(land));
ok('landing punya satu h1', (land.match(/<h1/g) || []).length === 1,
   'jumlah h1=' + (land.match(/<h1/g) || []).length);
ok('landing punya demo yang bisa diklik', /dBtns/.test(land));
ok('landing menghormati prefers-reduced-motion', /prefers-reduced-motion/.test(land));
ok('landing tidak memuat skrip autentikasi', !/js\/auth\.js/.test(land));

const priv = fs.readFileSync(path.join(SRC, 'privasi.html'), 'utf8');
ok('privasi menyebut UU PDP', /27 Tahun 2022|UU PDP/.test(priv));
ok('privasi menjelaskan hak menghapus', /Hapus Akun|menghapus data/i.test(priv));
ok('privasi menyebut pihak ketiga', /Supabase[\s\S]{0,400}Midtrans/.test(priv));

const term = fs.readFileSync(path.join(SRC, 'ketentuan.html'), 'utf8');
ok('ketentuan menegaskan dana tidak lewat kami',
   /tidak menerima, menyimpan, atau menyalurkan dana/i.test(term));
ok('ketentuan menjelaskan void bukan refund', /[Vv]oid tidak mengembalikan dana/.test(term));

/* Halaman yang butuh login harus diarahkan ke masuk.html */
['pos', 'orders', 'products', 'inventory', 'damaged', 'reports', 'users', 'settings']
  .forEach((p) => {
    const src = fs.readFileSync(path.join(SRC, p + '.html'), 'utf8');
    ok(p + '.html memakai Auth.guard', /Auth\.guard\(/.test(src));
  });
ok('guard mengarah ke masuk.html', /location\.replace\('masuk\.html'\)/.test(authSrc));

/* ============================================================ */
section('[20] Ikon: tidak ada emoji tersisa');

const pages = fs.readdirSync(SRC).filter((f) => f.endsWith('.html'));
const emojiPages = pages.filter((f) => {
  const s = fs.readFileSync(path.join(SRC, f), 'utf8');
  return /&#1[0-9]{4,};/.test(s) || /[\u{1F300}-\u{1FAFF}]/u.test(s);
});
ok('tidak ada emoji di halaman mana pun', emojiPages.length === 0, emojiPages.join(', '));

ok('Icons.svg menghasilkan SVG', /^<svg /.test(Icons.svg('pos', 20)));
ok('Icons.svg mewarisi currentColor', /stroke="currentColor"/.test(Icons.svg('box', 20)));
ok('ikon tidak dikenal -> string kosong', Icons.svg('tidak-ada', 20) === '');
ok('logo menghasilkan SVG', /^<svg /.test(Icons.logo(32)));

/* Setiap ikon yang dipakai menu benar-benar ada */
const menuIcons = ['pos','receipt','box','refresh','alert','chart','users','settings','menu'];
const missing = menuIcons.filter((n) => !Icons.has(n));
ok('semua ikon menu tersedia', missing.length === 0, missing.join(', '));

/* Placeholder data-ico di HTML harus merujuk ikon yang ada */
const badIco = [];
pages.forEach((f) => {
  const s = fs.readFileSync(path.join(SRC, f), 'utf8');
  (s.match(/data-ico="([a-zA-Z]+)"/g) || []).forEach((m) => {
    const n = m.match(/data-ico="([a-zA-Z]+)"/)[1];
    if (!Icons.has(n)) badIco.push(f + ':' + n);
  });
});
ok('semua data-ico merujuk ikon yang ada', badIco.length === 0, badIco.join(', '));

/* Ikon yang dipanggil lewat UI.ic('nama') juga harus ada */
const badCall = [];
pages.concat(['js/ui.js']).forEach((f) => {
  const s = fs.readFileSync(path.join(SRC, f), 'utf8');
  (s.match(/UI\.ic\('([a-zA-Z]+)'/g) || []).forEach((m) => {
    const n = m.match(/UI\.ic\('([a-zA-Z]+)'/)[1];
    if (!Icons.has(n)) badCall.push(f + ':' + n);
  });
  (s.match(/Icons\.svg\('([a-zA-Z]+)'/g) || []).forEach((m) => {
    const n = m.match(/Icons\.svg\('([a-zA-Z]+)'/)[1];
    if (!Icons.has(n)) badCall.push(f + ':' + n);
  });
});
ok('semua UI.ic/Icons.svg merujuk ikon yang ada', badCall.length === 0, badCall.join(', '));


/* ============================================================ */
section('[21] Printer struk: ESC/POS 58mm');

/* Render ulang byte ESC/POS jadi teks agar bisa diperiksa */
function renderEscPos(bytes) {
  let out = '', i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === 0x1B || b === 0x1D) {
      const n = bytes[i + 1];
      i += (n === 0x21 || n === 0x61 || n === 0x45 || n === 0x64) ? 3 : (n === 0x56 ? 4 : 2);
      continue;
    }
    if (b === 0x0A) { out += '\n'; i++; continue; }
    out += String.fromCharCode(b); i++;
  }
  return out;
}

const ORD = {
  order_no: 'INV-20261104-0001', created_at: '2026-11-04T03:30:00Z',
  cashier_name: 'Jason', customer_name: 'Umum',
  subtotal: 61000, discount: 3000, tax: 0, total: 58000,
  paid_amount: 100000, change_amount: 42000, payment_method: 'cash', status: 'paid',
};
const ITEMS = [
  { name: 'Kopi Susu Gula Aren', price: 18000, qty: 2 },
  { name: 'Nasi Goreng Spesial Pedas Level 5', price: 25000, qty: 1 },
];
const BIZ = {
  name: 'Toko Jasson', address: 'Jl. Contoh No. 1, Jakarta Selatan',
  phone: '081234567890', receipt_note: 'Terima kasih atas kunjungan Anda',
};

const receipt = Printer.buildReceipt(ORD, ITEMS, BIZ);
const txt = renderEscPos(receipt);
const lines = txt.split('\n');

eq('lebar kertas 32 kolom', Printer.COLS, 32);
ok('struk menghasilkan byte', receipt.length > 100, 'byte=' + receipt.length);
ok('diawali perintah init ESC @', receipt[0] === 0x1B && receipt[1] === 0x40);

/* Yang paling penting: tidak ada baris melebihi lebar kertas */
const tooLong = lines.filter((l) => l.length > 32);
ok('tidak ada baris lebih dari 32 kolom', tooLong.length === 0,
   tooLong.slice(0, 2).join(' | '));

ok('nama toko tercetak', txt.includes('Toko Jasson'));
ok('nomor invoice tercetak', txt.includes('INV-20261104-0001'));
ok('nama kasir tercetak', txt.includes('Jason'));
ok('semua item tercetak',
   txt.includes('Kopi Susu Gula Aren') && txt.includes('Nasi Goreng Spesial'));
ok('total tercetak', /TOTAL\s+Rp 58\.000/.test(txt), txt.match(/TOTAL.*/) || '');
ok('diskon tercetak dengan tanda minus', /-Rp 3\.000/.test(txt));
ok('kembalian tercetak', /Kembali\s+Rp 42\.000/.test(txt));
ok('catatan struk tercetak', txt.includes('Terima kasih'));

/* Nama panjang harus dipotong, bukan meluber */
ok('nama produk panjang dibungkus ke baris berikutnya',
   lines.some((l) => l.trim() === '5') || lines.some((l) => l.includes('Pedas Level')));

/* pair(): kiri-kanan harus rata di kolom 32 */
const pairLine = lines.find((l) => l.startsWith('Subtotal'));
eq('baris subtotal pas 32 kolom', pairLine.length, 32);
ok('nilai rata kanan', pairLine.endsWith('Rp 61.000'), pairLine);

/* Transaksi void diberi tanda */
const voidTxt = renderEscPos(Printer.buildReceipt(
  Object.assign({}, ORD, { status: 'void' }), ITEMS, BIZ));
ok('status void ditandai di struk', /\*\* VOID \*\*/.test(voidTxt));

/* QRIS tanpa kembalian tidak mencetak baris kembalian */
const qrisTxt = renderEscPos(Printer.buildReceipt(
  Object.assign({}, ORD, { payment_method: 'qris', paid_amount: 58000, change_amount: 0 }),
  ITEMS, BIZ));
ok('metode QRIS tercetak', /QRIS\s+Rp 58\.000/.test(qrisTxt));
ok('tanpa kembalian, baris Kembali tidak dicetak', !/Kembali/.test(qrisTxt));

/* Toko tanpa alamat/telepon tetap aman */
const minimal = renderEscPos(Printer.buildReceipt(ORD, ITEMS, { name: 'Warung' }));
ok('struk tanpa alamat tetap terbentuk', minimal.includes('Warung') && minimal.includes('TOTAL'));

/* Karakter non-ASCII dibersihkan agar tidak jadi sampah di printer */
eq('tanda kutip melengkung diluruskan', Printer.toAscii('\u2018a\u2019'), "'a'");
eq('em dash jadi tanda hubung', Printer.toAscii('a\u2014b'), 'a-b');
eq('emoji dibuang', Printer.toAscii('Kopi \u2615 Susu'), 'Kopi  Susu');
eq('karakter normal tidak diubah', Printer.toAscii('Rp 18.000 (2x)'), 'Rp 18.000 (2x)');

/* Builder: pemenggalan baris */
const wrapTest = renderEscPos(new Printer.Builder()
  .wrap('Satu dua tiga empat lima enam tujuh delapan sembilan sepuluh').bytes());
ok('wrap memotong sesuai lebar',
   wrapTest.split('\n').filter(Boolean).every((l) => l.length <= 32),
   wrapTest.split('\n').filter((l) => l.length > 32).join('|'));

/* pair() dengan teks sangat panjang tidak boleh meluber */
const longPair = renderEscPos(new Printer.Builder()
  .pair('Nama Produk Yang Sangat Panjang Sekali', 'Rp 1.000.000').bytes());
ok('pair terlalu panjang dipecah dua baris',
   longPair.split('\n').filter(Boolean).every((l) => l.length <= 32),
   longPair.replace(/\n/g, ' / '));

/* ============================================================ */
section('[22] Printer: deteksi dukungan lingkungan');

const sup = Printer.support();
ok('support() mengembalikan ok & reason', typeof sup.ok === 'boolean');
ok('tanpa navigator.bluetooth -> tidak didukung', !sup.ok);
ok('alasannya dijelaskan', !!sup.reason && sup.reason.length > 20, sup.reason);
ok('alasan menyebut Chrome atau Edge', /Chrome|Edge/.test(sup.reason), sup.reason);

ok('belum terhubung di awal', !Printer.connected());
eq('info() melaporkan belum terhubung', Printer.info().connected, false);

const prnSrc = fs.readFileSync(path.join(SRC, 'js/printer.js'), 'utf8');
ok('iPhone/iPad ditangani khusus', /iPad\|iPhone\|iPod/.test(prnSrc));
ok('HTTPS diperiksa', /isSecureContext/.test(prnSrc));
ok('beberapa UUID service dicoba', (prnSrc.match(/-0000-1000-8000-00805f9b34fb/g) || []).length >= 4);
ok('data dikirim per potongan', /i \+= mtu/.test(prnSrc));
ok('ada jeda antar potongan', /sleep\(/.test(prnSrc));
ok('menangani printer SPP yang tak terjangkau',
   /Bluetooth Classic \(SPP\)/.test(prnSrc));

/* UI terkait printer */
const setSrc2 = fs.readFileSync(path.join(SRC, 'settings.html'), 'utf8');
ok('Pengaturan punya kartu printer', /Printer Struk Bluetooth/.test(setSrc2));
ok('Pengaturan punya tes cetak', /prnTest\(\)/.test(setSrc2));
ok('Pengaturan punya saklar cetak otomatis', /prnToggleAuto\(\)/.test(setSrc2));
ok('Pengaturan memuat printer.js', /js\/printer\.js/.test(setSrc2));

const posSrc2 = fs.readFileSync(path.join(SRC, 'pos.html'), 'utf8');
ok('kasir memuat printer.js', /js\/printer\.js/.test(posSrc2));
ok('kasir punya tombol cetak Bluetooth', /btPrint\(\)/.test(posSrc2));
ok('kasir punya cetak otomatis', /autoPrint\(/.test(posSrc2));
ok('dialog print browser tetap tersedia', /window\.print\(\)/.test(posSrc2));

const ordSrc2 = fs.readFileSync(path.join(SRC, 'orders.html'), 'utf8');
ok('riwayat bisa cetak ulang', /btReprint\(\)/.test(ordSrc2));

/* Sesi menyimpan alamat & telepon untuk kop struk */
ok('sesi menyimpan alamat toko', /business_address/.test(authSrc));
ok('sesi menyimpan telepon toko', /business_phone/.test(authSrc));

/* ============================================================ */
const head = fail ? ('GAGAL — ' + pass + ' lulus, ' + fail + ' gagal')
                  : ('SEMUA LULUS — ' + pass + ' tes');
console.log('\n' + '='.repeat(56));
console.log(head);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);

})().catch((e) => { console.error('\nCRASH:', e); process.exit(1); });
