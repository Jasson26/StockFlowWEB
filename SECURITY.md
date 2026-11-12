# Keamanan StockFlow

Ringkasan lapisan keamanan, dari browser sampai database.

## 1. Identitas & sesi
- Login lewat **Supabase Auth**; password tidak pernah disimpan aplikasi.
- **Verifikasi 2 langkah (TOTP)** untuk owner; **wajib** untuk admin platform
  (fungsi admin di database menolak sesi tanpa `aal2`).
- Aturan password: min. 8 karakter, berisi huruf dan angka.
- Karyawan masuk dengan **username + kode unik**; kode tidak pernah dipakai sebagai
  password (server membuat sesi dengan password acak sekali pakai).
- **Batas percobaan**: 8× gagal / 15 menit per IP & username (login karyawan),
  5× / 15 menit per toko (password owner untuk keluar dari mode staff).
- Karyawan tidak bisa keluar tanpa password owner (dicek di server).

## 2. Isolasi data antar toko (Row Level Security)
- Semua tabel memakai RLS berdasarkan `app_business_id()`.
- Staff hanya **membaca** produk/kategori; tulis hanya owner.
- **Hak kolom**: pengguna hanya bisa mengubah `name` di profil, owner hanya kolom
  pengaturan toko (bukan masa aktif/langganan).
- Tabel sensitif (`payment_credentials`, `staff_codes`, `activation_codes`,
  `platform_admins`, `auth_attempts`) tanpa policy baca untuk umum.

## 3. Integritas transaksi
- Transaksi **hanya** lewat fungsi `checkout_cash` / `order_create_pending`
  (tidak ada INSERT langsung ke `orders`).
- **Harga, modal, add-on, dan pajak dihitung ulang di database** dari data produk.
  Browser hanya mengirim id produk, jumlah, nama add-on, dan diskon baris.
- Stok dicek per total produk dan baris produk dikunci (`FOR UPDATE`).
- Transaksi offline memakai `client_ref` unik, jadi kirim ulang tidak membuat data dobel.
- Webhook pembayaran diverifikasi dengan signature SHA-512 Midtrans.
- Void & refund hanya owner, stok dikembalikan otomatis, tercatat di log.

## 4. Langganan
- Toko tidak aktif dikunci oleh **trigger database** (bukan hanya tampilan).
- Kode aktivasi sekali pakai, dibuat dari `gen_random_uuid`.

## 5. Jejak audit
- `audit_log` diisi trigger database untuk produk, kategori, pengaturan, pengguna,
  transaksi (void/status), refund, buka/tutup kasir, pengeluaran.
- Tidak bisa diubah/dihapus dari aplikasi; hanya owner yang bisa membaca.

## 6. Penyimpanan file
- Setiap toko hanya bisa menulis ke folder `<jenis>/<business_id>/`.
- Hanya gambar (JPEG/PNG/WebP/GIF/HEIC), maks. 8 MB.
- Foto bukti barang rusak: staff & owner; QRIS & foto produk: owner.

## 7. Browser
- **Content-Security-Policy**: hanya skrip dari situs sendiri; koneksi hanya ke Supabase;
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`.
- Anti-clickjacking (halaman menolak dibuka di iframe situs lain).
- Semua data dari pengguna di-escape sebelum ditampilkan (`UI.esc`).
- Kunci rahasia (service_role, Server Key Midtrans) **tidak pernah** ada di kode browser;
  diuji otomatis di `test.js`.

## Pengaturan dashboard yang disarankan
- Supabase → Authentication → **Leaked password protection**: aktifkan (paket Pro).
- Supabase → Authentication → Password: minimal 8, wajib huruf & angka.
- `supabase secrets set ALLOWED_ORIGINS=https://<domain-anda>` supaya Edge Function
  hanya menerima permintaan dari situs Anda.
