/* ============================================================
   STOCKFLOW — UI helpers & app shell
   ============================================================ */

const UI = (function () {
  /* ---------- Format ---------- */
  const rp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');

  const num = (n) => {
    const v = Number(n) || 0;
    return (Math.round(v * 100) / 100).toLocaleString('id-ID');
  };

  const dt = (s) => {
    if (!s) return '-';
    const d = new Date(s);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ', ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  };

  const dateOnly = (s) => s
    ? new Date(s).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
    : '-';

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const initials = (s) =>
    String(s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  const mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  /* Pintasan ikon */
  const ic = (n, size, cls) => (typeof Icons !== 'undefined' ? Icons.svg(n, size, cls) : '');

  /* Isi semua placeholder <span data-ico="nama" data-ico-size="16">.
     Dipakai untuk ikon yang ditulis langsung di HTML, bukan dari JS. */
  function hydrateIcons(root) {
    (root || document).querySelectorAll('[data-ico]').forEach((el) => {
      if (el.dataset.icoDone) return;
      el.innerHTML = ic(el.dataset.ico, Number(el.dataset.icoSize) || 16);
      el.dataset.icoDone = '1';
      el.style.display = 'inline-flex';
      el.style.verticalAlign = 'middle';
    });
  }

  /* ---------- Toast ---------- */
  function toast(msg, type) {
    let host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost';
      document.body.appendChild(host);
    }
    const icon = type === 'ok' ? 'check' : type === 'error' ? 'alert' : type === 'warn' ? 'alert' : 'info';
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.innerHTML = ic(icon, 17) + '<span></span>';
    el.querySelector('span').textContent = msg;
    host.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .18s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    }, 2700);
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
  const openModal  = (id) => { const m = document.getElementById(id); if (m) m.classList.add('open'); };
  const closeModal = (id) => { const m = document.getElementById(id); if (m) m.classList.remove('open'); };

  function confirm(opts) {
    return new Promise((resolve) => {
      const o = Object.assign(
        { title: 'Konfirmasi', text: 'Lanjutkan?', ok: 'Lanjutkan', cancel: 'Batal', danger: false },
        opts || {}
      );
      const wrap = document.createElement('div');
      wrap.className = 'modal open';
      wrap.innerHTML =
        '<div class="modal-box narrow"><div class="modal-hd"><h3></h3></div>' +
        '<div class="modal-bd"><p style="color:var(--text-mid);line-height:1.62;font-size:14px"></p></div>' +
        '<div class="modal-ft"><button class="btn" data-no></button>' +
        '<button class="btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + '" data-yes></button></div></div>';
      wrap.querySelector('h3').textContent = o.title;
      wrap.querySelector('p').textContent = o.text;
      wrap.querySelector('[data-no]').textContent = o.cancel;
      wrap.querySelector('[data-yes]').textContent = o.ok;
      document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); resolve(v); };
      wrap.querySelector('[data-yes]').onclick = () => done(true);
      wrap.querySelector('[data-no]').onclick = () => done(false);
      wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    });
  }

  /* ---------- Tema ---------- */
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
  const isDark = () => (localStorage.getItem('sf5_theme') || 'light') === 'dark';

  /* ---------- Menu ---------- */
  const MENU = [
    { id: 'beranda',   icon: 'home',     label: 'Beranda',      href: 'beranda.html',   tab: true },
    { sec: 'Transaksi' },
    { id: 'pos',       icon: 'pos',      label: 'Kasir',        href: 'pos.html',       tab: true },
    { id: 'orders',    icon: 'receipt',  label: 'Riwayat',      href: 'orders.html' },
    { sec: 'Inventori' },
    { id: 'products',  icon: 'box',      label: 'Produk',       href: 'products.html',  tab: true },
    { id: 'inventory', icon: 'refresh',  label: 'Stok',         href: 'inventory.html' },
    { id: 'damaged',   icon: 'alert',    label: 'Barang Rusak', href: 'damaged.html' },
    { sec: 'Analisis', owner: true },
    { id: 'reports',   icon: 'chart',    label: 'Laporan',      href: 'reports.html',   tab: true, owner: true },
    { sec: 'Pengaturan' },
    { id: 'users',     icon: 'users',    label: 'Pengguna',     href: 'users.html',  owner: true },
    { id: 'settings',  icon: 'settings', label: 'Pengaturan',   href: 'settings.html' },
  ];

  /* ---------- Shell ---------- */
  function shell(active, title, topbarExtra) {
    const u = Auth.user() || {};
    const isOwner = u.role === 'owner';
    const visible = MENU.filter((m) => !m.owner || isOwner);

    const navItems = visible.map((m) => {
      if (m.sec) return '<div class="sb-sec">' + m.sec + '</div>';
      return '<a href="' + m.href + '" class="sb-item' + (m.id === active ? ' on' : '') + '">' +
        '<span class="sb-ico">' + ic(m.icon, 19) + '</span><span>' + m.label + '</span></a>';
    }).join('');

    const tabs = visible.filter((m) => m.tab)
      .concat([{ id: 'more', icon: 'menu', label: 'Lainnya', href: '#', more: true }])
      .map((m) => {
        const on = m.id === active ||
          (m.more && ['inventory', 'damaged', 'users', 'settings'].includes(active));
        return '<a href="' + (m.more ? 'javascript:UI.openMore()' : m.href) +
          '" class="tb-item' + (on ? ' on' : '') + '">' +
          ic(m.icon, 20) + '<span>' + m.label + '</span></a>';
      }).join('');

    const host = document.getElementById('app');
    if (!host) return;
    const inner = host.innerHTML;

    host.className = 'app';
    host.innerHTML =
      '<aside class="sidebar">' +
        '<div class="sb-brand">' + (typeof Icons !== 'undefined' ? Icons.logo(28) : '') +
          '<div class="sb-name">StockFlow</div></div>' +
        '<nav class="sb-nav">' + navItems + '</nav>' +
        '<div class="sb-foot"><div class="sb-user">' +
          '<div class="sb-avatar">' + initials(u.name) + '</div>' +
          '<div class="sb-uinfo"><div class="sb-uname">' + esc(u.name || '') + '</div>' +
          '<div class="sb-urole">' + esc(u.role || '') + '</div></div>' +
          '<button class="btn btn-ghost btn-icon btn-sm" onclick="Auth.logout()" title="Keluar">' +
            ic('logout', 17) + '</button>' +
        '</div></div>' +
      '</aside>' +
      '<div class="main">' +
        '<header class="topbar"><h1>' + esc(title) + '</h1><div class="spacer"></div>' +
          (topbarExtra || '') +
        '</header>' + inner +
      '</div>' +
      '<nav class="tabbar">' + tabs + '</nav>';

    /* Modal berada di luar #app, jadi seluruh dokumen ikut di-hydrate */
    hydrateIcons(document);
  }

  function openMore() {
    const u = Auth.user() || {};
    const items = MENU.filter((m) => !m.sec && !m.tab && (!m.owner || u.role === 'owner'));
    const wrap = document.createElement('div');
    wrap.className = 'modal open';
    wrap.innerHTML =
      '<div class="modal-box"><div class="modal-hd"><h3>Menu Lainnya</h3>' +
      '<button class="modal-x" data-x>' + ic('close', 18) + '</button></div><div class="modal-bd">' +
      items.map((m) =>
        '<a href="' + m.href + '" class="sb-item" style="font-size:15px;padding:12px 10px">' +
        '<span class="sb-ico">' + ic(m.icon, 19) + '</span><span>' + m.label + '</span></a>'
      ).join('') +
      '<a href="javascript:UI.toggleTheme()" class="sb-item" style="font-size:15px;padding:12px 10px">' +
      '<span class="sb-ico">' + ic(isDark() ? 'sun' : 'moon', 19) + '</span><span>' +
      (isDark() ? 'Mode Terang' : 'Mode Gelap') + '</span></a>' +
      '<a href="javascript:Auth.logout()" class="sb-item c-danger" style="font-size:15px;padding:12px 10px">' +
      '<span class="sb-ico">' + ic('logout', 19) + '</span><span>Keluar</span></a>' +
      '</div></div>';
    document.body.appendChild(wrap);
    wrap.querySelector('[data-x]').onclick = () => wrap.remove();
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
  }

  /* ---------- Empty state ----------
     act opsional: { label, href } atau { label, onclick } supaya
     pengguna punya langkah berikutnya, bukan kalimat buntu. */
  function empty(icon, title, sub, act) {
    var btn = '';
    if (act && act.label) {
      btn = act.href
        ? '<a class="btn btn-primary btn-sm mt16" href="' + act.href + '">' + esc(act.label) + '</a>'
        : '<button class="btn btn-primary btn-sm mt16" onclick="' + act.onclick + '">' +
          esc(act.label) + '</button>';
    }
    return '<div class="empty"><div class="empty-ico">' + ic(icon || 'empty', 21) + '</div>' +
      '<div class="empty-title">' + esc(title) + '</div>' +
      (sub ? '<div class="empty-sub">' + esc(sub) + '</div>' : '') + btn + '</div>';
  }

  /* ---------- Notice ---------- */
  function notice(kind, title, body) {
    const icons = { info: 'info', ok: 'check', warn: 'alert', danger: 'alert', plain: 'info' };
    return '<div class="notice ' + kind + '">' + ic(icons[kind] || 'info', 17) +
      '<div>' + (title ? '<strong>' + esc(title) + '</strong>' : '') + body + '</div></div>';
  }

  /* ---------- Status order ---------- */
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

  /* ---------- Rentang tanggal ---------- */
  function range(key) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start); end.setDate(end.getDate() + 1);

    if (key === 'today') return [start, end];
    if (key === 'yesterday') { const s = new Date(start); s.setDate(s.getDate() - 1); return [s, start]; }
    if (key === 'week')  { const s = new Date(start); s.setDate(s.getDate() - 6); return [s, end]; }
    if (key === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), end];
    if (key === 'year')  return [new Date(now.getFullYear(), 0, 1), end];
    return [new Date(2000, 0, 1), end];
  }

  return {
    rp, num, dt, dateOnly, esc, initials, mmss, ic, hydrateIcons,
    toast, loading, openModal, closeModal, confirm,
    applyTheme, toggleTheme, isDark, shell, openMore,
    empty, notice, range, statusBadge, ORDER_STATUS,
  };
})();

UI.applyTheme();
