# StockFlow v5 — Kasir & Inventori dengan QRIS Resmi

Aplikasi web kasir untuk UMKM Indonesia. Berjalan di HP, tablet, dan komputer
lewat browser biasa. Akun pengguna sungguhan, data antar-toko terisolasi, dan
pembayaran QRIS yang terkonfirmasi otomatis.

**Mulai dari mana:** buka `index.html`, klik **Coba Demo**. Untuk dipakai
sungguhan, ikuti [`DEPLOY.md`](DEPLOY.md).

---

## Yang berubah dari versi sebelumnya

| | v4 | v5 |
|---|---|---|
| Password | teks biasa di tabel | di-hash oleh Supabase Auth |
| Isolasi data | difilter di aplikasi | RLS di database |
| Laporan keuangan | disembunyikan di UI | ditolak di database untuk staff |
| QRIS | gambar statis, cek manual | QR dinamis, terkonfirmasi otomatis |
| Secret gateway | — | hanya di Edge Function, tidak pernah di browser |
| Penerima dana | satu rekening | tiap toko memakai akun Midtrans sendiri |
| Hak data | — | export dan hapus akun mandiri (UU PDP) |

---

## Satu QR untuk semua e-wallet

QRIS adalah standar Bank Indonesia. Satu kode QR bisa dipindai dengan
**GoPay, OVO, DANA, ShopeePay, LinkAja, dan aplikasi m-banking mana pun** yang
terdaftar sebagai issuer QRIS.

Jadi untuk kasir fisik tidak perlu integrasi terpisah per e-wallet. API langsung
OVO/DANA/GoPay memang ada, tapi itu untuk checkout online yang mengalihkan
pembeli ke aplikasi — tidak masuk akal ketika pembeli sedang berdiri di depan
kasir dengan HP di tangan.

### Alur di kasir

```
Kasir pilih produk → Bayar → QRIS
  ↓
Order dibuat berstatus "pending" (stok belum dipotong)
  ↓
Edge Function minta tagihan ke Midtrans → QR muncul, hitung mundur 15 menit
  ↓
Pembeli scan & bayar dengan app apa pun
  ↓
Midtrans kirim notifikasi → webhook verifikasi signature
  ↓
Order jadi "lunas", stok dipotong, struk muncul otomatis
```

Nominal sudah terisi di QR, jadi pembeli tidak bisa salah ketik jumlah.

---

## Keamanan

**Password.** Ditangani Supabase Auth dengan bcrypt. Aplikasi tidak pernah
melihat atau menyimpan password. Tabel `profiles` tidak punya kolom password.

**Isolasi antar-toko.** Setiap tabel punya Row Level Security yang mengunci baris
ke `business_id` pemanggil, diambil dari JWT. Toko A tidak bisa membaca data
toko B walau mencoba memanggil REST API langsung — penyaringan terjadi di
database, bukan di JavaScript yang bisa dimodifikasi.

**Data keuangan.** Tabel `expenses` hanya bisa dibaca owner, ditegakkan di RLS.
Staff yang mencoba mengaksesnya lewat API tetap dapat hasil kosong.

**Secret gateway.** `MIDTRANS_SERVER_KEY` dan `service_role key` hanya ada di
environment Edge Function. Tidak ada di file yang dikirim ke browser —
ini diuji otomatis di `test.js`.

**Webhook.** Setiap notifikasi diverifikasi dengan
`SHA512(order_id + status_code + gross_amount + server_key)`, dibandingkan
secara waktu-konstan. Tanpa server key, pihak lain tidak bisa memalsukan
notifikasi "sudah dibayar". Setelah signature lolos, status masih dikonfirmasi
ulang langsung ke Midtrans agar notifikasi lama tidak bisa diputar ulang.

**Pelunasan ganda.** Fungsi `order_settle` idempotent — notifikasi yang sama
dikirim dua kali tidak memotong stok dua kali.

**Fungsi sensitif.** `order_settle` dan `order_mark_failed` dicabut hak
eksekusinya dari pengguna biasa; hanya bisa dipanggil `service_role` dari dalam
Edge Function.

