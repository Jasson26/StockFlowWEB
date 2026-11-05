# StockFlow v5 — Panduan Deploy

Urutannya penting. Selesaikan satu bagian sebelum lanjut ke berikutnya.

Sebelum mulai: buka `index.html` dan klik **Coba Mode Demo**. Semua fitur bisa
dijelajahi dengan data contoh, termasuk simulasi alur QRIS. Berguna untuk
memastikan Anda paham alurnya sebelum menyentuh konfigurasi.

---

## Bagian 1 — Database (10 menit)

### 1.1 Buat project Supabase

1. Daftar di [supabase.com](https://supabase.com) → **New project**
2. Nama: `stockflow`. Region: **Southeast Asia (Singapore)**
3. Simpan password database yang muncul di tempat aman
4. Tunggu project selesai dibuat (1–2 menit)

### 1.2 Jalankan skema

1. **SQL Editor** → **New query**
2. Copy seluruh isi `schema.sql`, paste, klik **Run**

Script ini membuat tabel, RLS policy, fungsi kasir, dan bucket penyimpanan.

> Script ini menghapus tabel lama lebih dulu. Jangan dijalankan ulang di
> database yang sudah berisi transaksi asli.

### 1.3 Matikan konfirmasi email

**Authentication** → **Sign In / Providers** → **Email** → matikan
**Confirm email** → **Save**

Kerjakan ini **sebelum** mendaftar toko. Kalau dibiarkan aktif:

- Pendaftaran tertahan menunggu email
- Link di email mengarah ke `http://localhost:3000` (bawaan Supabase), yang
  menghasilkan **"localhost refused to connect"** kalau Anda tidak menjalankan
  server di sana

Kalau sudah terlanjur: akunnya **sebenarnya sudah aktif** — halaman error itu
muncul setelah verifikasi berhasil, jadi tidak ada yang rusak. Matikan Confirm
email, lalu masuk seperti biasa. Aplikasi akan mendeteksi tokonya belum dibuat
dan menampilkan layar **Selesaikan Pendaftaran** untuk melengkapinya.

> Kalau nanti website sudah dipublish dan Anda ingin memakai fitur lupa
> password, isi juga **Authentication** → **URL Configuration** → **Site URL**
> dengan alamat website Anda. Link reset password memakai alamat itu.

### 1.4 Ambil URL dan key

**Project Settings** (ikon gear kiri bawah) → **API Keys**

Supabase sedang berpindah ke format key baru, jadi yang Anda lihat tergantung
umur project:

| Yang terlihat | Yang dicopy | Bentuknya |
|---|---|---|
| Tab **Publishable and secret API keys** | **Publishable key** | `sb_publishable_...` |
| Tab **Legacy API keys** | **anon public** | `eyJhbGciOi...` (JWT panjang) |

**Keduanya sama fungsinya** untuk aplikasi ini — ambil mana saja yang ada.
Kalau tersedia dua-duanya, pakai yang `sb_publishable_` karena yang legacy akan
dihentikan Supabase akhir 2026.

Jangan ambil **secret key** atau **service_role** — itu untuk server, bukan
browser.

Untuk **Project URL**: **Project Settings** → **Data API** → kolom *Project URL*.
Bisa juga dilihat di tombol **Connect** di atas dashboard.

### 1.5 Isi config

Buka `js/config.js`, isi dua baris paling atas:

```js
const SUPABASE_URL      = 'https://abcdefgh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_xxxxx';   // atau anon key legacy
```

Nama variabelnya tetap `SUPABASE_ANON_KEY` untuk kedua format — tidak perlu
diubah.

Kedua nilai ini **aman** berada di browser dan boleh ikut ter-upload ke GitHub.
Key publik memang dirancang untuk dipublikasikan — yang melindungi data adalah
RLS di database, bukan kerahasiaan key ini.

**Sampai di sini aplikasi sudah bisa dipakai** untuk pembayaran tunai dan
transfer manual. Buka `index.html`, daftar toko, mulai jualan. Bagian 2 dan 3
hanya diperlukan untuk QRIS otomatis.

---

## Bagian 2 — Edge Functions (20 menit)

Diperlukan untuk dua hal: pembayaran QRIS otomatis, dan pembuatan akun karyawan.
Secret key hidup di sini, tidak pernah di browser.

### 2.1 Pasang Supabase CLI

> `npm install -g supabase` **tidak didukung** lagi. Pakai salah satu cara di bawah.

**Windows — lewat Scoop (cara resmi)**

Buka **PowerShell** (bukan Command Prompt). Kalau Scoop belum ada, pasang dulu:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
```

Lalu pasang CLI-nya:

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

**macOS / Linux — lewat Homebrew**

```bash
brew install supabase/tap/supabase
```

**Alternatif lintas platform — lewat npx (kalau Node.js sudah terpasang)**

Dari dalam folder `stockflow-v5`:

```bash
npm i supabase --save-dev
```

Lalu setiap perintah di bawah diawali `npx`, misal `npx supabase login`.

**Verifikasi:** `supabase --version` (atau `npx supabase --version`).
Kalau muncul nomor versi, CLI siap dipakai.

### 2.2 Hubungkan ke project

```bash
supabase login                      # buka browser untuk otorisasi
cd path/ke/stockflow-v5
supabase link --project-ref <PROJECT-REF>
```

`PROJECT-REF` adalah bagian subdomain dari URL project Anda. Untuk
`https://abcdefgh.supabase.co`, ref-nya `abcdefgh`.

### 2.3 Dapatkan kredensial Midtrans

1. Daftar di [dashboard.midtrans.com](https://dashboard.midtrans.com/register)
2. Pastikan toggle kiri atas pada posisi **Sandbox** (mode uji, uang tidak nyata)
3. **Settings** → **Access Keys** → copy **Server Key**

Server Key sandbox berawalan `SB-Mid-server-`.

### 2.4 Isi secret

```bash
supabase secrets set QRIS_EXPIRY_MINUTES='15'
supabase secrets set ALLOWED_ORIGINS='https://USERNAME.github.io'
```

**Kredensial Midtrans tidak lagi diisi di sini.** Sejak versi ini, setiap owner
memasang Server Key miliknya sendiri lewat **Pengaturan → Pembayaran QRIS** di
dalam aplikasi, sehingga dana masuk ke rekening masing-masing toko.

Dua secret di bawah ini **opsional**, hanya sebagai cadangan untuk toko yang
belum memasang key sendiri (biasanya toko Anda sendiri):

```bash
supabase secrets set MIDTRANS_SERVER_KEY='Mid-server-xxxxxxxxxxxx'
supabase secrets set MIDTRANS_IS_PRODUCTION='false'
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, dan `SUPABASE_SERVICE_ROLE_KEY` sudah
tersedia otomatis — tidak perlu diisi manual.

`ALLOWED_ORIGINS` adalah daftar domain yang boleh memanggil fungsi, dipisah
koma. Isi dengan domain website Anda. Untuk uji lokal, tambahkan juga
`http://localhost:5500`. Kalau dibiarkan kosong, semua domain diizinkan —
jangan dibiarkan kosong di produksi.

### 2.5 Deploy

```bash
supabase functions deploy payment-create
supabase functions deploy payment-status
supabase functions deploy create-staff
supabase functions deploy delete-account

# Webhook TANPA verifikasi JWT — Midtrans tidak mengirim token Supabase.
# Keamanannya bertumpu pada verifikasi signature di dalam fungsi.
supabase functions deploy payment-webhook --no-verify-jwt
```

Verifikasi: **Edge Functions** di dashboard harus menampilkan lima fungsi.

### 2.6 Daftarkan webhook di Midtrans

URL webhook Anda:

```
https://<PROJECT-REF>.functions.supabase.co/payment-webhook
```

Di dashboard Midtrans: **Settings** → **Payment** → bagian **Notification URL**
→ kolom **Payment Notification URL** → paste URL di atas → **Update**.

> Menu ini dulu bernama **Configuration**. Midtrans sudah menggantinya jadi
> **Payment**. Kolom *Recurring* dan *Pay Account* di bawahnya tidak dipakai.

### 2.7 Pasang kredensial & aktifkan QRIS

Masuk sebagai owner → **Pengaturan** → **Pembayaran QRIS**:

1. Tempel **Server Key** Midtrans Anda, pilih lingkungan (Sandbox atau Production), **Simpan**
2. Klik **Aktifkan** pada QRIS otomatis

Key yang tersimpan tidak dapat ditampilkan kembali — hanya bisa diganti atau
dihapus. Tabel penyimpanannya sengaja dibuat tanpa izin baca dari aplikasi,
sehingga key hanya terbaca oleh Edge Function di sisi server.

---

## Bagian 3 — Publish website (5 menit)

### GitHub Pages

1. Buat repo baru, misal `stockflow`
2. Upload semua file **kecuali** folder `supabase/`, `test.js`, dan `DEPLOY.md`
   (file-file itu tidak perlu ikut ke web)
3. **Settings** → **Pages** → *Deploy from a branch* → `main` / `(root)` → **Save**

   Halaman depan (`index.html`) adalah landing page. Halaman masuk ada di
   `masuk.html`, dan halaman legal di `privasi.html` serta `ketentuan.html`.
4. Live di `https://USERNAME.github.io/stockflow`
5. Perbarui `ALLOWED_ORIGINS` dengan domain ini, lalu deploy ulang fungsinya

Netlify, Vercel, dan Cloudflare Pages juga bisa — cukup drag-and-drop foldernya.

---

## Uji pembayaran di sandbox

1. Kasir → pilih produk → **Bayar** → **QRIS** → **Tampilkan QR**
2. QR muncul dengan hitung mundur
3. Buka [simulator Midtrans](https://simulator.sandbox.midtrans.com/qris/index)
4. Paste QR string atau scan QR-nya, klik **Pay**
5. Dalam beberapa detik kasir berubah jadi "Pembayaran Diterima" dan stok terpotong

Kalau tidak berubah, lihat bagian Masalah Umum di bawah.

---

## Naik ke produksi (uang sungguhan)

Setelah yakin alurnya benar di sandbox:

1. Lengkapi verifikasi merchant di dashboard Midtrans. Dokumen yang diminta
   biasanya KTP, NPWP, rekening bank, dan data usaha — **daftar persisnya dan
   lama prosesnya tidak dipublikasikan Midtrans, jadi tanyakan langsung ke
   support mereka.** Siapkan waktu beberapa hari kerja.
2. Setelah akun production aktif, ambil **Server Key production** (berawalan
   `Mid-server-`, tanpa `SB-`)
3. Perbarui secret dan deploy ulang:

```bash
supabase secrets set MIDTRANS_SERVER_KEY='Mid-server-xxxxxxxxxxxx'
supabase secrets set MIDTRANS_IS_PRODUCTION='true'
supabase functions deploy payment-create
supabase functions deploy payment-status
supabase functions deploy payment-webhook --no-verify-jwt
```

4. Daftarkan ulang **Payment Notification URL** di **Settings → Payment**
   pada dashboard production (setelan sandbox dan production terpisah)
5. Uji dengan satu transaksi bernilai kecil sebelum dipakai melayani pembeli

Biaya QRIS di Midtrans umumnya sekitar 0,7% per transaksi, tapi **pastikan
tarif terkini di halaman pricing mereka** — angka ini bisa berubah.

---

## Printer struk (opsional)

Tidak perlu deploy apa pun. Printer dihubungkan langsung dari browser:

1. Nyalakan printer, pastikan tidak sedang tersambung ke HP lain
2. Buka situs lewat **HTTPS** (GitHub Pages sudah HTTPS)
3. **Pengaturan → Printer Struk Bluetooth → Hubungkan Printer**
4. Pilih printer dari daftar yang muncul → **Tes Cetak**

Syaratnya printer mendukung **Bluetooth 4.0 / BLE** dan perintah **ESC/POS**.
Printer Bluetooth Classic (SPP) tidak bisa dijangkau browser mana pun.
Tidak tersedia di iPhone, iPad, Safari, dan Firefox.

## Masalah umum

**"Supabase belum dikonfigurasi"**
`js/config.js` belum diisi (langkah 1.4).

**Pendaftaran owner tertahan menunggu email**
Konfirmasi email masih aktif. Matikan di langkah 1.3.

**Klik link konfirmasi email → "localhost refused to connect"**
Normal, dan akun Anda sudah aktif. Supabase mengarahkan ke
`http://localhost:3000` secara bawaan, sedangkan Anda tidak menjalankan server
di sana. Verifikasinya sendiri sudah berhasil sebelum pengalihan itu.
Matikan Confirm email (langkah 1.3), lalu masuk — layar
**Selesaikan Pendaftaran** akan muncul untuk membuat tokonya.

**"Invalid path specified in request URL"**
`SUPABASE_URL` kelebihan garis miring di ujung atau terbawa path.
Versi terbaru `js/config.js` membersihkannya otomatis; pastikan Anda memakai
file yang terbaru.

**"Tidak bisa menghubungi server pembayaran"**
Fungsi belum dideploy, atau domain Anda belum ada di `ALLOWED_ORIGINS`.
Cek log: `supabase functions logs payment-create`

**QR muncul tapi status tidak pernah berubah jadi lunas**
Webhook belum sampai. Periksa berurutan:
1. `supabase functions logs payment-webhook` — ada permintaan masuk?
2. Kalau tidak ada: URL di dashboard Midtrans salah, atau webhook dideploy
   tanpa `--no-verify-jwt` (Midtrans dapat 401)
3. Kalau ada tapi ditolak 403: `MIDTRANS_SERVER_KEY` di secret berbeda dengan
   yang dipakai membuat tagihan — signature jadi tidak cocok
4. Sementara itu, tombol **Periksa Status** di menu Riwayat tetap bisa
   melunasi transaksi secara manual — fungsinya menanyakan status langsung ke
   Midtrans, jadi tidak bergantung pada webhook

**"Gagal membuat akun" saat menambah karyawan**
Fungsi `create-staff` belum dideploy, atau konfirmasi email masih aktif.

**Staff bisa melihat laporan keuangan**
Seharusnya tidak bisa. Pastikan `schema.sql` dijalankan seluruhnya — pembatasan
ini ada di RLS policy, bukan hanya di tampilan.

**Printer tidak muncul saat dihubungkan**
Pastikan printer menyala, tidak sedang terhubung ke perangkat lain, dan
Bluetooth komputer aktif. Kalau tetap tidak muncul, kemungkinan printer hanya
mendukung Bluetooth Classic (SPP) yang tidak dapat diakses browser.

**Tombol Hubungkan Printer tidak bisa diklik**
Browser atau perangkat tidak mendukung Web Bluetooth. Pesan di atas tombol
menjelaskan alasannya. Gunakan Chrome atau Edge di Android, Windows, macOS,
atau Linux.

**Foto produk gagal diunggah**
Supabase → **Storage**, bucket `stockflow` harus ada dan **public**.

---

## Catatan arsitektur yang perlu diketahui

**Satu deployment = satu akun merchant.** Kredensial Midtrans ada di environment
Edge Function, sehingga semua pembayaran QRIS masuk ke rekening pemilik akun
Midtrans tersebut. Ini cocok kalau Anda memakainya untuk toko sendiri.

Kalau nanti ingin UMKM lain memakai StockFlow dengan dana masuk ke rekening
masing-masing, ada dua jalur:

- **QRIS statis per toko** — sudah tersedia di menu Pengaturan. Tiap owner
  mengunggah QR miliknya sendiri, dana langsung ke rekening mereka. Kekurangannya:
  pembeli mengetik nominal sendiri dan pembayaran tidak terkonfirmasi otomatis.
- **Midtrans Partner API** — tiap toko didaftarkan sebagai merchant tersendiri.
  Dana langsung ke mereka dan konfirmasi tetap otomatis, tapi perlu perjanjian
  khusus dengan Midtrans dan pekerjaan integrasi tambahan.

**Stok dipotong saat pembayaran masuk**, bukan saat QR dibuat. Jadi QR yang tidak
dibayar tidak menahan stok. Konsekuensinya: kalau dua kasir menjual barang
terakhir yang sama secara bersamaan, stok bisa minus. Sistem mencatatnya di
riwayat pergerakan stok agar bisa ditelusuri lewat stock opname, dan transaksi
yang sudah dibayar tidak pernah ditolak.

**Void tidak mengembalikan dana.** Void hanya memulihkan stok dan menandai
transaksi. Refund QRIS harus diproses terpisah di dashboard Midtrans.

## Pembaruan v5.3 — karyawan pakai kode, hak owner, bukti barang rusak

1. Supabase → SQL Editor → jalankan `migrasi-03-owner-staff-log.sql` (aman, data tidak hilang).
2. Deploy fungsi baru/terbaru dari folder proyek:

   ```
   supabase functions deploy create-staff
   supabase functions deploy owner-verify
   supabase functions deploy staff-login --no-verify-jwt
   ```
3. Owner buka **Pengguna → + Tambah Karyawan**, isi nama dan username, lalu berikan kode unik yang muncul.
4. Karyawan masuk di halaman Masuk → tab **Karyawan** → username + kode.
