/* ============================================================
   STOCKFLOW — Printer struk Bluetooth (ESC/POS over BLE)
   ------------------------------------------------------------
   Dibuat untuk printer thermal 58mm, 203 dpi, perintah ESC/POS.

   Batasan yang perlu diketahui:
   • Web Bluetooth hanya menjangkau perangkat Bluetooth Low Energy
     (BLE/GATT). Printer yang hanya Bluetooth Classic (SPP) tidak
     bisa dijangkau dari browser mana pun.
   • Tidak tersedia di iPhone/iPad, Safari, dan Firefox.
     Chrome atau Edge di Android, Windows, macOS, dan Linux bisa.
   • Hanya jalan di halaman HTTPS, dan harus dipicu klik pengguna.

   Kalau salah satu syarat tidak terpenuhi, aplikasi tetap bisa
   mencetak lewat dialog print bawaan browser.
   ============================================================ */

const Printer = (function () {

  /* ---------- Lebar kertas ----------
     58mm pada 203dpi = 384 titik = 32 karakter Font A. */
  const COLS = 32;

  /* ---------- UUID yang umum dipakai printer thermal BLE ----------
     Tiap pabrikan memakai service berbeda. Semuanya didaftarkan
     sebagai optionalServices agar bisa ditelusuri setelah terhubung. */
  const SERVICE_UUIDS = [
    '000018f0-0000-1000-8000-00805f9b34fb', // paling umum (char tulis 2af1)
    '0000ff00-0000-1000-8000-00805f9b34fb', // seri ff00/ff02
    '0000ffe0-0000-1000-8000-00805f9b34fb', // modul HM-10
    '0000ff10-0000-1000-8000-00805f9b34fb',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC / Microchip transparent UART
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
    '0000fee7-0000-1000-8000-00805f9b34fb',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  ];

  const LS_KEY = 'sf5_printer';

  let device = null;
  let charac = null;      // characteristic untuk menulis
  let mtu = 20;           // aman untuk MTU bawaan BLE (23 - 3 byte header)
  let busy = false;

  /* ============================================================
     DUKUNGAN LINGKUNGAN
     ============================================================ */
  function support() {
    const hasApi = typeof navigator !== 'undefined' && !!navigator.bluetooth;
    const secure = typeof window !== 'undefined' &&
      (window.isSecureContext || location.protocol === 'https:' ||
       location.hostname === 'localhost');

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);

    let reason = null;
    if (isIOS) {
      reason = 'iPhone dan iPad tidak mendukung Web Bluetooth. ' +
               'Gunakan HP Android, atau cetak lewat dialog print.';
    } else if (!hasApi) {
      reason = 'Browser ini tidak mendukung Web Bluetooth. ' +
               'Gunakan Chrome atau Edge versi terbaru.';
    } else if (!secure) {
      reason = 'Bluetooth hanya bisa dipakai di halaman HTTPS. ' +
               'Buka situs lewat alamat https://, bukan dari file lokal.';
    }

    return { ok: !reason, reason: reason, api: hasApi, secure: secure, ios: isIOS };
  }

  /* ============================================================
     STATUS & PENYIMPANAN
     ============================================================ */
  const connected = () => !!(device && device.gatt && device.gatt.connected && charac);

  function remembered() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function remember(name, id) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ name: name, id: id })); } catch (e) {}
  }
  function forget() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  function info() {
    return {
      connected: connected(),
      name: device ? (device.name || 'Printer') : (remembered() ? remembered().name : null),
      remembered: !!remembered(),
    };
  }

  /* Pemberitahuan perubahan status ke UI */
  const listeners = [];
  const onChange = (fn) => { listeners.push(fn); };
  const emit = () => listeners.forEach((fn) => { try { fn(info()); } catch (e) {} });

  /* ============================================================
     KONEKSI
     ============================================================ */

  /* Characteristic tulis yang dipakai printer thermal populer.
     Dicari lebih dulu; kalau memilih sembarang characteristic yang
     "bisa ditulis", data bisa terkirim ke jalur yang salah dan
     kertas keluar kosong. */
  const PRINT_CHARS = [
    '00002af1-0000-1000-8000-00805f9b34fb', // service 18f0 (RPP02N, MTP-II, dll)
    '0000ff02-0000-1000-8000-00805f9b34fb', // service ff00
    '0000ffe1-0000-1000-8000-00805f9b34fb', // HM-10
    '0000ff12-0000-1000-8000-00805f9b34fb', // service ff10
    '49535343-8841-43f4-a8d4-ecbe34729bb3', // ISSC transparent UART (TX)
    '6e400002-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART (RX dari sisi printer)
    'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', // service e7810a71
  ];

  /* Service yang jelas bukan jalur cetak */
  const SKIP_SERVICES = [
    '00001800-0000-1000-8000-00805f9b34fb', // Generic Access
    '00001801-0000-1000-8000-00805f9b34fb', // Generic Attribute
    '0000180a-0000-1000-8000-00805f9b34fb', // Device Information
    '0000180f-0000-1000-8000-00805f9b34fb', // Battery
  ];

  async function findWritable(server) {
    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch (e) {
      /* Sebagian platform menolak enumerasi; coba satu per satu */
      for (const u of SERVICE_UUIDS) {
        try { services.push(await server.getPrimaryService(u)); } catch (err) {}
      }
    }

    const all = [];
    for (const svc of services) {
      if (SKIP_SERVICES.indexOf(String(svc.uuid).toLowerCase()) >= 0) continue;
      let chars = [];
      try { chars = await svc.getCharacteristics(); } catch (e) { continue; }
      for (const c of chars) {
        if (c.properties && (c.properties.write || c.properties.writeWithoutResponse)) {
          all.push(c);
        }
      }
    }

    /* 1. characteristic printer yang dikenal */
    for (const u of PRINT_CHARS) {
      const hit = all.find((c) => String(c.uuid).toLowerCase() === u);
      if (hit) return hit;
    }
    /* 2. cadangan: yang pertama bisa ditulis */
    return all[0] || null;
  }

  async function connect() {
    const s = support();
    if (!s.ok) throw new Error(s.reason);
    if (busy) throw new Error('Sedang sibuk, coba lagi sebentar');

    /* acceptAllDevices dipakai karena printer murah sering tidak
       mengiklankan service UUID-nya pada paket advertising. */
    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: SERVICE_UUIDS,
    });

    device.addEventListener('gattserverdisconnected', function () {
      charac = null;
      emit();
    });

    const server = await device.gatt.connect();
    charac = await findWritable(server);

    if (!charac) {
      try { device.gatt.disconnect(); } catch (e) {}
      device = null;
      throw new Error(
        'Perangkat terhubung tapi tidak ditemukan jalur cetak. ' +
        'Kemungkinan printer ini hanya mendukung Bluetooth Classic (SPP), ' +
        'yang tidak bisa diakses dari browser.');
    }

    mtu = 20;

    remember(device.name || 'Printer', device.id);
    emit();
    return info();
  }

  /* Sambungkan ulang ke perangkat yang sudah pernah diizinkan,
     tanpa memunculkan dialog pemilihan. */
  async function reconnect() {
    if (connected()) return info();
    if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return null;
    if (!remembered()) return null;

    try {
      const list = await navigator.bluetooth.getDevices();
      const saved = remembered();
      const dev = list.find((d) => d.id === saved.id);
      if (!dev) return null;

      device = dev;
      device.addEventListener('gattserverdisconnected', function () {
        charac = null; emit();
      });

      const server = await device.gatt.connect();
      charac = await findWritable(server);
      if (!charac) { device = null; return null; }

      mtu = 20;
      emit();
      return info();
    } catch (e) {
      return null;
    }
  }

  /**
   * Pastikan printer siap dipakai, dipanggil tepat saat pengguna menekan
   * tombol cetak. Urutannya: sudah tersambung, lalu coba sambung ulang
   * diam-diam, baru minta pengguna memilih perangkat.
   *
   * Harus dipanggil langsung dari penanganan klik, karena requestDevice()
   * mensyaratkan gestur pengguna.
   */
  async function ensure() {
    if (connected()) return true;

    const s = support();
    if (!s.ok) throw new Error(s.reason);

    /* Sambung ulang tanpa dialog bila perangkatnya masih diizinkan */
    const back = await reconnect();
    if (back && connected()) return true;

    /* Terpaksa minta pengguna memilih lagi */
    await connect();
    return connected();
  }

  function disconnect() {
    try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
    device = null; charac = null;
    emit();
  }

  /* ============================================================
     PENGIRIMAN DATA
     ============================================================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function writeRaw(bytes) {
    if (!connected()) throw new Error('Printer belum terhubung');
    if (busy) throw new Error('Masih mencetak, tunggu sebentar');
    busy = true;

    /* Tulis DENGAN respons bila didukung: printer mengonfirmasi tiap
       potongan, jadi tidak ada data yang terbuang karena buffer penuh.
       Mengirim terlalu cepat tanpa respons adalah penyebab umum
       kertas keluar kosong. */
    const withResp = !!(charac.properties.write && (charac.writeValueWithResponse || charac.writeValue));

    try {
      await sleep(60); // beri jeda setelah sambung / init
      for (let i = 0; i < bytes.length; i += mtu) {
        const chunk = bytes.slice(i, i + mtu);
        if (withResp) {
          if (charac.writeValueWithResponse) await charac.writeValueWithResponse(chunk);
          else await charac.writeValue(chunk);
          await sleep(8);
        } else if (charac.writeValueWithoutResponse) {
          await charac.writeValueWithoutResponse(chunk);
          await sleep(35);
        } else if (charac.writeValue) {
          await charac.writeValue(chunk);
          await sleep(35);
        } else {
          throw new Error('Characteristic tidak bisa ditulis');
        }
        /* Tiap ~300 byte beri waktu kepala cetak mengejar */
        if ((i / mtu) % 15 === 14) await sleep(withResp ? 40 : 120);
      }
      await sleep(250);
    } finally {
      busy = false;
    }
  }

  /* ============================================================
     ESC/POS
     ============================================================ */
  const ESC = 0x1B, GS = 0x1D, LF = 0x0A;

  /* Printer thermal umumnya hanya mengenal ASCII/CP437.
     Karakter Indonesia yang di luar itu diubah agar tidak jadi sampah. */
  function toAscii(s) {
    return String(s == null ? '' : s)
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/…/g, '...')
      .replace(/ /g, ' ')
      .replace(/[^\x20-\x7E\n]/g, '');
  }

  function Builder() {
    this.b = [];
  }
  Builder.prototype.raw   = function (arr) { this.b.push.apply(this.b, arr); return this; };
  Builder.prototype.init  = function () { return this.raw([ESC, 0x40]); };
  Builder.prototype.align = function (n) { return this.raw([ESC, 0x61, n]); };      // 0 kiri 1 tengah 2 kanan
  Builder.prototype.bold  = function (on) { this._bold = !!on; return this.raw([ESC, 0x45, on ? 1 : 0]); };
  /* Ukuran huruf lewat ESC ! (mode cetak). Lebih luas didukung daripada
     GS !, yang di sebagian printer murah membuat teks tidak tercetak. */
  Builder.prototype.size  = function (w, h) {                                        // 0..1 masing-masing
    /* ESC ! juga mengatur tebal, jadi status tebal ikut dipertahankan */
    return this.raw([ESC, 0x21, (h ? 0x10 : 0) | (w ? 0x20 : 0) | (this._bold ? 0x08 : 0)]);
  };
  Builder.prototype.feed  = function (n) { return this.raw([ESC, 0x64, n || 1]); };
  /* Printer portabel 58mm tidak punya pemotong; perintah potong sengaja
     tidak dikirim karena sebagian model justru menganggapnya data rusak. */
  Builder.prototype.cut   = function () { return this; };

  Builder.prototype.text = function (s) {
    const t = toAscii(s);
    for (let i = 0; i < t.length; i++) this.b.push(t.charCodeAt(i) & 0xFF);
    return this;
  };
  Builder.prototype.line = function (s) { return this.text(s == null ? '' : s).raw([LF]); };

  /* Baris kiri-kanan dalam satu lebar kertas */
  Builder.prototype.pair = function (left, right) {
    const l = toAscii(left), r = toAscii(right);
    const gap = Math.max(1, COLS - l.length - r.length);
    if (l.length + r.length + 1 > COLS) {
      /* Terlalu panjang: nama di baris sendiri, nilai rata kanan */
      this.line(l.slice(0, COLS));
      return this.line(' '.repeat(Math.max(0, COLS - r.length)) + r);
    }
    return this.line(l + ' '.repeat(gap) + r);
  };

  Builder.prototype.rule  = function (ch) { return this.line((ch || '-').repeat(COLS)); };

  /* Teks panjang dipotong mengikuti lebar kertas */
  Builder.prototype.wrap = function (s) {
    const words = toAscii(s).split(/\s+/).filter(Boolean);
    let cur = '';
    words.forEach((w) => {
      if (!cur.length) { cur = w.slice(0, COLS); return; }
      if (cur.length + 1 + w.length <= COLS) { cur += ' ' + w; }
      else { this.line(cur); cur = w.slice(0, COLS); }
    });
    if (cur.length) this.line(cur);
    return this;
  };

  Builder.prototype.bytes = function () { return new Uint8Array(this.b); };

  /* ============================================================
     SUSUNAN STRUK
     ============================================================ */

  /**
   * @param {object} o   order: order_no, created_at, cashier_name, customer_name,
   *                     subtotal, discount, tax, total, paid_amount, change_amount,
   *                     payment_method, ref_note, status
   * @param {Array}  items  [{name, price, qty}]
   * @param {object} biz    {name, address, phone, receipt_note}
   */
  function buildReceipt(o, items, biz) {
    const rp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
    const qty = (n) => {
      const v = Number(n) || 0;
      return (Math.round(v * 100) / 100).toLocaleString('id-ID');
    };
    const mName = { cash: 'Tunai', qris: 'QRIS', transfer: 'Transfer' };

    const b = new Builder();
    b.init().raw([ESC, 0x74, 0x00]); // tabel karakter PC437

    /* Kepala */
    b.align(1).bold(true).size(1, 1);
    b.line(biz.name || 'TOKO');
    b.size(0, 0).bold(false);
    if (biz.address) b.wrap(biz.address);
    if (biz.phone)   b.line(biz.phone);
    b.align(0).rule();

    /* Keterangan transaksi */
    const d = new Date(o.created_at || Date.now());
    b.pair('No.', String(o.order_no || '-'));
    b.pair('Tanggal', d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
                      ' ' + d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));
    if (o.cashier_name)  b.pair('Kasir', o.cashier_name);
    if (o.customer_name && o.customer_name !== 'Umum') b.pair('Pembeli', o.customer_name);
    b.rule();

    /* Rincian barang */
    (items || []).forEach((i) => {
      b.wrap(i.name);
      b.pair('  ' + qty(i.qty) + ' x ' + rp(i.price), rp(Number(i.price) * Number(i.qty)));
    });
    b.rule();

    /* Jumlah */
    b.pair('Subtotal', rp(o.subtotal));
    if (Number(o.discount)) b.pair('Diskon', '-' + rp(o.discount));
    if (Number(o.tax))      b.pair('Pajak', rp(o.tax));

    b.bold(true).size(0, 1);
    b.pair('TOTAL', rp(o.total));
    b.size(0, 0).bold(false);

    b.rule();
    b.pair(mName[o.payment_method] || o.payment_method || 'Bayar',
           rp(o.paid_amount || o.total));
    if (Number(o.change_amount)) b.pair('Kembali', rp(o.change_amount));
    if (o.ref_note) b.pair('Ref', String(o.ref_note).toUpperCase());

    if (o.status && o.status !== 'paid') {
      b.rule();
      b.align(1).bold(true).line('** ' + String(o.status).toUpperCase() + ' **').bold(false).align(0);
    }

    /* Penutup */
    b.rule();
    b.align(1);
    if (biz.receipt_note) b.wrap(biz.receipt_note);
    b.line('');
    b.align(0).feed(3);

    /* Perintah potong dikirim juga; printer tanpa pemotong akan mengabaikannya */
    b.cut();

    return b.bytes();
  }

  async function printReceipt(o, items, biz) {
    return writeRaw(buildReceipt(o, items, biz));
  }

  /* Struk uji untuk memastikan printer bekerja */
  async function printTest(bizName) {
    const b = new Builder();
    b.init();
    b.align(1).bold(true).size(1, 1).line('TES CETAK').size(0, 0).bold(false);
    b.line(bizName || 'StockFlow');
    b.align(0).rule();
    b.pair('Lebar kertas', '58 mm');
    b.pair('Kolom', String(COLS));
    b.pair('Waktu', new Date().toLocaleString('id-ID'));
    b.rule();
    b.line('Penjajaran kolom:');
    b.pair('Kopi Susu Gula Aren', 'Rp 18.000');
    b.pair('  2 x Rp 18.000', 'Rp 36.000');
    b.rule();
    b.bold(true).size(0, 1).pair('TOTAL', 'Rp 36.000').size(0, 0).bold(false);
    b.rule();
    b.line('1234567890 ABCDEFGHIJKLMNOPQRS');
    b.align(1).line('').line('Printer siap digunakan').align(0);
    b.feed(3).cut();
    return writeRaw(b.bytes());
  }

  return {
    COLS, support, connect, reconnect, ensure, disconnect, connected, info,
    forget, printReceipt, printTest, buildReceipt, onChange,
    Builder, toAscii,
  };
})();
