-- ============================================================
-- MIGRASI 04: add-on per produk (topping, extra shot, dsb)
-- ------------------------------------------------------------
-- Daftar add-on disimpan sebagai array JSON di produk:
--   [{"name":"Extra shot","price":5000}, {"name":"Less sugar","price":0}]
-- Saat dijual, add-on digabung ke nama dan harga baris transaksi,
-- jadi fungsi checkout dan stok tidak berubah.
--
-- AMAN: hanya menambah satu kolom. Boleh diulang.
-- Cara pakai: Supabase Dashboard > SQL Editor > tempel > Run
-- ============================================================

alter table products add column if not exists addons jsonb not null default '[]'::jsonb;

alter table products drop constraint if exists products_addons_is_array;
alter table products add constraint products_addons_is_array
  check (jsonb_typeof(addons) = 'array' and jsonb_array_length(addons) <= 20);
