-- ============================================================
-- MIGRASI 03: hak owner, login staff pakai kode, log produk,
--             bukti foto barang rusak
-- ------------------------------------------------------------
-- AMAN DIJALANKAN DI DATABASE YANG SUDAH BERISI DATA:
-- tidak ada tabel yang dibuang; hanya menambah kolom/tabel,
-- mengganti policy, dan membuat fungsi baru. Boleh diulang.
--
-- Cara pakai: Supabase Dashboard > SQL Editor > tempel > Run
-- ============================================================

-- ---------- 1. Kolom baru ----------
alter table profiles        add column if not exists username     text;
alter table stock_movements add column if not exists evidence_url text;

-- Jenis log baru: 'create' (produk dibuat) dan 'edit' (data produk diubah)
alter table stock_movements drop constraint if exists stock_movements_type_check;
alter table stock_movements add constraint stock_movements_type_check
  check (type in ('in','out','damaged','adjust','sale','create','edit'));

-- ---------- 2. Kode login staff ----------
-- Dipisah dari profiles supaya staff lain tidak bisa membaca kode rekannya.
-- Hanya owner toko yang bisa melihat; Edge Function membacanya dengan service_role.
create table if not exists staff_codes (
  profile_id  uuid primary key references profiles(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  username    text not null,
  code        text not null unique,
  created_at  timestamptz not null default now()
);
create index if not exists staff_codes_biz on staff_codes (business_id);
create unique index if not exists staff_codes_biz_user on staff_codes (business_id, lower(username));

alter table staff_codes enable row level security;
drop policy if exists sc_select_owner on staff_codes;
create policy sc_select_owner on staff_codes for select to authenticated
  using (business_id = app_business_id() and app_is_owner());
-- Tidak ada policy insert/update/delete: hanya lewat Edge Function.

-- ---------- 3. Hanya owner yang boleh mengubah data toko ----------
-- Staff tetap bisa MEMBACA produk/kategori (untuk kasir), tapi tidak mengubah.
drop policy if exists cat_all    on categories;
drop policy if exists cat_select on categories;
drop policy if exists cat_write  on categories;
create policy cat_select on categories for select to authenticated
  using (business_id = app_business_id());
create policy cat_write on categories for all to authenticated
  using (business_id = app_business_id() and app_is_owner())
  with check (business_id = app_business_id() and app_is_owner());

drop policy if exists prod_all    on products;
drop policy if exists prod_select on products;
drop policy if exists prod_write  on products;
create policy prod_select on products for select to authenticated
  using (business_id = app_business_id());
create policy prod_write on products for all to authenticated
  using (business_id = app_business_id() and app_is_owner())
  with check (business_id = app_business_id() and app_is_owner());

-- Log stok: semua anggota boleh membaca, hanya owner menulis langsung.
-- Penjualan dan barang rusak dari staff masuk lewat fungsi SECURITY DEFINER.
drop policy if exists mv_insert on stock_movements;
create policy mv_insert on stock_movements for insert to authenticated
  with check (business_id = app_business_id() and app_is_owner());

-- ---------- 4. Catat barang rusak ----------
-- Staff WAJIB melampirkan foto bukti; owner boleh tanpa foto.
create or replace function record_damage(
  p_product_id uuid,
  p_qty        numeric,
  p_note       text default null,
  p_evidence   text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_biz   uuid := app_business_id();
  v_me    uuid := auth.uid();
  v_stock numeric;
  v_name  text;
  v_id    uuid;
begin
  if v_biz is null then raise exception 'Tidak punya akses toko'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'Jumlah harus lebih dari 0'; end if;
  if not app_is_owner() and coalesce(trim(p_evidence), '') = '' then
    raise exception 'Foto bukti wajib dilampirkan';
  end if;

  select stock, name into v_stock, v_name from products
    where id = p_product_id and business_id = v_biz for update;
  if v_stock is null then raise exception 'Produk tidak ditemukan di toko ini'; end if;
  if v_stock < p_qty then
    raise exception 'Stok % tidak cukup (tersedia %)', v_name, v_stock;
  end if;

  update products set stock = stock - p_qty where id = p_product_id;

  insert into stock_movements (business_id, product_id, type, qty, note, evidence_url, user_id)
  values (v_biz, p_product_id, 'damaged', p_qty, nullif(trim(p_note), ''),
          nullif(trim(p_evidence), ''), v_me)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'stock', v_stock - p_qty);
end
$$;

revoke execute on function record_damage(uuid, numeric, text, text) from public, anon;
grant  execute on function record_damage(uuid, numeric, text, text) to authenticated;
