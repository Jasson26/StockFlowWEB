/* ============================================================
   STOCKFLOW — Ikon SVG
   Stroke-based, 24x24, mewarisi currentColor.
   Dipakai menggantikan emoji agar tampilan konsisten di semua
   perangkat (emoji dirender berbeda di Windows, Android, iOS).
   ============================================================ */

const Icons = (function () {
  const P = {
    /* ---------- Navigasi ---------- */
    pos:
      '<path d="M3 3h2l.4 2M7 13h10l3-8H5.4M7 13 5.4 5M7 13l-2.3 2.3c-.6.6-.2 1.7.7 1.7H17"/>' +
      '<circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>',
    receipt:
      '<path d="M5 3v18l2.5-1.5L10 21l2-1.5L14 21l2.5-1.5L19 21V3H5Z"/>' +
      '<path d="M9 8h6M9 12h6"/>',
    box:
      '<path d="m21 8-9-5-9 5v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    refresh:
      '<path d="M3 11a9 9 0 0 1 15-5.7L21 8"/><path d="M21 4v4h-4"/>' +
      '<path d="M21 13a9 9 0 0 1-15 5.7L3 16"/><path d="M3 20v-4h4"/>',
    alert:
      '<path d="M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>' +
      '<path d="M12 9v4M12 17h.01"/>',
    chart:
      '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m7 15 3.5-4 3 2.5L18 8"/>',
    users:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>' +
      '<path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    home:
      '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>' +
      '<path d="M9 21v-7h6v7"/>',

    /* ---------- Aksi ---------- */
    plus:   '<path d="M12 5v14M5 12h14"/>',
    minus:  '<path d="M5 12h14"/>',
    close:  '<path d="M18 6 6 18M6 6l12 12"/>',
    check:  '<path d="M20 6 9 17l-5-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    edit:   '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z"/>',
    trash:  '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
            '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/>',
    eye:    '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    print:  '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>' +
            '<path d="M6 14h12v8H6z"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2Z"/>' +
            '<circle cx="12" cy="13" r="4"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    moon:   '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    sun:    '<circle cx="12" cy="12" r="4"/>' +
            '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    tag:    '<path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><path d="M7 7h.01"/>',
    arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    arrowUp:   '<path d="M12 19V5M5 12l7-7 7 7"/>',
    scale:  '<path d="M12 3v18M8 21h8"/><path d="M5 7h14"/><path d="m5 7-3 7h6ZM19 7l-3 7h6Z"/>',
    back:   '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    forward:'<path d="M5 12h14M12 5l7 7-7 7"/>',

    /* ---------- Pembayaran ---------- */
    cash:   '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>' +
            '<path d="M6 12h.01M18 12h.01"/>',
    qr:     '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3z"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM18 14h.01M14 18h.01"/>',
    bank:   '<path d="m3 10 9-6 9 6M5 10v9M9 10v9M15 10v9M19 10v9M3 21h18"/>',
    shield: '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
    clock:  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bluetooth:
      '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
    printer:
      '<path d="M6 9V3h12v6"/>' +
      '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>' +
      '<rect x="6" y="14" width="12" height="8" rx="1"/><path d="M18 12h.01"/>',
    link:
      '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>' +
      '<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    unlink:
      '<path d="m2 2 20 20"/>' +
      '<path d="M15 7l1.5-1.5a5 5 0 0 1 7 7L22 14M9 17l-1.5 1.5a5 5 0 0 1-7-7L2 10"/>',

    /* ---------- Status & lain-lain ---------- */
    empty:  '<path d="M3 7h18M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>' +
            '<path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7"/>',
    info:   '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    lock:   '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    store:  '<path d="M3 9V5h18v4a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0Z"/>' +
            '<path d="M5 12v9h14v-9M9 21v-6h6v6"/>',
    user:   '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    phone:  '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    monitor:'<rect x="2" y="3" width="20" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>',
    zap:    '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  };

  /* Ikon yang perlu fill, bukan stroke */
  const FILLED = {};

  /**
   * Hasilkan markup SVG.
   * @param {string} name  nama ikon
   * @param {number} size  ukuran piksel (default 20)
   * @param {string} cls   kelas CSS tambahan
   */
  function svg(name, size, cls) {
    const d = P[name];
    if (!d) return '';
    const s = size || 20;
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" width="' + s + '" height="' + s +
      '" viewBox="0 0 24 24" fill="' + (FILLED[name] ? 'currentColor' : 'none') +
      '" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }

  /* Logo StockFlow: huruf S besar, miring, ungu. */
  const PURPLE = '#7C3AED';

  function logo(size) {
    const s = size || 32;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 32 32" ' +
      'fill="none" aria-hidden="true" class="sf-logo">' +
      '<text x="16" y="25" text-anchor="middle" ' +
        'font-family="Georgia, \'Times New Roman\', serif" ' +
        'font-size="30" font-weight="700" font-style="italic" ' +
        'fill="' + PURPLE + '">S</text>' +
      '</svg>';
  }

  return { svg, logo, has: (n) => !!P[n], PURPLE };
})();