### Yang masih jadi tanggung jawab Anda

- Owner membuat password karyawan, jadi owner sempat mengetahuinya. Minta
  karyawan menggantinya sendiri di Pengaturan setelah login pertama.
- Siapa pun yang punya akses ke akun Supabase Anda bisa membaca semua data.
  Aktifkan 2FA di Supabase dan Midtrans.
- Isi `ALLOWED_ORIGINS` di secret Edge Function. Kalau dibiarkan kosong, semua
  domain bisa memanggil fungsi Anda.

---

## Hak akses

| | Owner | Staff |
|---|:---:|:---:|
| Kasir | ✓ | ✓ |
| Riwayat transaksi | ✓ | ✓ |
| Produk & kategori | ✓ | ✓ |
| Stok masuk/keluar/opname | ✓ | ✓ |
| Barang rusak | ✓ | ✓ |
| Laporan & laba rugi | ✓ | — |
| Kelola pengguna | ✓ | — |
| Info toko & QRIS | ✓ | — |
| Void transaksi lunas | ✓ | — |

---

## Dana masuk ke rekening tiap toko

Setiap owner memasang Server Key Midtrans miliknya sendiri lewat
**Pengaturan → Pembayaran QRIS**. Pembayaran diproses oleh akun Midtrans toko
tersebut, sehingga dana mengalir langsung ke rekening mereka tanpa melewati
pihak mana pun.

Key disimpan di tabel `payment_credentials` yang **tidak punya policy SELECT
sama sekali** — owner bisa memasang dan mengganti, tapi tidak ada jalur untuk
membacanya kembali dari aplikasi. Hanya Edge Function di sisi server yang dapat
mengaksesnya. Untuk kebutuhan tampilan, hanya 4 karakter terakhir yang disimpan
terpisah.

Toko yang belum punya akun Midtrans tetap bisa memakai QRIS statis (unggah
gambar QR sendiri) atau pembayaran tunai.

## Printer struk Bluetooth

Struk bisa langsung dicetak ke printer thermal tanpa dialog print. Hubungkan
sekali di **Pengaturan → Printer Struk Bluetooth**, lalu printer tersambung
otomatis setiap kali aplikasi dibuka.

Ada saklar **cetak otomatis**: struk keluar sendiri begitu transaksi selesai,
tanpa menekan tombol apa pun.

### Printer yang didukung

| Syarat | Keterangan |
|---|---|
| Bluetooth | **4.0 / BLE**. Printer yang hanya Bluetooth Classic (SPP) tidak bisa dijangkau browser. |
| Perintah | ESC/POS |
| Lebar kertas | 58mm (32 kolom) |

Cek kemasan printer: kalau tertulis `Bluetooth 2.0/4.0` atau `BLE`, kemungkinan
besar bisa. Kalau hanya `Bluetooth 2.0`, tidak bisa.

### Browser yang didukung

| Perangkat | Status |
|---|---|
| Android — Chrome, Edge | Bisa |
| Windows, macOS, Linux — Chrome, Edge | Bisa |
| iPhone, iPad — semua browser | **Tidak bisa** |
| Safari, Firefox | **Tidak bisa** |

Ini batasan Web Bluetooth, bukan batasan StockFlow. Di perangkat yang tidak
didukung, aplikasi otomatis menawarkan dialog print browser sebagai gantinya.

Halaman harus diakses lewat **HTTPS** — membuka file HTML langsung dari folder
tidak akan bisa memakai Bluetooth.

## Hak atas data

Sesuai UU Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi:

- **Unduh semua data** — Pengaturan → Data Anda → Unduh (JSON lengkap, atau CSV transaksi)
- **Hapus akun & seluruh data** — Pengaturan → Hapus Toko, permanen dan langsung
- Halaman [`privasi.html`](privasi.html) dan [`ketentuan.html`](ketentuan.html)
  menjelaskan data apa yang disimpan, siapa saja pihak ketiganya, dan batasan
  tanggung jawab

