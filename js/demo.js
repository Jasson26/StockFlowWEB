/* ============================================================
   STOCKFLOW v5 — Mode Demo
   Aktif bila URL mengandung ?demo=1 (tersimpan di localStorage).
   Semua data hanya di browser. Pembayaran QRIS disimulasikan —
   tidak ada uang sungguhan dan tidak menyentuh Midtrans.
   Matikan dengan ?demo=0
   ============================================================ */

const Demo = (function () {
  const FLAG = 'sf5_demo';
  const DATA = 'sf5_demo_data';

  try {
    const q = new URLSearchParams(location.search).get('demo');
    if (q === '1') localStorage.setItem(FLAG, '1');
    if (q === '0') {
      localStorage.removeItem(FLAG);
      localStorage.removeItem(DATA);
      localStorage.removeItem('sf5_token');
      localStorage.removeItem('sf5_profile');
    }
  } catch (e) {}

  const on = () => { try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; } };

  const uid = () => 'd' + Math.random().toString(36).slice(2, 10);
  const BIZ = 'demo-biz';

  /* Kredensial demo, hanya berlaku di dalam browser ini */
  const CRED = { email: 'demo@stockflow.id', password: 'demo1234' };
  const CRED_STAFF = { email: 'kasir@stockflow.id', password: 'demo1234' };

  function seed() {
    const p = (id, cid, name, price, cost, stock, min) => ({
      id, business_id: BIZ, category_id: cid, name,
      sku: id.toUpperCase(), barcode: '899' + id.slice(1).padStart(10, '0'),
      unit: 'pcs', price, cost, stock, min_stock: min,
      image_url: null, active: true, created_at: new Date().toISOString(),
    });

    return {
      businesses: [{
        id: BIZ, name: 'Toko Demo StockFlow', address: 'Jl. Contoh No. 1, Jakarta',
        phone: '081234567890', qris_static_url: null, tax_percent: 0, currency: 'IDR',
        receipt_note: 'Terima kasih atas kunjungan Anda',
        qris_enabled: true, created_at: new Date().toISOString(),
      }],
      /* _pw hanya ada di mode demo; skema asli tidak punya kolom password */
      profiles: [
        { id: 'u1', business_id: BIZ, name: 'Pemilik Demo', role: 'owner', active: true,
          _email: CRED.email, _pw: CRED.password, created_at: new Date().toISOString() },
        { id: 'u2', business_id: BIZ, name: 'Kasir Demo', role: 'staff', active: true,
          _email: CRED_STAFF.email, _pw: CRED_STAFF.password, created_at: new Date().toISOString() },
      ],
      categories: [
        { id: 'c1', business_id: BIZ, name: 'Minuman', sort_order: 1 },
        { id: 'c2', business_id: BIZ, name: 'Makanan', sort_order: 2 },
        { id: 'c3', business_id: BIZ, name: 'Snack',   sort_order: 3 },
      ],
      products: [
        p('p1', 'c1', 'Kopi Susu Gula Aren', 18000, 9000, 40, 10),
        p('p2', 'c1', 'Es Teh Manis',         6000, 2000, 80, 20),
        p('p3', 'c1', 'Americano',           15000, 7000, 35, 10),
        p('p4', 'c1', 'Air Mineral 600ml',    4000, 2200,  8, 12),
        p('p5', 'c2', 'Nasi Goreng Spesial', 25000, 13000, 25, 5),
        p('p6', 'c2', 'Mie Goreng',          20000, 10000, 30, 5),
        p('p7', 'c2', 'Ayam Geprek',         22000, 12000, 18, 5),
        p('p8', 'c3', 'Kentang Goreng',      15000,  6500, 22, 8),
        p('p9', 'c3', 'Roti Bakar',          12000,  5000,  0, 5),
        p('p10','c3', 'Pisang Goreng',       10000,  4000, 14, 6),
      ],
      stock_movements: [], orders: [], order_items: [], expenses: [], payments: [],
      payment_credentials: [],
      _session: null,
    };
  }

  function db() {
    try { const raw = localStorage.getItem(DATA); if (raw) return JSON.parse(raw); } catch (e) {}
    const d = seed(); save(d); return d;
  }
  function save(d) { try { localStorage.setItem(DATA, JSON.stringify(d)); } catch (e) {} }

  const me = () => { const d = db(); return d.profiles.find((p) => p.id === (d._session || 'u1')); };

  /* ---------- Filter gaya PostgREST ---------- */
  function applyFilters(rows, filters) {
    return rows.filter((r) =>
      filters.every(([col, expr]) => {
        if (col === 'or') return true;
        const i = expr.indexOf('.');
        const op = expr.slice(0, i);
        const v  = expr.slice(i + 1);
        const rv = r[col];
        if (op === 'eq')  return String(rv) === v || (v === 'true' && rv === true) || (v === 'false' && rv === false);
        if (op === 'neq') return String(rv) !== v;
        if (op === 'gte') return new Date(rv) >= new Date(v) || Number(rv) >= Number(v);
        if (op === 'lte') return new Date(rv) <= new Date(v) || Number(rv) <= Number(v);
        if (op === 'lt')  return new Date(rv) <  new Date(v) || Number(rv) <  Number(v);
        if (op === 'ilike') return String(rv || '').toLowerCase().includes(v.replace(/%/g, '').toLowerCase());
        if (op === 'is')  return v === 'null' ? rv == null : rv === (v === 'true');
        if (op === 'in') {
          const set = v.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
          return set.includes(String(rv));
        }
        return true;
      })
    );
  }

  /* ---------- Query ---------- */
  function query(q, mode) {
    const d = db();
    const t = q.t;
    if (!d[t]) d[t] = [];

    /* Tiru RLS: profil hanya milik toko sendiri; tanpa filter id -> diri sendiri */
    let base = d[t];
    if (t === 'profiles' && q.m === 'GET' && !q.f.length) base = [me()];

    if (q.m === 'GET') {
      let rows = applyFilters(base, q.f);
      if (q.ord) {
        const [c, dir] = q.ord.split('.');
        rows = rows.slice().sort((a, b) => {
          const x = a[c], y = b[c];
          const n = x == null ? -1 : y == null ? 1 : x > y ? 1 : x < y ? -1 : 0;
          return dir === 'desc' ? -n : n;
        });
      }
      if (q.lim) rows = rows.slice(0, Number(q.lim));
      if (mode === 'single') return rows.length
        ? { data: rows[0], error: null }
        : { data: null, error: { message: 'Data tidak ditemukan' } };
      if (mode === 'maybe') return { data: rows.length ? rows[0] : null, error: null };
      return { data: rows, error: null };
    }

    if (q.m === 'POST') {
      const made = q.body.map((b) => {
        const row = Object.assign({ id: uid(), created_at: new Date().toISOString() }, b);
        d[t].push(row); return row;
      });
      save(d);
      return mode === 'single' ? { data: made[0], error: null } : { data: made, error: null };
    }

    if (q.m === 'PATCH') {
      const hit = applyFilters(d[t], q.f);
      hit.forEach((r) => Object.assign(r, q.body));
      save(d);
      return { data: hit, error: null };
    }

    if (q.m === 'DELETE') {
      const hit  = applyFilters(d[t], q.f);
      const kill = new Set(hit.map((r) => r.id));
      d[t] = d[t].filter((r) => !kill.has(r.id));
      save(d);
      return { data: null, error: null };
    }

    return { data: [], error: null };
  }

  /* ---------- Login ---------- */
  function login(email, password) {
    const d = db();
    const u = d.profiles.find((p) => p._email === String(email).trim().toLowerCase());
    if (!u)                 return { ok: false, msg: 'Email atau password salah' };
    if (u._pw !== password) return { ok: false, msg: 'Email atau password salah' };
    if (!u.active)          return { ok: false, msg: 'Akun Anda dinonaktifkan. Hubungi owner.' };

    d._session = u.id; save(d);

    const biz = d.businesses[0];
    try {
      localStorage.setItem('sf5_token', JSON.stringify({
        access_token: 'demo', refresh_token: 'demo', expires_at: Date.now() + 86400e3,
      }));
      localStorage.setItem('sf5_profile', JSON.stringify({
        id: u.id, name: u.name, role: u.role, email: u._email,
        business_id: BIZ, business_name: biz.name,
        business_address: biz.address, business_phone: biz.phone,
        tax_percent: Number(biz.tax_percent || 0),
        qris_enabled: !!biz.qris_enabled,
        qris_static_url: biz.qris_static_url,
        receipt_note: biz.receipt_note,
      }));
    } catch (e) {}
    return { ok: true };
  }

  /* ---------- Nomor invoice ---------- */
  function nextNo(d) {
    const today = new Date().toISOString().slice(0, 10);
    const n = d.orders.filter((o) => (o.created_at || '').slice(0, 10) === today).length + 1;
    return 'INV-' + today.replace(/-/g, '') + '-' + String(n).padStart(4, '0');
  }

  function totals(items, disc, tax) {
    let sub = 0, cost = 0;
    items.forEach((i) => { sub += i.price * i.qty; cost += (i.cost || 0) * i.qty; });
    disc = Math.min(Math.max(disc || 0, 0), sub);
    tax  = Math.max(tax || 0, 0);
    return { sub, cost, disc, tax, total: sub - disc + tax };
  }

  /* ---------- RPC ---------- */
  function rpc(fn, a) {
    const d = db();
    const u = me();

    if (fn === 'checkout_cash') {
      const t = totals(a.p_items, a.p_discount, a.p_tax);
      const paid = a.p_paid == null ? t.total : a.p_paid;

      for (const i of a.p_items) {
        const p = d.products.find((x) => x.id === i.product_id);
        if (!p) return { data: null, error: { message: 'Produk tidak ditemukan di toko ini' } };
        if (Number(p.stock) < i.qty) {
          return { data: null, error: { message: 'Stok ' + i.name + ' tidak cukup (tersedia ' + p.stock + ')' } };
        }
      }
      if (paid < t.total) return { data: null, error: { message: 'Uang diterima kurang dari total' } };

      const no = nextNo(d);
      const order = {
        id: uid(), business_id: BIZ, order_no: no, user_id: u.id, cashier_name: u.name,
        customer_name: a.p_customer || 'Umum', subtotal: t.sub, discount: t.disc, tax: t.tax,
        total: t.total, cost_total: t.cost, payment_method: a.p_method || 'cash',
        paid_amount: paid, change_amount: paid - t.total, status: 'paid',
        settled_at: new Date().toISOString(), created_at: new Date().toISOString(),
      };
      d.orders.push(order);

      a.p_items.forEach((i) => {
        d.order_items.push({
          id: uid(), order_id: order.id, product_id: i.product_id, name: i.name,
          price: i.price, cost: i.cost || 0, qty: i.qty, subtotal: i.price * i.qty,
        });
        const p = d.products.find((x) => x.id === i.product_id);
        if (p) p.stock = Number(p.stock) - Number(i.qty);
        d.stock_movements.push({
          id: uid(), business_id: BIZ, product_id: i.product_id, type: 'sale',
          qty: i.qty, note: 'Penjualan ' + no, user_id: u.id,
          created_at: new Date().toISOString(),
        });
      });

      save(d);
      return { data: {
        id: order.id, order_no: no, subtotal: t.sub, discount: t.disc, tax: t.tax,
        total: t.total, paid_amount: paid, change_amount: paid - t.total, status: 'paid',
      }, error: null };
    }

    if (fn === 'order_create_pending') {
      const t = totals(a.p_items, a.p_discount, a.p_tax);

      for (const i of a.p_items) {
        const p = d.products.find((x) => x.id === i.product_id);
        if (!p) return { data: null, error: { message: 'Produk tidak ditemukan di toko ini' } };
        if (Number(p.stock) < i.qty) {
          return { data: null, error: { message: 'Stok ' + i.name + ' tidak cukup (tersedia ' + p.stock + ')' } };
        }
      }
      if (t.total < 1) return { data: null, error: { message: 'Total minimal Rp 1 untuk pembayaran QRIS' } };

      const no = nextNo(d);
      const order = {
        id: uid(), business_id: BIZ, order_no: no, user_id: u.id, cashier_name: u.name,
        customer_name: a.p_customer || 'Umum', subtotal: t.sub, discount: t.disc, tax: t.tax,
        total: t.total, cost_total: t.cost, payment_method: 'qris',
        paid_amount: 0, change_amount: 0, status: 'pending',
        created_at: new Date().toISOString(),
      };
      d.orders.push(order);

      a.p_items.forEach((i) => d.order_items.push({
        id: uid(), order_id: order.id, product_id: i.product_id, name: i.name,
        price: i.price, cost: i.cost || 0, qty: i.qty, subtotal: i.price * i.qty,
      }));

      save(d);
      return { data: {
        id: order.id, order_no: no, business_id: BIZ,
        subtotal: t.sub, discount: t.disc, tax: t.tax, total: t.total,
      }, error: null };
    }

    if (fn === 'order_cancel_pending') {
      const o = d.orders.find((x) => x.id === a.p_order_id);
      if (!o) return { data: null, error: { message: 'Order tidak ditemukan' } };
      if (o.status !== 'pending') return { data: null, error: { message: 'Order sudah ' + o.status } };
      o.status = 'failed';
      d.payments.filter((p) => p.order_id === o.id && p.status === 'pending')
        .forEach((p) => { p.status = 'cancelled'; });
      save(d);
      return { data: { ok: true }, error: null };
    }

    if (fn === 'void_order') {
      if (u.role !== 'owner') return { data: null, error: { message: 'Hanya owner yang boleh void' } };
      const o = d.orders.find((x) => x.id === a.p_order_id);
      if (!o) return { data: null, error: { message: 'Order tidak ditemukan' } };
      if (o.status !== 'paid') return { data: null, error: { message: 'Hanya order lunas yang bisa divoid' } };

      d.order_items.filter((i) => i.order_id === o.id).forEach((i) => {
        const p = d.products.find((x) => x.id === i.product_id);
        if (p) p.stock = Number(p.stock) + Number(i.qty);
        d.stock_movements.push({
          id: uid(), business_id: BIZ, product_id: i.product_id, type: 'in',
          qty: i.qty, note: 'Void transaksi', user_id: u.id,
          created_at: new Date().toISOString(),
        });
      });
      o.status = 'void';
      save(d);
      return { data: { ok: true }, error: null };
    }

    if (fn === 'setup_owner') {
      return { data: null, error: { message: 'Pendaftaran tidak tersedia di mode demo' } };
    }

    if (fn === 'payment_credential_status') {
      const c = (d.payment_credentials || [])[0];
      return {
        data: c
          ? { configured: true, provider: c.provider, is_production: c.is_production,
              key_hint: c.key_hint, updated_at: c.updated_at }
          : { configured: false },
        error: null,
      };
    }

    if (fn === 'export_my_data') {
      return {
        data: {
          exported_at: new Date().toISOString(),
          business: d.businesses[0],
          users: d.profiles.map((p) => ({
            name: p.name, role: p.role, active: p.active, created_at: p.created_at })),
          categories: d.categories,
          products: d.products,
          orders: d.orders,
          order_items: d.order_items,
          stock_movements: d.stock_movements,
          expenses: u.role === 'owner' ? d.expenses : [],
        },
        error: null,
      };
    }

    if (fn === 'delete_my_business') {
      if (u.role !== 'owner') {
        return { data: null, error: { message: 'Hanya owner yang boleh menghapus toko' } };
      }
      return { data: { ok: true, user_ids: d.profiles.map((p) => p.id) }, error: null };
    }

    return { data: null, error: { message: 'Fungsi demo tidak dikenal: ' + fn } };
  }

  /* ---------- Edge Function (disimulasikan) ---------- */

  /* QR palsu: SVG yang jelas bertanda DEMO, bukan kode QRIS sungguhan */
  function fakeQr(text) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">' +
      '<rect width="300" height="300" fill="#fff"/>' +
      /* pola kotak-kotak dekoratif */
      Array.from({ length: 144 }, (_, i) => {
        const x = i % 12, y = Math.floor(i / 12);
        /* pseudo-random stabil dari teks */
        const h = (text.charCodeAt(i % text.length) * (i + 7)) % 100;
        return h > 45
          ? '<rect x="' + (30 + x * 20) + '" y="' + (30 + y * 20) + '" width="18" height="18" fill="#14162B"/>'
          : '';
      }).join('') +
      /* tiga penanda sudut seperti QR asli */
      ['30,30', '210,30', '30,210'].map((c) => {
        const [x, y] = c.split(',');
        return '<rect x="' + x + '" y="' + y + '" width="58" height="58" fill="#fff"/>' +
               '<rect x="' + x + '" y="' + y + '" width="58" height="58" fill="none" stroke="#14162B" stroke-width="8"/>' +
               '<rect x="' + (+x + 20) + '" y="' + (+y + 20) + '" width="18" height="18" fill="#14162B"/>';
      }).join('') +
      '<rect x="80" y="130" width="140" height="40" rx="8" fill="#F59E0B"/>' +
      '<text x="150" y="157" font-family="sans-serif" font-size="19" font-weight="bold" ' +
      'fill="#201500" text-anchor="middle">DEMO QR</text>' +
      '</svg>';
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  }

  function invoke(name, b) {
    const d = db();

    if (name === 'payment-create') {
      const o = d.orders.find((x) => x.id === b.order_id);
      if (!o) return { data: null, error: { message: 'Order tidak ditemukan' } };
      if (o.status !== 'pending') {
        return { data: null, error: { message: 'Order sudah berstatus ' + o.status } };
      }

      const attempt = d.payments.filter((p) => p.order_id === o.id).length + 1;
      const gid = attempt === 1 ? o.order_no : o.order_no + '-R' + attempt;
      const expires = new Date(Date.now() + 15 * 60000).toISOString();

      d.payments.push({
        id: uid(), business_id: BIZ, order_id: o.id, gateway: 'demo',
        gateway_order_id: gid, gateway_txn_id: 'demo-' + uid(), method: 'qris',
        acquirer: 'gopay', amount: o.total, status: 'pending',
        qr_url: fakeQr(gid), expires_at: expires,
        created_at: new Date().toISOString(),
        /* Di demo, pembayaran "masuk" otomatis setelah 6 detik */
        _autoPaidAt: Date.now() + 6000,
      });
      save(d);

      return { data: {
        qr_url: fakeQr(gid), gateway_order_id: gid, expires_at: expires,
        amount: o.total, order_no: o.order_no, attempt: attempt, demo: true,
      }, error: null };
    }

    if (name === 'payment-status') {
      const pay = d.payments.find((p) => p.gateway_order_id === b.gateway_order_id);
      if (!pay) return { data: null, error: { message: 'Pembayaran tidak ditemukan' } };
      if (pay.status !== 'pending') return { data: { status: pay.status, final: true }, error: null };

      /* Simulasi: dianggap lunas setelah tenggat auto */
      if (Date.now() < (pay._autoPaidAt || 0)) {
        return { data: { status: 'pending' }, error: null };
      }

      pay.status = 'paid';
      pay.paid_at = new Date().toISOString();
      pay.issuer = 'gopay';

      const o = d.orders.find((x) => x.id === pay.order_id);
      if (o && o.status === 'pending') {
        o.status = 'paid';
        o.paid_amount = o.total;
        o.settled_at = new Date().toISOString();
        o.ref_note = 'gopay';

        d.order_items.filter((i) => i.order_id === o.id).forEach((i) => {
          const p = d.products.find((x) => x.id === i.product_id);
          if (p) p.stock = Number(p.stock) - Number(i.qty);
          d.stock_movements.push({
            id: uid(), business_id: BIZ, product_id: i.product_id, type: 'sale',
            qty: i.qty, note: 'Penjualan ' + o.order_no, user_id: o.user_id,
            created_at: new Date().toISOString(),
          });
        });
      }
      save(d);
      return { data: { status: 'paid', issuer: 'gopay' }, error: null };
    }

    if (name === 'create-staff') {
      const u = me();
      if (u.role !== 'owner') {
        return { data: null, error: { message: 'Hanya owner yang boleh mengelola pengguna' } };
      }

      if (b.action === 'create') {
        const email = String(b.email || '').trim().toLowerCase();
        if (d.profiles.some((p) => p._email === email)) {
          return { data: null, error: { message: 'Email sudah terdaftar' } };
        }
        if (String(b.password || '').length < 8) {
          return { data: null, error: { message: 'Password minimal 8 karakter' } };
        }
        const id = uid();
        d.profiles.push({
          id: id, business_id: BIZ, name: b.name, role: b.role === 'owner' ? 'owner' : 'staff',
          active: true, _email: email, _pw: b.password, created_at: new Date().toISOString(),
        });
        save(d);
        return { data: { ok: true, user_id: id }, error: null };
      }

      if (b.action === 'update') {
        const t = d.profiles.find((p) => p.id === b.user_id);
        if (!t) return { data: null, error: { message: 'Pengguna tidak ditemukan' } };

        const losing = (b.role && b.role !== 'owner' && t.role === 'owner') ||
                       (b.active === false && t.role === 'owner');
        if (losing && d.profiles.filter((p) => p.role === 'owner' && p.active).length <= 1) {
          return { data: null, error: { message: 'Toko harus punya minimal satu owner aktif' } };
        }

        if (b.name) t.name = b.name;
        if (b.role === 'owner' || b.role === 'staff') t.role = b.role;
        if (typeof b.active === 'boolean') t.active = b.active;
        if (b.password) {
          if (String(b.password).length < 8) {
            return { data: null, error: { message: 'Password minimal 8 karakter' } };
          }
          t._pw = b.password;
        }
        save(d);
        return { data: { ok: true }, error: null };
      }

      if (b.action === 'delete') {
        const t = d.profiles.find((p) => p.id === b.user_id);
        if (!t) return { data: null, error: { message: 'Pengguna tidak ditemukan' } };
        if (t.id === u.id) return { data: null, error: { message: 'Tidak bisa menghapus akun sendiri' } };
        if (t.role === 'owner' && d.profiles.filter((p) => p.role === 'owner' && p.active).length <= 1) {
          return { data: null, error: { message: 'Toko harus punya minimal satu owner aktif' } };
        }
        d.profiles = d.profiles.filter((p) => p.id !== b.user_id);
        save(d);
        return { data: { ok: true }, error: null };
      }

      return { data: null, error: { message: 'action tidak dikenal' } };
    }

    if (name === 'delete-account') {
      const u = me();
      if (u.role !== 'owner') {
        return { data: null, error: { message: 'Hanya owner yang boleh menghapus toko' } };
      }
      if (b.confirm !== 'HAPUS') {
        return { data: null, error: { message: 'Konfirmasi tidak cocok' } };
      }
      /* Di demo, cukup reset data lokal */
      try { localStorage.removeItem(DATA); } catch (e) {}
      return { data: { ok: true, demo: true }, error: null };
    }

    return { data: null, error: { message: 'Fungsi demo tidak dikenal: ' + name } };
  }

  function upload(file) {
    return new Promise((res) => {
      const r = new FileReader();
      r.onload  = (e) => res(e.target.result);
      r.onerror = () => res(null);
      r.readAsDataURL(file);
    });
  }

  function reset() {
    try { localStorage.removeItem(DATA); } catch (e) {}
    location.reload();
  }

  function banner() {
    if (!on()) return;
    /* Tandai <html> agar tata letak menyisakan ruang untuk banner */
    document.documentElement.classList.add('demo-on');
    if (document.getElementById('demoBanner')) return;
    const b = document.createElement('div');
    b.id = 'demoBanner';
    b.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;z-index:600;background:#F59E0B;color:#201500;' +
      'font:600 12px -apple-system,Segoe UI,Roboto,sans-serif;height:34px;padding:0 14px;' +
      'display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap';
    b.innerHTML =
      '<span><strong>MODE DEMO</strong> — data hanya di browser ini, pembayaran disimulasikan</span>' +
      '<a href="?demo=0" style="color:#201500;text-decoration:underline">Keluar demo</a>' +
      '<a href="javascript:Demo.reset()" style="color:#201500;text-decoration:underline">Reset data</a>';
    document.body.appendChild(b);
  }

  return {
    on, query, rpc, invoke, upload, login, reset, banner,
    credentials: CRED, credentialsStaff: CRED_STAFF,
  };
})();

if (Demo.on()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', Demo.banner);
  } else {
    Demo.banner();
  }
}
