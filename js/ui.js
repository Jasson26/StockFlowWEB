/* ============================================================
   STOCKFLOW v4 — UI helpers & app shell
   ============================================================ */

const UI = (function () {
  /* ---------- Format ---------- */
  const rp = (n) =>
    'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');

  const num = (n) => {
    const v = Number(n) || 0;
    return (Math.round(v * 100) / 100).toLocaleString('id-ID');
  };

  const dt = (s) => {
    if (!s) return '-';
    const d = new Date(s);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  };

  const dateOnly = (s) => {
    if (!s) return '-';
    return new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const initials = (s) =>
    String(s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  /* ---------- Toast ---------- */
  function toast(msg, type) {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .2s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    }, 2600);
  }

  /* ---------- Loader ---------- */
  function loading(on) {
    let el = document.getElementById('loader');
    if (!el) {
      el = document.createElement('div');
      el.id = 'loader';
      el.innerHTML = '<div class="spinner"></div>';
      document.body.appendChild(el);
    }
    el.classList.toggle('on', on !== false);
  }

  /* ---------- Modal ---------- */
  function openModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('open');
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('open');
  }

  /* Konfirmasi (promise) */
  function confirm(opts) {
    return new Promise((resolve) => {
      const o = Object.assign(
        { title: 'Konfirmasi', text: 'Lanjutkan?', ok: 'Ya, lanjutkan', cancel: 'Batal', danger: false },
        opts || {}
      );
      const wrap = document.createElement('div');
      wrap.className = 'modal open';
      wrap.innerHTML =
        '<div class="modal-box narrow"><div class="modal-hd"><h3>' + esc(o.title) + '</h3></div>' +
        '<div class="modal-bd"><p style="color:var(--text-mid);line-height:1.6">' + esc(o.text) + '</p></div>' +
        '<div class="modal-ft"><button class="btn" data-no>' + esc(o.cancel) + '</button>' +
        '<button class="btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + '" data-yes>' + esc(o.ok) + '</button></div></div>';
      document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('[data-yes]').onclick = () => done(true);
      wrap.querySelector('[data-no]').onclick = () => done(false);
      wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    });
  }

  /* ---------- Dark mode ---------- */
  function applyTheme() {
    const t = localStorage.getItem('sf5_theme') || 'light';
    document.documentElement.setAttribute('data-theme', t);
    return t;
  }
  function toggleTheme() {
    const next = (localStorage.getItem('sf5_theme') || 'light') === 'light' ? 'dark' : 'light';
    localStorage.setItem('sf5_theme', next);
    applyTheme();
    return next;
  }

  /* ---------- Menu definition ---------- */
  const MENU = [
    { sec: 'Transaksi' },
    { id: 'pos',       ico: '\u{1F6D2}', label: 'Kasir',          href: 'pos.html',       tab: true },
    { id: 'orders',    ico: '\u{1F9FE}', label: 'Riwayat',        href: 'orders.html',    tab: true },
    { sec: 'Inventori' },
    { id: 'products',  ico: '\u{1F4E6}', label: 'Produk',         href: 'products.html',  tab: true },
    { id: 'inventory', ico: '\u{1F504}', label: 'Stok',           href: 'inventory.html' },
    { id: 'damaged',   ico: '\u{26A0}',  label: 'Barang Rusak',   href: 'damaged.html' },
    { sec: 'Analisis', owner: true },
    { id: 'reports',   ico: '\u{1F4CA}', label: 'Laporan',        href: 'reports.html',   tab: true, owner: true },
    { sec: 'Pengaturan' },
    { id: 'users',     ico: '\u{1F465}', label: 'Pengguna',       href: 'users.html',  owner: true },
    { id: 'settings',  ico: '\u{2699}',  label: 'Pengaturan',     href: 'settings.html' },
  ];

  /* ---------- Render shell ----------
     Panggil: UI.shell('pos', 'Kasir', [extra topbar html])
     Mengisi elemen #app dengan sidebar + topbar + content + tabbar  */
  function shell(active, title, topbarExtra) {
    const u = Auth.user() || {};
    const isOwner = u.role === 'owner';

    const visible = MENU.filter((m) => !m.owner || isOwner);

    const navItems = visible.map((m) => {
      if (m.sec) return '<div class="sb-sec">' + m.sec + '</div>';
      return '<a href="' + m.href + '" class="sb-item' + (m.id === active ? ' on' : '') + '">' +
        '<span class="sb-ico">' + m.ico + '</span><span>' + m.label + '</span></a>';
    }).join('');

    const tabs = visible.filter((m) => m.tab).concat([
      { id: 'more', ico: '\u{2630}', label: 'Lainnya', href: '#', more: true },
    ]).map((m) => {
      const on = m.id === active || (m.more && ['inventory', 'damaged', 'users', 'settings'].includes(active));
      return '<a href="' + (m.more ? 'javascript:UI.openMore()' : m.href) + '" class="tb-item' + (on ? ' on' : '') + '">' +
        '<span class="tb-ico">' + m.ico + '</span><span>' + m.label + '</span></a>';
    }).join('');

    const host = document.getElementById('app');
    if (!host) return;
    const inner = host.innerHTML;

    host.className = 'app';
    host.innerHTML =
      '<aside class="sidebar">' +
        '<div class="sb-brand"><div class="sb-mark">S</div><div class="sb-name">StockFlow</div></div>' +
        '<nav class="sb-nav">' + navItems + '</nav>' +
        '<div class="sb-foot"><div class="sb-user">' +
          '<div class="sb-avatar">' + initials(u.name) + '</div>' +
          '<div class="sb-uinfo"><div class="sb-uname">' + esc(u.name || '') + '</div>' +
          '<div class="sb-urole">' + esc(u.role || '') + '</div></div>' +
          '<button class="btn-ghost btn btn-icon" onclick="Auth.logout()" title="Keluar">\u{1F6AA}</button>' +
        '</div></div>' +
      '</aside>' +
      '<div class="main">' +
        '<header class="topbar"><h1>' + esc(title) + '</h1><div class="spacer"></div>' +
          (topbarExtra || '') +
        '</header>' +
        inner +
      '</div>' +
      '<nav class="tabbar">' + tabs + '</nav>';
  }

  /* Sheet "Lainnya" untuk HP */
  function openMore() {
    const u = Auth.user() || {};
    const items = MENU.filter((m) => !m.sec && !m.tab && (!m.owner || u.role === 'owner'));
    const wrap = document.createElement('div');
    wrap.className = 'modal open';
    wrap.innerHTML =
      '<div class="modal-box"><div class="modal-hd"><h3>Menu Lainnya</h3>' +
      '<button class="modal-x" data-x>&times;</button></div><div class="modal-bd">' +
      items.map((m) =>
        '<a href="' + m.href + '" class="sb-item" style="font-size:15.5px;padding:14px 12px">' +
        '<span class="sb-ico">' + m.ico + '</span><span>' + m.label + '</span></a>'
      ).join('') +
      '<a href="javascript:UI.toggleTheme()" class="sb-item" style="font-size:15.5px;padding:14px 12px">' +
      '<span class="sb-ico">\u{1F319}</span><span>Mode Gelap</span></a>' +
      '<a href="javascript:Auth.logout()" class="sb-item c-danger" style="font-size:15.5px;padding:14px 12px">' +
      '<span class="sb-ico">\u{1F6AA}</span><span>Keluar</span></a>' +
      '</div></div>';
    document.body.appendChild(wrap);
    wrap.querySelector('[data-x]').onclick = () => wrap.remove();
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  }

  /* ---------- Empty state ---------- */
  function empty(ico, title, sub) {
    return '<div class="empty"><div class="empty-ico">' + ico + '</div>' +
      '<div class="empty-title">' + esc(title) + '</div>' +
      (sub ? '<div class="empty-sub">' + esc(sub) + '</div>' : '') + '</div>';
  }

  /* ---------- Rentang tanggal ---------- */
  function range(key) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start); end.setDate(end.getDate() + 1);

    if (key === 'today') return [start, end];
    if (key === 'yesterday') {
      const s = new Date(start); s.setDate(s.getDate() - 1);
      return [s, start];
    }
    if (key === 'week')  { const s = new Date(start); s.setDate(s.getDate() - 6); return [s, end]; }
    if (key === 'month') { return [new Date(now.getFullYear(), now.getMonth(), 1), end]; }
    if (key === 'year')  { return [new Date(now.getFullYear(), 0, 1), end]; }
    return [new Date(2000, 0, 1), end];
  }

  /* ---------- Hitung mundur mm:ss ---------- */
  function mmss(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  /* ---------- Label status order ---------- */
  const ORDER_STATUS = {
    paid:    { label: 'Lunas',          cls: 'ok' },
    pending: { label: 'Menunggu bayar', cls: 'warn' },
    expired: { label: 'Kedaluwarsa',    cls: '' },
    failed:  { label: 'Gagal',          cls: 'danger' },
    void:    { label: 'Void',           cls: 'danger' },
  };
  const statusBadge = (s) => {
    const o = ORDER_STATUS[s] || { label: s, cls: '' };
    return '<span class="badge ' + o.cls + '">' + o.label + '</span>';
  };

  return {
    rp, num, dt, dateOnly, esc, initials,
    toast, loading, openModal, closeModal, confirm,
    applyTheme, toggleTheme, shell, openMore, empty, range,
    mmss, statusBadge, ORDER_STATUS,
  };
})();

/* Terapkan tema sebelum render untuk menghindari flash putih */
UI.applyTheme();