## Struktur file

```
index.html              Landing page (publik)
masuk.html              Masuk, daftar toko, lupa password
privasi.html            Kebijakan Privasi (publik)
ketentuan.html          Syarat & Ketentuan (publik)
pos.html                Kasir + alur pembayaran QRIS
orders.html             Riwayat, detail, periksa status, void
products.html           Produk & kategori
inventory.html          Stok masuk/keluar/opname
damaged.html            Barang rusak & kerugian
reports.html            Laporan keuangan          (owner)
users.html              Kelola pengguna           (owner)
settings.html           Pengaturan toko & QRIS

schema.sql              Skema + RLS + fungsi kasir
test.js                 115 tes logika & keamanan  (node test.js)

css/app.css             Seluruh tampilan
js/config.js            Kredensial publik          <- yang perlu diedit
js/api.js               Klien REST/RPC/Storage/Functions
js/auth.js              Supabase Auth & sesi
js/ui.js                Komponen & navigasi
js/demo.js              Mode demo

supabase/functions/
  _shared/lib.ts        CORS, env, signature, identitas pemanggil
  payment-create/       Buat tagihan QRIS di Midtrans
  payment-webhook/      Terima notifikasi, verifikasi, lunasi
  payment-status/       Cek status manual (jaring pengaman webhook)
  create-staff/         Owner membuat/ubah/hapus akun karyawan
  delete-account/       Hapus toko beserta seluruh data dan akunnya
```

Ikon memakai SVG yang digambar sendiri (`js/icons.js`), bukan emoji, agar
tampilannya sama persis di Windows, Android, dan iOS.

Folder `supabase/` dan `test.js` **tidak perlu** diupload ke web hosting.

---

## Catatan teknis

| | |
|---|---|
| Frontend | HTML, CSS, JavaScript murni — tanpa framework atau build step |
| Backend | Supabase (PostgreSQL + Auth + Storage + Edge Functions) |
| Gateway | Midtrans Core API, `payment_type: qris` |
| Perhitungan transaksi | Fungsi PostgreSQL — atomic, divalidasi di server |
| Responsif | HP < 768px (tab bawah) · Tablet 768–1199px (sidebar ikon) · Desktop ≥ 1200px |
| Mode gelap | Tersimpan per perangkat |
| Cetak struk | Printer Bluetooth BLE (ESC/POS 58mm) atau dialog print browser |

Jalankan `node test.js` untuk memverifikasi logika checkout, rumus signature
webhook, idempotensi pelunasan, pembatasan hak akses, dan tidak adanya secret
di kode klien.

---

## Batasan yang perlu diketahui

**Tiap toko perlu akun Midtrans sendiri.** Dana memang langsung masuk ke
rekening mereka, tapi artinya setiap owner harus mendaftar dan melewati
verifikasi merchant Midtrans sendiri sebelum bisa menerima uang sungguhan.
Alternatif tanpa pendaftaran adalah QRIS statis, dengan konsekuensi pembayaran
tidak terkonfirmasi otomatis.

Pendekatan yang lebih mulus untuk banyak toko adalah Midtrans Partner API, yang
memerlukan perjanjian kemitraan dengan Midtrans.

**Stok dipotong saat pembayaran masuk**, bukan saat QR dibuat. QR yang tidak
dibayar tidak menahan stok. Risikonya kecil tapi nyata: dua kasir menjual
barang terakhir yang sama secara bersamaan bisa membuat stok minus. Sistem
mencatatnya agar bisa ditelusuri, dan transaksi yang sudah dibayar tidak pernah
ditolak.

**Void tidak mengembalikan dana.** Hanya memulihkan stok dan menandai transaksi.
Refund QRIS diproses terpisah di dashboard Midtrans.

**Aktivasi production butuh verifikasi merchant.** Daftar dokumen dan lama
prosesnya ditentukan Midtrans dan tidak dipublikasikan — tanyakan ke support
mereka. Sandbox bisa dipakai gratis dan langsung untuk menguji seluruh alur.
