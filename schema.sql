-- ============================================================
-- STOCKFLOW v5 — Skema aman: Supabase Auth + RLS per toko
-- Jalankan di Supabase: SQL Editor > New query > paste semua > Run
--
-- PERBEDAAN UTAMA DARI v4:
--   * Tidak ada kolom password. Otentikasi lewat Supabase Auth.
--   * profiles.id = auth.users.id (FK). Password di-hash oleh Supabase.
--   * RLS nyata: tiap toko hanya bisa membaca datanya sendiri.
--   * Tabel payments untuk transaksi QRIS via Midtrans.
-- ============================================================

-- Bersihkan versi sebelumnya
drop table if exists audit_log       cascade;
drop table if exists auth_attempts   cascade;
drop table if exists refunds         cascade;
drop table if exists shifts          cascade;
drop table if exists activation_codes cascade;
drop table if exists platform_admins  cascade;
drop table if exists staff_codes     cascade;
drop table if exists payments        cascade;
drop table if exists order_items     cascade;
drop table if exists orders          cascade;
drop table if exists stock_movements cascade;
drop table if exists expenses        cascade;
drop table if exists products        cascade;
drop table if exists categories      cascade;
drop table if exists profiles        cascade;
drop table if exists users           cascade;  -- sisa v4
drop table if exists businesses      cascade;

drop function if exists app_business_id()        cascade;
drop function if exists app_is_owner()           cascade;
drop function if exists setup_owner(text, text)  cascade;
drop function if exists checkout_cash(jsonb, numeric, numeric, numeric, text, text) cascade;
drop function if exists order_create_pending(jsonb, numeric, numeric, text, text)   cascade;
drop function if exists order_settle(text, text, text, jsonb) cascade;
drop function if exists order_mark_failed(text, text)         cascade;
drop function if exists void_order(uuid)                      cascade;

-- ============================================================
-- 1. BUSINESSES
-- ============================================================
create table businesses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  address       text,
  phone         text,
  qris_static_url text,                     -- QRIS statis (fallback, tanpa auto-konfirmasi)
  tax_percent   numeric(5,2) not null default 0,
  currency      text not null default 'IDR',
  receipt_note  text default 'Terima kasih atas kunjungan Anda',
  qris_enabled  boolean not null default false,  -- aktifkan QRIS otomatis via gateway
  created_at    timestamptz not null default now()
);

-- ============================================================
-- 2. PROFILES  (1:1 dengan auth.users — TANPA password)
-- ============================================================
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  business_id uuid not null references businesses(id) on delete cascade,
  name        text not null,
  role        text not null default 'staff' check (role in ('owner','staff')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on profiles (business_id);

-- ============================================================
-- Helper: identitas pemanggil.
-- SECURITY DEFINER agar tidak terjadi rekursi RLS saat policy
-- pada tabel profiles memanggil fungsi yang membaca profiles.
-- ============================================================
create or replace function app_business_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select business_id from profiles where id = auth.uid() and active
$$;

create or replace function app_is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role = 'owner' from profiles where id = auth.uid() and active),
    false)
$$;

revoke execute on function app_business_id() from public;
revoke execute on function app_is_owner()    from public;
grant  execute on function app_business_id() to authenticated;
grant  execute on function app_is_owner()    to authenticated;

-- ============================================================
-- 3. CATEGORIES
-- ============================================================
create table categories (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name        text not null,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index on categories (business_id);

-- ============================================================
-- 4. PRODUCTS
-- ============================================================
create table products (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  name        text not null,
  sku         text,
  barcode     text,
  unit        text not null default 'pcs',
  price       numeric(14,2) not null default 0,
  cost        numeric(14,2) not null default 0,
  stock       numeric(14,2) not null default 0,
  min_stock   numeric(14,2) not null default 0,
  image_url   text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on products (business_id);
create index on products (category_id);
create index on products (business_id, barcode);

-- ============================================================
-- 5. STOCK MOVEMENTS
-- ============================================================
create table stock_movements (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  type        text not null check (type in ('in','out','damaged','adjust','sale')),
  qty         numeric(14,2) not null,
  cost        numeric(14,2) default 0,
  note        text,
  user_id     uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index on stock_movements (business_id, created_at desc);
create index on stock_movements (product_id);

-- ============================================================
-- 6. ORDERS
-- ============================================================
create table orders (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  order_no       text not null,
  user_id        uuid references profiles(id) on delete set null,
  cashier_name   text,
  customer_name  text,
  subtotal       numeric(14,2) not null default 0,
  discount       numeric(14,2) not null default 0,
  tax            numeric(14,2) not null default 0,
  total          numeric(14,2) not null default 0,
  cost_total     numeric(14,2) not null default 0,
  payment_method text not null check (payment_method in ('cash','qris','transfer')),
  paid_amount    numeric(14,2) not null default 0,
  change_amount  numeric(14,2) not null default 0,
  ref_note       text,
  status         text not null default 'paid'
                 check (status in ('pending','paid','void','expired','failed')),
  settled_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index on orders (business_id, created_at desc);
create unique index on orders (business_id, order_no);
create index on orders (status);

-- ============================================================
-- 7. ORDER ITEMS
-- ============================================================
create table order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  product_id  uuid references products(id) on delete set null,
  name        text not null,
  price       numeric(14,2) not null,
  cost        numeric(14,2) not null default 0,
  qty         numeric(14,2) not null,
  subtotal    numeric(14,2) not null
);
create index on order_items (order_id);

-- ============================================================
-- 8. EXPENSES
-- ============================================================
create table expenses (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  category    text not null default 'Lainnya',
  amount      numeric(14,2) not null,
  note        text,
  user_id     uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index on expenses (business_id, created_at desc);

-- ============================================================
-- 9. PAYMENTS  (transaksi gateway — hanya ditulis oleh Edge Function)
-- ============================================================
create table payments (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id) on delete cascade,
  order_id         uuid not null references orders(id) on delete cascade,
  gateway          text not null default 'midtrans',
  gateway_order_id text not null unique,     -- order_id yang dikirim ke Midtrans
  gateway_txn_id   text,                     -- transaction_id dari Midtrans
  method           text not null default 'qris',
  acquirer         text,
  amount           numeric(14,2) not null,
  status           text not null default 'pending'
                   check (status in ('pending','paid','expired','failed','cancelled')),
  qr_url           text,
  issuer           text,                     -- app yang dipakai membayar (gopay/ovo/dst)
  expires_at       timestamptz,
  paid_at          timestamptz,
  raw              jsonb,                    -- payload mentah untuk audit
  created_at       timestamptz not null default now()
);
create index on payments (order_id);
create index on payments (business_id, created_at desc);
create index on payments (gateway_order_id);

-- ============================================================
-- RLS — setiap toko terkunci pada datanya sendiri
-- ============================================================
alter table businesses      enable row level security;
alter table profiles        enable row level security;
alter table categories      enable row level security;
alter table products        enable row level security;
alter table stock_movements enable row level security;
alter table orders          enable row level security;
alter table order_items     enable row level security;
alter table expenses        enable row level security;
alter table payments        enable row level security;

-- ---------- businesses ----------
create policy biz_select on businesses for select to authenticated
  using (id = app_business_id());
create policy biz_update on businesses for update to authenticated
  using (id = app_business_id() and app_is_owner())
  with check (id = app_business_id());

-- ---------- profiles ----------
-- Semua anggota toko boleh melihat daftar rekannya (untuk nama kasir, dll)
create policy prof_select on profiles for select to authenticated
  using (business_id = app_business_id());
-- Ubah nama sendiri
create policy prof_update_self on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- Owner mengelola profil di tokonya
create policy prof_update_owner on profiles for update to authenticated
  using (business_id = app_business_id() and app_is_owner())
  with check (business_id = app_business_id());
create policy prof_delete_owner on profiles for delete to authenticated
  using (business_id = app_business_id() and app_is_owner() and id <> auth.uid());

-- ---------- categories ----------
create policy cat_all on categories for all to authenticated
  using (business_id = app_business_id())
  with check (business_id = app_business_id());

-- ---------- products ----------
create policy prod_all on products for all to authenticated
  using (business_id = app_business_id())
  with check (business_id = app_business_id());

-- ---------- stock_movements ----------
create policy mv_select on stock_movements for select to authenticated
  using (business_id = app_business_id());
create policy mv_insert on stock_movements for insert to authenticated
  with check (business_id = app_business_id());

-- ---------- orders ----------
create policy ord_select on orders for select to authenticated
  using (business_id = app_business_id());
create policy ord_insert on orders for insert to authenticated
  with check (business_id = app_business_id());
create policy ord_update_owner on orders for update to authenticated
  using (business_id = app_business_id() and app_is_owner())
  with check (business_id = app_business_id());

-- ---------- order_items (lewat join ke orders) ----------
create policy oi_select on order_items for select to authenticated
  using (exists (select 1 from orders o
                  where o.id = order_items.order_id
                    and o.business_id = app_business_id()));
create policy oi_insert on order_items for insert to authenticated
  with check (exists (select 1 from orders o
                       where o.id = order_items.order_id
                         and o.business_id = app_business_id()));

-- ---------- expenses (owner saja — data keuangan) ----------
create policy exp_all on expenses for all to authenticated
  using (business_id = app_business_id() and app_is_owner())
  with check (business_id = app_business_id() and app_is_owner());

-- ---------- payments (baca saja dari aplikasi; tulis via Edge Function) ----------
create policy pay_select on payments for select to authenticated
  using (business_id = app_business_id());

-- ============================================================
-- FUNGSI: setup owner baru
-- Dipanggil setelah sign-up Supabase Auth berhasil.
-- ============================================================
create or replace function setup_owner(p_business_name text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_biz uuid;
begin
  if auth.uid() is null then
    raise exception 'Belum terotentikasi';
  end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'Akun ini sudah terhubung ke sebuah toko';
  end if;
  if coalesce(trim(p_business_name), '') = '' then
    raise exception 'Nama toko wajib diisi';
  end if;

  insert into businesses (name) values (trim(p_business_name)) returning id into v_biz;

  insert into profiles (id, business_id, name, role, active)
  values (auth.uid(), v_biz, coalesce(nullif(trim(p_name), ''), 'Pemilik'), 'owner', true);

  -- Kategori tidak dibuat otomatis: tiap toko menentukan sendiri.

  return jsonb_build_object('business_id', v_biz);
end
$$;

grant execute on function setup_owner(text, text) to authenticated;

-- ============================================================
-- Helper internal: nomor invoice harian per toko
-- ============================================================
create or replace function next_order_no(p_biz uuid)
returns text
language sql
volatile
security definer
set search_path = public
as $$
  select 'INV-' || to_char(now() at time zone 'Asia/Jakarta', 'YYYYMMDD') || '-' ||
         lpad(((select count(*) from orders
                 where business_id = p_biz
                   and (created_at at time zone 'Asia/Jakarta')::date
                       = (now() at time zone 'Asia/Jakarta')::date) + 1)::text, 4, '0')
$$;

revoke execute on function next_order_no(uuid) from public;

-- ============================================================
-- FUNGSI: transaksi tunai (langsung lunas)
-- ============================================================
create or replace function checkout_cash(
  p_items    jsonb,      -- [{product_id,name,price,cost,qty}]
  p_discount numeric default 0,
  p_tax      numeric default 0,
  p_paid     numeric default null,
  p_customer text default 'Umum',
  p_method   text default 'cash'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_biz      uuid := app_business_id();
  v_me       uuid := auth.uid();
  v_name     text;
  v_order    uuid;
  v_no       text;
  v_sub      numeric := 0;
  v_cost     numeric := 0;
  v_total    numeric;
  v_paid     numeric;
  v_item     jsonb;
  v_pid      uuid;
  v_qty      numeric;
  v_stock    numeric;
begin
  if v_biz is null then raise exception 'Tidak punya akses toko'; end if;
  -- 'qris' diizinkan untuk QRIS statis (gambar yang diunggah owner): kasir
  -- yang memastikan dana masuk, jadi order langsung lunas. QRIS otomatis
  -- lewat Midtrans tetap memakai checkout_qris + webhook.
  if p_method not in ('cash','transfer','qris') then
    raise exception 'Metode % tidak boleh lewat fungsi ini', p_method;
  end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'Keranjang kosong'; end if;

  select name into v_name from profiles where id = v_me;

  -- Validasi stok & hitung total
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pid := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    if v_qty <= 0 then raise exception 'Jumlah harus lebih dari 0'; end if;

    select stock into v_stock from products
      where id = v_pid and business_id = v_biz for update;
    if v_stock is null then raise exception 'Produk tidak ditemukan di toko ini'; end if;
    if v_stock < v_qty then
      raise exception 'Stok % tidak cukup (tersedia %)', v_item->>'name', v_stock;
    end if;

    v_sub  := v_sub  + (v_item->>'price')::numeric * v_qty;
    v_cost := v_cost + coalesce((v_item->>'cost')::numeric, 0) * v_qty;
  end loop;

  p_discount := least(greatest(coalesce(p_discount, 0), 0), v_sub);
  p_tax      := greatest(coalesce(p_tax, 0), 0);
  v_total    := v_sub - p_discount + p_tax;
  v_paid     := coalesce(p_paid, v_total);

  if v_paid < v_total then raise exception 'Uang diterima kurang dari total'; end if;

  v_no := next_order_no(v_biz);

  insert into orders (business_id, order_no, user_id, cashier_name, customer_name,
                      subtotal, discount, tax, total, cost_total,
                      payment_method, paid_amount, change_amount, status, settled_at)
  values (v_biz, v_no, v_me, v_name, coalesce(nullif(trim(p_customer),''), 'Umum'),
          v_sub, p_discount, p_tax, v_total, v_cost,
          p_method, v_paid, v_paid - v_total, 'paid', now())
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pid := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;

    insert into order_items (order_id, product_id, name, price, cost, qty, subtotal)
    values (v_order, v_pid, v_item->>'name', (v_item->>'price')::numeric,
            coalesce((v_item->>'cost')::numeric, 0), v_qty,
            (v_item->>'price')::numeric * v_qty);

    update products set stock = stock - v_qty where id = v_pid;

    insert into stock_movements (business_id, product_id, type, qty, note, user_id)
    values (v_biz, v_pid, 'sale', v_qty, 'Penjualan ' || v_no, v_me);
  end loop;

  return jsonb_build_object(
    'id', v_order, 'order_no', v_no, 'subtotal', v_sub,
    'discount', p_discount, 'tax', p_tax, 'total', v_total,
    'paid_amount', v_paid, 'change_amount', v_paid - v_total, 'status', 'paid');
end
$$;

grant execute on function checkout_cash(jsonb, numeric, numeric, numeric, text, text) to authenticated;

-- ============================================================
-- FUNGSI: buat order PENDING untuk pembayaran QRIS
-- Stok BELUM dipotong — baru dipotong saat pembayaran masuk.
-- ============================================================
create or replace function order_create_pending(
  p_items    jsonb,
  p_discount numeric default 0,
  p_tax      numeric default 0,
  p_customer text default 'Umum',
  p_method   text default 'qris'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_biz   uuid := app_business_id();
  v_me    uuid := auth.uid();
  v_name  text;
  v_order uuid;
  v_no    text;
  v_sub   numeric := 0;
  v_cost  numeric := 0;
  v_total numeric;
  v_item  jsonb;
  v_pid   uuid;
  v_qty   numeric;
  v_stock numeric;
begin
  if v_biz is null then raise exception 'Tidak punya akses toko'; end if;
  if p_method <> 'qris' then raise exception 'Metode tidak didukung di sini'; end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'Keranjang kosong'; end if;

  select name into v_name from profiles where id = v_me;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_pid := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    if v_qty <= 0 then raise exception 'Jumlah harus lebih dari 0'; end if;

    select stock into v_stock from products where id = v_pid and business_id = v_biz;
    if v_stock is null then raise exception 'Produk tidak ditemukan di toko ini'; end if;
    if v_stock < v_qty then
      raise exception 'Stok % tidak cukup (tersedia %)', v_item->>'name', v_stock;
    end if;

    v_sub  := v_sub  + (v_item->>'price')::numeric * v_qty;
    v_cost := v_cost + coalesce((v_item->>'cost')::numeric, 0) * v_qty;
  end loop;

  p_discount := least(greatest(coalesce(p_discount, 0), 0), v_sub);
  p_tax      := greatest(coalesce(p_tax, 0), 0);
  v_total    := v_sub - p_discount + p_tax;

  if v_total < 1 then raise exception 'Total minimal Rp 1 untuk pembayaran QRIS'; end if;

  v_no := next_order_no(v_biz);

  insert into orders (business_id, order_no, user_id, cashier_name, customer_name,
                      subtotal, discount, tax, total, cost_total,
                      payment_method, paid_amount, change_amount, status)
  values (v_biz, v_no, v_me, v_name, coalesce(nullif(trim(p_customer),''), 'Umum'),
          v_sub, p_discount, p_tax, v_total, v_cost,
          'qris', 0, 0, 'pending')
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into order_items (order_id, product_id, name, price, cost, qty, subtotal)
    values (v_order, (v_item->>'product_id')::uuid, v_item->>'name',
            (v_item->>'price')::numeric, coalesce((v_item->>'cost')::numeric, 0),
            (v_item->>'qty')::numeric,
            (v_item->>'price')::numeric * (v_item->>'qty')::numeric);
  end loop;

  return jsonb_build_object(
    'id', v_order, 'order_no', v_no, 'business_id', v_biz,
    'subtotal', v_sub, 'discount', p_discount, 'tax', p_tax, 'total', v_total);
end
$$;

grant execute on function order_create_pending(jsonb, numeric, numeric, text, text) to authenticated;

-- ============================================================
-- FUNGSI: pelunasan dari webhook gateway
-- Dipanggil HANYA oleh Edge Function dengan service_role.
-- Idempotent: aman dipanggil berulang untuk notifikasi yang sama.
-- ============================================================
create or replace function order_settle(
  p_gateway_order_id text,
  p_txn_id           text,
  p_issuer           text,
  p_raw              jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay   payments;
  v_order orders;
  v_item  record;
  v_short numeric := 0;
begin
  select * into v_pay from payments
    where gateway_order_id = p_gateway_order_id for update;
  if v_pay.id is null then
    return jsonb_build_object('ok', false, 'reason', 'payment tidak ditemukan');
  end if;

  -- Sudah pernah dilunasi -> tidak diproses ulang
  if v_pay.status = 'paid' then
    return jsonb_build_object('ok', true, 'already', true, 'order_id', v_pay.order_id);
  end if;

  select * into v_order from orders where id = v_pay.order_id for update;
  if v_order.id is null then
    return jsonb_build_object('ok', false, 'reason', 'order tidak ditemukan');
  end if;

  update payments set
    status = 'paid', paid_at = now(), gateway_txn_id = coalesce(p_txn_id, gateway_txn_id),
    issuer = coalesce(p_issuer, issuer), raw = coalesce(p_raw, raw)
  where id = v_pay.id;

  -- Order mungkin sudah dilunasi lewat jalur lain (mis. cek status manual)
  if v_order.status = 'paid' then
    return jsonb_build_object('ok', true, 'already', true, 'order_id', v_order.id);
  end if;

  update orders set
    status = 'paid', paid_amount = v_order.total, change_amount = 0,
    settled_at = now(), ref_note = coalesce(p_issuer, ref_note)
  where id = v_order.id;

  -- Potong stok sekarang. Uang sudah diterima, jadi transaksi tidak
  -- boleh ditolak walau stok tidak cukup — kekurangan dicatat sebagai
  -- selisih agar bisa ditelusuri lewat stock opname.
  for v_item in
    select product_id, qty, name from order_items where order_id = v_order.id
  loop
    if v_item.product_id is not null then
      update products set stock = stock - v_item.qty where id = v_item.product_id
        returning greatest(-stock, 0) into v_short;

      insert into stock_movements (business_id, product_id, type, qty, note, user_id)
      values (v_order.business_id, v_item.product_id, 'sale', v_item.qty,
              'Penjualan ' || v_order.order_no ||
              case when v_short > 0 then ' (stok minus ' || v_short || ')' else '' end,
              v_order.user_id);
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'order_id', v_order.id, 'order_no', v_order.order_no);
end
$$;

revoke execute on function order_settle(text, text, text, jsonb) from public, anon, authenticated;

-- ============================================================
-- FUNGSI: tandai gagal / kedaluwarsa (dari webhook atau cek status)
-- ============================================================
create or replace function order_mark_failed(
  p_gateway_order_id text,
  p_status           text      -- 'expired' | 'failed' | 'cancelled'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_pay payments;
begin
  select * into v_pay from payments
    where gateway_order_id = p_gateway_order_id for update;
  if v_pay.id is null then
    return jsonb_build_object('ok', false, 'reason', 'payment tidak ditemukan');
  end if;
  if v_pay.status = 'paid' then
    return jsonb_build_object('ok', false, 'reason', 'sudah lunas, tidak diubah');
  end if;

  update payments set status = p_status, raw = coalesce(raw, '{}'::jsonb)
    where id = v_pay.id;

  update orders set status = case when p_status = 'cancelled' then 'failed' else p_status end
    where id = v_pay.order_id and status = 'pending';

  return jsonb_build_object('ok', true, 'order_id', v_pay.order_id);
end
$$;

revoke execute on function order_mark_failed(text, text) from public, anon, authenticated;

-- ============================================================
-- FUNGSI: batalkan order pending dari kasir
-- ============================================================
create or replace function order_cancel_pending(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_biz uuid := app_business_id(); v_st text;
begin
  select status into v_st from orders
    where id = p_order_id and business_id = v_biz for update;
  if v_st is null then raise exception 'Order tidak ditemukan'; end if;
  if v_st <> 'pending' then raise exception 'Order sudah %', v_st; end if;

  update orders   set status = 'failed'    where id = p_order_id;
  update payments set status = 'cancelled' where order_id = p_order_id and status = 'pending';

  return jsonb_build_object('ok', true);
end
$$;

grant execute on function order_cancel_pending(uuid) to authenticated;

-- ============================================================
-- FUNGSI: void transaksi yang sudah lunas (owner saja)
-- ============================================================
create or replace function void_order(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_biz  uuid := app_business_id();
  v_item record;
  v_st   text;
begin
  if not app_is_owner() then raise exception 'Hanya owner yang boleh void'; end if;

  select status into v_st from orders
    where id = p_order_id and business_id = v_biz for update;
  if v_st is null then raise exception 'Order tidak ditemukan'; end if;
  if v_st <> 'paid' then raise exception 'Hanya order lunas yang bisa divoid'; end if;

  for v_item in select product_id, qty from order_items where order_id = p_order_id loop
    if v_item.product_id is not null then
      update products set stock = stock + v_item.qty where id = v_item.product_id;
      insert into stock_movements (business_id, product_id, type, qty, note, user_id)
      values (v_biz, v_item.product_id, 'in', v_item.qty, 'Void transaksi', auth.uid());
    end if;
  end loop;

  update orders set status = 'void' where id = p_order_id;
  return jsonb_build_object('ok', true);
end
$$;

grant execute on function void_order(uuid) to authenticated;

-- ============================================================
-- STORAGE: bucket foto produk & QRIS statis
-- ============================================================
insert into storage.buckets (id, name, public)
values ('stockflow', 'stockflow', true)
on conflict (id) do update set public = true;

drop policy if exists "stockflow read"   on storage.objects;
drop policy if exists "stockflow write"  on storage.objects;
drop policy if exists "stockflow update" on storage.objects;
drop policy if exists "stockflow delete" on storage.objects;

-- Baca: publik (agar <img src> bekerja). Tulis: hanya pengguna terotentikasi.
create policy "stockflow read"   on storage.objects for select
  using (bucket_id = 'stockflow');
create policy "stockflow write"  on storage.objects for insert to authenticated
  with check (bucket_id = 'stockflow');
create policy "stockflow update" on storage.objects for update to authenticated
  using (bucket_id = 'stockflow');
create policy "stockflow delete" on storage.objects for delete to authenticated
  using (bucket_id = 'stockflow');

-- ============================================================
-- TAMBAHAN v5.1 — Kredensial pembayaran per toko
--
-- Tiap owner memasang Server Key Midtrans miliknya sendiri,
-- sehingga dana masuk ke rekening mereka, bukan ke pemilik
-- deployment.
--
-- Keamanan: tabel ini bisa DITULIS owner tapi TIDAK BISA DIBACA
-- dari aplikasi. Tidak ada policy SELECT sama sekali, jadi key
-- hanya terbaca oleh service_role di dalam Edge Function.
-- Untuk kebutuhan tampilan, 4 karakter terakhir disimpan terpisah
-- di kolom yang memang boleh dibaca.
-- ============================================================

drop table if exists payment_credentials cascade;

create table payment_credentials (
  business_id   uuid primary key references businesses(id) on delete cascade,
  provider      text not null default 'midtrans',
  server_key    text not null,                 -- rahasia, tidak pernah dikirim ke klien
  is_production boolean not null default false,
  key_hint      text,                          -- 4 karakter terakhir, aman ditampilkan
  updated_at    timestamptz not null default now(),
  updated_by    uuid references profiles(id) on delete set null
);

alter table payment_credentials enable row level security;

-- Owner boleh memasang dan mengubah, TIDAK boleh membaca kembali.
create policy pc_insert on payment_credentials for insert to authenticated
  with check (business_id = app_business_id() and app_is_owner());
create policy pc_update on payment_credentials for update to authenticated
  using (business_id = app_business_id() and app_is_owner())
  with check (business_id = app_business_id());
create policy pc_delete on payment_credentials for delete to authenticated
  using (business_id = app_business_id() and app_is_owner());
-- Sengaja TIDAK ada policy SELECT.

-- Status pemasangan untuk ditampilkan di UI (tanpa membocorkan key)
create or replace function payment_credential_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select jsonb_build_object(
       'configured', true,
       'provider', provider,
       'is_production', is_production,
       'key_hint', key_hint,
       'updated_at', updated_at)
     from payment_credentials where business_id = app_business_id()),
    jsonb_build_object('configured', false))
$$;

grant execute on function payment_credential_status() to authenticated;

-- ============================================================
-- Hapus akun & seluruh data toko (hak pengguna, UU PDP)
-- Hanya owner. Menghapus businesses -> seluruh data ikut terhapus
-- lewat ON DELETE CASCADE. Akun Auth dihapus oleh Edge Function.
-- ============================================================
create or replace function delete_my_business()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_biz uuid := app_business_id();
  v_ids uuid[];
begin
  if v_biz is null then raise exception 'Tidak punya akses toko'; end if;
  if not app_is_owner() then raise exception 'Hanya owner yang boleh menghapus toko'; end if;

  select array_agg(id) into v_ids from profiles where business_id = v_biz;

  delete from businesses where id = v_biz;

  return jsonb_build_object('ok', true, 'user_ids', to_jsonb(v_ids));
end
$$;

grant execute on function delete_my_business() to authenticated;

-- ============================================================
-- Export seluruh data toko (hak portabilitas data, UU PDP)
-- ============================================================
create or replace function export_my_data()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'exported_at', now(),
    'business',    (select to_jsonb(b) - 'id' from businesses b where b.id = app_business_id()),
    'users',       (select coalesce(jsonb_agg(jsonb_build_object(
                      'name', p.name, 'role', p.role, 'active', p.active,
                      'created_at', p.created_at)), '[]'::jsonb)
                    from profiles p where p.business_id = app_business_id()),
    'categories',  (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
                    from categories c where c.business_id = app_business_id()),
    'products',    (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
                    from products p where p.business_id = app_business_id()),
    'orders',      (select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb)
                    from orders o where o.business_id = app_business_id()),
    'order_items', (select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb)
                    from order_items i
                    where exists (select 1 from orders o
                                  where o.id = i.order_id and o.business_id = app_business_id())),
    'stock_movements', (select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb)
                        from stock_movements m where m.business_id = app_business_id()),
    'expenses',    (select case when app_is_owner()
                      then coalesce((select jsonb_agg(to_jsonb(e)) from expenses e
                                     where e.business_id = app_business_id()), '[]'::jsonb)
                      else '[]'::jsonb end)
  )
$$;

grant execute on function export_my_data() to authenticated;

-- ============================================================
-- TAMBAHAN v5.3 (sama dengan migrasi-03-owner-staff-log.sql)
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

-- ============================================================
-- TAMBAHAN v5.4 (sama dengan migrasi-04-addon.sql)
-- ============================================================
alter table products add column if not exists addons jsonb not null default '[]'::jsonb;

alter table products drop constraint if exists products_addons_is_array;
alter table products add constraint products_addons_is_array
  check (jsonb_typeof(addons) = 'array' and jsonb_array_length(addons) <= 20);

-- ============================================================
-- TAMBAHAN v5.5 (sama dengan migrasi-05-langganan.sql)
-- ============================================================
-- ---------- 1. Masa aktif toko ----------
alter table businesses add column if not exists active_until timestamptz;          -- NULL = permanen
alter table businesses add column if not exists suspended    boolean not null default false;

-- ---------- 2. Admin platform ----------
create table if not exists platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table platform_admins enable row level security;
-- Tanpa policy: tidak bisa dibaca/ditulis dari aplikasi, hanya lewat fungsi di bawah.

insert into platform_admins (user_id)
select id from auth.users order by created_at limit 1
on conflict do nothing;

create or replace function is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
$$;
revoke execute on function is_platform_admin() from public, anon;
grant  execute on function is_platform_admin() to authenticated;

-- ---------- 3. Kode aktivasi ----------
create table if not exists activation_codes (
  code        text primary key,
  days        int check (days is null or days > 0),   -- NULL = permanen
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  used_by     uuid references businesses(id) on delete set null,
  used_at     timestamptz
);
alter table activation_codes enable row level security;
-- Tanpa policy: hanya lewat fungsi.

-- Kode acak 8 karakter tanpa huruf/angka mirip, format SF-XXXX-XXXX
create or replace function gen_activation_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  v_abc text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_raw bytea := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_out text := '';
  i     int;
begin
  for i in 0..7 loop
    v_out := v_out || substr(v_abc, (get_byte(v_raw, i) % length(v_abc)) + 1, 1);
  end loop;
  return 'SF-' || substr(v_out, 1, 4) || '-' || substr(v_out, 5, 4);
end $$;
revoke execute on function gen_activation_code() from public, anon, authenticated;

-- Normalisasi: huruf besar, tanpa spasi/strip, awalan "SF" opsional
create or replace function norm_code(p text)
returns text language sql immutable as $$
  select regexp_replace(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '^SF(?=.{8}$)', '')
$$;

-- Cek kode sebelum mendaftar (boleh dipanggil tanpa login)
create or replace function check_activation_code(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r activation_codes;
begin
  select * into r from activation_codes
   where norm_code(code) = norm_code(p_code) and used_at is null;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'days', r.days);
end $$;
grant execute on function check_activation_code(text) to anon, authenticated;

-- ---------- 4. Buat toko: sekarang WAJIB pakai kode ----------
drop function if exists setup_owner(text, text);

create or replace function setup_owner(p_business_name text, p_name text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_biz  uuid;
  r      activation_codes;
begin
  if auth.uid() is null then raise exception 'Belum terotentikasi'; end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'Akun ini sudah terhubung ke sebuah toko';
  end if;
  if coalesce(trim(p_business_name), '') = '' then raise exception 'Nama toko wajib diisi'; end if;

  select * into r from activation_codes
   where norm_code(code) = norm_code(p_code) and used_at is null
   for update;
  if not found then
    raise exception 'Kode aktivasi tidak valid atau sudah dipakai. Hubungi admin via WhatsApp.';
  end if;

  insert into businesses (name, active_until)
  values (trim(p_business_name),
          case when r.days is null then null else now() + make_interval(days => r.days) end)
  returning id into v_biz;

  insert into profiles (id, business_id, name, role, active)
  values (auth.uid(), v_biz, coalesce(nullif(trim(p_name), ''), 'Pemilik'), 'owner', true);

  update activation_codes set used_by = v_biz, used_at = now() where code = r.code;

  return jsonb_build_object('business_id', v_biz);
end $$;
revoke execute on function setup_owner(text, text, text) from public, anon;
grant  execute on function setup_owner(text, text, text) to authenticated;

-- ---------- 5. Kunci toko yang tidak aktif ----------
create or replace function business_is_active(p_biz uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select not suspended and (active_until is null or active_until > now())
       from businesses where id = p_biz),
    false)
$$;
grant execute on function business_is_active(uuid) to authenticated;

-- Dipasang di tabel yang diubah aplikasi. Operasi dari server (webhook,
-- Edge Function: auth.uid() kosong) tidak diblokir supaya pembayaran QRIS
-- yang sudah dimulai tetap bisa diselesaikan.
create or replace function enforce_subscription()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_biz uuid;
begin
  if auth.uid() is null or is_platform_admin() then
    return coalesce(new, old);
  end if;
  v_biz := coalesce(new.business_id, old.business_id);
  if v_biz is not null and not business_is_active(v_biz) then
    raise exception 'Langganan toko tidak aktif. Perpanjang via WhatsApp untuk melanjutkan.';
  end if;
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['orders','products','categories','stock_movements','expenses'] loop
    execute format('drop trigger if exists trg_subscription on %I', t);
    execute format('create trigger trg_subscription before insert or update on %I
                    for each row execute function enforce_subscription()', t);
  end loop;
end $$;

-- ---------- 6. Fungsi panel admin ----------
create or replace function admin_list_businesses()
returns table (
  id uuid, name text, owner_name text, owner_email text, phone text,
  created_at timestamptz, active_until timestamptz, suspended boolean,
  products bigint, orders_30d bigint, last_order timestamptz, staff bigint
) language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Khusus admin'; end if;
  return query
  select b.id, b.name,
         (select p.name from profiles p where p.business_id = b.id and p.role = 'owner' order by p.created_at limit 1),
         (select u.email::text from profiles p join auth.users u on u.id = p.id
           where p.business_id = b.id and p.role = 'owner' order by p.created_at limit 1),
         b.phone, b.created_at, b.active_until, b.suspended,
         (select count(*) from products x where x.business_id = b.id),
         (select count(*) from orders o where o.business_id = b.id and o.status = 'paid' and o.created_at > now() - interval '30 days'),
         (select max(o.created_at) from orders o where o.business_id = b.id),
         (select count(*) from profiles p where p.business_id = b.id and p.role = 'staff')
    from businesses b
   order by b.created_at desc;
end $$;

create or replace function admin_list_codes()
returns table (code text, days int, note text, created_at timestamptz, used_at timestamptz, used_by_name text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Khusus admin'; end if;
  return query
  select c.code, c.days, c.note, c.created_at, c.used_at, b.name
    from activation_codes c left join businesses b on b.id = c.used_by
   order by c.created_at desc limit 300;
end $$;

create or replace function admin_create_code(p_days int default null, p_note text default null)
returns text language plpgsql volatile security definer set search_path = public as $$
declare v text; i int;
begin
  if not is_platform_admin() then raise exception 'Khusus admin'; end if;
  if p_days is not null and p_days <= 0 then raise exception 'Durasi tidak valid'; end if;
  for i in 1..5 loop
    v := gen_activation_code();
    begin
      insert into activation_codes (code, days, note, created_by)
      values (v, p_days, nullif(trim(p_note), ''), auth.uid());
      return v;
    exception when unique_violation then
      null;  -- sangat jarang; coba lagi
    end;
  end loop;
  raise exception 'Gagal membuat kode, coba lagi';
end $$;

create or replace function admin_delete_code(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_platform_admin() then raise exception 'Khusus admin'; end if;
  delete from activation_codes where code = p_code and used_at is null;  -- kode terpakai tetap disimpan sebagai riwayat
end $$;

-- p_add_days: tambah hari dari tanggal habis (atau dari sekarang bila sudah lewat)
-- p_permanent: true = jadikan permanen
-- p_suspended: true/false = matikan/aktifkan; NULL = tidak diubah
create or replace function admin_update_business(
  p_id uuid, p_add_days int default null, p_permanent boolean default null, p_suspended boolean default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare b businesses;
begin
  if not is_platform_admin() then raise exception 'Khusus admin'; end if;
  select * into b from businesses where id = p_id for update;
  if not found then raise exception 'Toko tidak ditemukan'; end if;

  if p_permanent then
    update businesses set active_until = null where id = p_id;
  elsif p_add_days is not null then
    update businesses
       set active_until = greatest(coalesce(active_until, now()), now()) + make_interval(days => p_add_days)
     where id = p_id;
  end if;
  if p_suspended is not null then
    update businesses set suspended = p_suspended where id = p_id;
  end if;

  select * into b from businesses where id = p_id;
  return jsonb_build_object('active_until', b.active_until, 'suspended', b.suspended);
end $$;

revoke execute on function admin_list_businesses()                       from public, anon;
revoke execute on function admin_list_codes()                            from public, anon;
revoke execute on function admin_create_code(int, text)                  from public, anon;
revoke execute on function admin_delete_code(text)                       from public, anon;
revoke execute on function admin_update_business(uuid, int, boolean, boolean) from public, anon;
grant  execute on function admin_list_businesses()                       to authenticated;
grant  execute on function admin_list_codes()                            to authenticated;
grant  execute on function admin_create_code(int, text)                  to authenticated;
grant  execute on function admin_delete_code(text)                       to authenticated;
grant  execute on function admin_update_business(uuid, int, boolean, boolean) to authenticated;

-- ============================================================
-- TAMBAHAN v5.6 (sama dengan migrasi-06-keamanan-shift-refund.sql)
-- ============================================================

-- ============================================================
-- A. HAK KOLOM — hanya kolom tertentu yang boleh diubah dari aplikasi
-- ============================================================

-- profiles: pengguna hanya boleh mengganti NAMA. Peran, toko, status aktif
-- hanya lewat Edge Function create-staff (service_role).
revoke update on profiles from authenticated, anon;
grant  update (name) on profiles to authenticated;

-- businesses: owner hanya boleh mengubah pengaturan toko,
-- BUKAN masa aktif / status langganan.
revoke update on businesses from authenticated, anon;
grant  update (name, address, phone, qris_static_url, tax_percent, receipt_note, qris_enabled)
  on businesses to authenticated;

-- Tabel baru di masa depan pun tidak otomatis terbuka untuk anon
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke execute on functions from public, anon;


-- ============================================================
-- B. TRANSAKSI HANYA LEWAT FUNGSI KASIR
-- ============================================================
drop policy if exists ord_insert       on orders;
drop policy if exists ord_update_owner on orders;
drop policy if exists oi_insert        on order_items;
-- Tidak ada lagi INSERT/UPDATE langsung ke orders & order_items dari aplikasi.
-- checkout_cash / order_create_pending / void_order / refund_items
-- (SECURITY DEFINER) yang menulisnya, setelah memeriksa semua aturan.


-- ============================================================
-- C. BATASAN DATA (NOT VALID = data lama tidak diperiksa ulang)
-- ============================================================
do $$ begin
  alter table products add constraint products_price_nonneg check (price >= 0 and cost >= 0 and min_stock >= 0) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table products add constraint products_name_len check (char_length(name) between 1 and 120) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table businesses add constraint biz_tax_range check (tax_percent between 0 and 100) not valid;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table expenses add constraint exp_amount_pos check (amount > 0) not valid;
exception when duplicate_object then null; end $$;


-- ============================================================
-- D. SHIFT KASIR (buka / tutup kasir)
-- ============================================================
create table if not exists shifts (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  user_id       uuid references profiles(id) on delete set null,
  user_name     text,
  opened_at     timestamptz not null default now(),
  opening_cash  numeric(14,2) not null default 0 check (opening_cash >= 0),
  closed_at     timestamptz,
  closing_cash  numeric(14,2),
  expected_cash numeric(14,2),
  cash_sales    numeric(14,2),
  qris_sales    numeric(14,2),
  cash_refunds  numeric(14,2),
  tx_count      int,
  note          text
);
create index if not exists shifts_biz on shifts (business_id, opened_at desc);
create unique index if not exists shifts_one_open on shifts (user_id) where closed_at is null;
alter table shifts enable row level security;
drop policy if exists sh_select on shifts;
-- Owner melihat semua shift; staff hanya shift miliknya
create policy sh_select on shifts for select to authenticated
  using (business_id = app_business_id() and (app_is_owner() or user_id = auth.uid()));

alter table orders add column if not exists shift_id   uuid references shifts(id) on delete set null;
alter table orders add column if not exists client_ref text;   -- id dari perangkat (transaksi offline) supaya tidak dobel
create unique index if not exists orders_client_ref on orders (business_id, client_ref) where client_ref is not null;

create or replace function my_open_shift()
returns uuid language sql stable security definer set search_path = public as $$
  select id from shifts where user_id = auth.uid() and closed_at is null limit 1
$$;

create or replace function shift_open(p_cash numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_biz uuid := app_business_id(); v_id uuid; v_name text;
begin
  if v_biz is null then raise exception 'Tidak punya akses toko'; end if;
  if not business_is_active(v_biz) then raise exception 'Langganan toko tidak aktif'; end if;
  if my_open_shift() is not null then raise exception 'Kasir sudah dibuka'; end if;
  if coalesce(p_cash, 0) < 0 then raise exception 'Kas awal tidak boleh negatif'; end if;
  select name into v_name from profiles where id = auth.uid();
  insert into shifts (business_id, user_id, user_name, opening_cash)
  values (v_biz, auth.uid(), v_name, coalesce(p_cash, 0)) returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- Ringkasan shift berjalan (dipakai layar tutup kasir)
create or replace function shift_summary(p_shift uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s shifts; v_cash numeric; v_qris numeric; v_ref numeric; v_n int;
begin
  select * into s from shifts
   where id = coalesce(p_shift, my_open_shift()) and business_id = app_business_id()
     and (app_is_owner() or user_id = auth.uid());
  if not found then return null; end if;

  select coalesce(sum(total) filter (where payment_method = 'cash'), 0),
         coalesce(sum(total) filter (where payment_method = 'qris'), 0),
         count(*)
    into v_cash, v_qris, v_n
    from orders where shift_id = s.id and status = 'paid';
  select coalesce(sum(amount), 0) into v_ref from refunds where shift_id = s.id and method = 'cash';

  return jsonb_build_object(
    'id', s.id, 'user_name', s.user_name, 'opened_at', s.opened_at, 'closed_at', s.closed_at,
    'opening_cash', s.opening_cash, 'cash_sales', v_cash, 'qris_sales', v_qris,
    'cash_refunds', v_ref, 'tx_count', v_n,
    'expected_cash', s.opening_cash + v_cash - v_ref,
    'closing_cash', s.closing_cash, 'note', s.note);
end $$;

create or replace function shift_close(p_cash numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := my_open_shift(); j jsonb;
begin
  if v_id is null then raise exception 'Tidak ada kasir yang sedang dibuka'; end if;
  if coalesce(p_cash, -1) < 0 then raise exception 'Isi jumlah uang di laci'; end if;
  j := shift_summary(v_id);
  update shifts set
    closed_at = now(), closing_cash = p_cash,
    expected_cash = (j->>'expected_cash')::numeric,
    cash_sales = (j->>'cash_sales')::numeric, qris_sales = (j->>'qris_sales')::numeric,
    cash_refunds = (j->>'cash_refunds')::numeric, tx_count = (j->>'tx_count')::int,
    note = nullif(trim(p_note), '')
  where id = v_id;
  return shift_summary(v_id) || jsonb_build_object('closing_cash', p_cash,
    'difference', p_cash - (j->>'expected_cash')::numeric);
end $$;


-- ============================================================
-- E. KASIR: harga, modal, add-on, pajak DIHITUNG SERVER
-- ------------------------------------------------------------
-- Dari browser hanya diterima: product_id, qty, nama add-on, diskon baris.
-- ============================================================
alter table order_items add column if not exists discount     numeric(14,2) not null default 0;
alter table order_items add column if not exists refunded_qty numeric(14,2) not null default 0;

-- Hitung baris keranjang dari data produk di database
create or replace function price_cart(p_biz uuid, p_items jsonb)
returns table (product_id uuid, name text, price numeric, cost numeric, qty numeric, discount numeric, subtotal numeric)
language plpgsql stable security definer set search_path = public as $$
declare e jsonb; p products; v_add numeric; v_names text[]; a jsonb; n text; v_disc numeric; v_qty numeric;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Keranjang kosong';
  end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'Terlalu banyak baris'; end if;

  for e in select * from jsonb_array_elements(p_items) loop
    v_qty := (e->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty > 10000 then raise exception 'Jumlah tidak valid'; end if;

    select * into p from products x where x.id = (e->>'product_id')::uuid and x.business_id = p_biz and x.active;
    if not found then raise exception 'Produk tidak ditemukan di toko ini'; end if;

    v_add := 0; v_names := '{}';
    if jsonb_typeof(e->'addons') = 'array' then
      for n in select jsonb_array_elements_text(e->'addons') loop
        a := null;
        select x into a from jsonb_array_elements(coalesce(p.addons, '[]'::jsonb)) x where x->>'name' = n limit 1;
        if a is null then raise exception 'Add-on "%" tidak ada di %', n, p.name; end if;
        v_add := v_add + coalesce((a->>'price')::numeric, 0);
        v_names := v_names || n;
      end loop;
    end if;

    v_disc := greatest(coalesce((e->>'discount')::numeric, 0), 0);
    if v_disc > (p.price + v_add) * v_qty then raise exception 'Diskon melebihi harga %', p.name; end if;

    product_id := p.id;
    name     := p.name || case when array_length(v_names, 1) > 0
                               then ' (+' || array_to_string(v_names, ', +') || ')' else '' end;
    price    := p.price + v_add;
    cost     := p.cost;
    qty      := v_qty;
    discount := v_disc;
    subtotal := (p.price + v_add) * v_qty - v_disc;
    return next;
  end loop;
end $$;

-- Pastikan stok cukup untuk TOTAL qty per produk (bukan per baris), lalu kunci baris produk
create or replace function check_stock(p_biz uuid, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in
    select (e->>'product_id')::uuid pid, sum((e->>'qty')::numeric) q
      from jsonb_array_elements(p_items) e group by 1
  loop
    perform 1 from products where id = r.pid and business_id = p_biz and stock >= r.q for update;
    if not found then
      raise exception 'Stok % tidak cukup', (select name from products where id = r.pid);
    end if;
  end loop;
end $$;

drop function if exists checkout_cash(jsonb, numeric, numeric, numeric, text, text);

create or replace function checkout_cash(
  p_items      jsonb,
  p_discount   numeric default 0,
  p_tax        numeric default 0,     -- diabaikan: pajak dihitung dari pengaturan toko
  p_paid       numeric default null,
  p_customer   text default 'Umum',
  p_method     text default 'cash',
  p_client_ref text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_biz uuid := app_business_id(); v_me uuid := auth.uid();
  v_name text; v_order uuid; v_no text; v_tax_pct numeric;
  v_sub numeric; v_cost numeric; v_disc numeric; v_tax numeric; v_total numeric; v_paid numeric;
  v_existing orders; v_cart jsonb;
begin
  if v_biz is null then raise exception 'Tidak punya akses toko'; end if;
  if p_method not in ('cash','qris') then raise exception 'Metode % tidak boleh lewat fungsi ini', p_method; end if;

  /* Transaksi offline yang dikirim ulang: kembalikan yang sudah ada, jangan dobel */
  if p_client_ref is not null then
    select * into v_existing from orders where business_id = v_biz and client_ref = p_client_ref;
    if found then
      return jsonb_build_object('id', v_existing.id, 'order_no', v_existing.order_no, 'subtotal', v_existing.subtotal,
        'discount', v_existing.discount, 'tax', v_existing.tax, 'total', v_existing.total,
        'paid_amount', v_existing.paid_amount, 'change_amount', v_existing.change_amount,
        'status', v_existing.status, 'duplicate', true);
    end if;
  end if;

  perform check_stock(v_biz, p_items);
  select jsonb_agg(to_jsonb(x)) into v_cart from price_cart(v_biz, p_items) x;

  select coalesce(sum(c.subtotal), 0), coalesce(sum(c.cost * c.qty), 0) into v_sub, v_cost from jsonb_to_recordset(v_cart) as c(product_id uuid, name text, price numeric, cost numeric, qty numeric, discount numeric, subtotal numeric);
  select tax_percent into v_tax_pct from businesses where id = v_biz;

  v_disc  := least(greatest(coalesce(p_discount, 0), 0), v_sub);
  v_tax   := round((v_sub - v_disc) * coalesce(v_tax_pct, 0) / 100);
  v_total := v_sub - v_disc + v_tax;
  v_paid  := case when p_method = 'cash' then coalesce(p_paid, v_total) else v_total end;
  if v_paid < v_total then raise exception 'Uang diterima kurang dari total'; end if;

  select name into v_name from profiles where id = v_me;
  v_no := next_order_no(v_biz);

  insert into orders (business_id, order_no, user_id, cashier_name, customer_name,
                      subtotal, discount, tax, total, cost_total,
                      payment_method, paid_amount, change_amount, status, settled_at,
                      shift_id, client_ref)
  values (v_biz, v_no, v_me, v_name, left(coalesce(nullif(trim(p_customer), ''), 'Umum'), 80),
          v_sub, v_disc, v_tax, v_total, v_cost,
          p_method, v_paid, v_paid - v_total, 'paid', now(),
          my_open_shift(), p_client_ref)
  returning id into v_order;

  insert into order_items (order_id, product_id, name, price, cost, qty, discount, subtotal)
  select v_order, c.product_id, c.name, c.price, c.cost, c.qty, c.discount, c.subtotal from jsonb_to_recordset(v_cart) as c(product_id uuid, name text, price numeric, cost numeric, qty numeric, discount numeric, subtotal numeric);

  update products p set stock = p.stock - t.q
    from (select c.product_id, sum(c.qty) q from jsonb_to_recordset(v_cart) as c(product_id uuid, name text, price numeric, cost numeric, qty numeric, discount numeric, subtotal numeric) group by 1) t
   where p.id = t.product_id;

  insert into stock_movements (business_id, product_id, type, qty, note, user_id)
  select v_biz, c.product_id, 'sale', sum(c.qty), 'Penjualan ' || v_no, v_me from jsonb_to_recordset(v_cart) as c(product_id uuid, name text, price numeric, cost numeric, qty numeric, discount numeric, subtotal numeric) group by c.product_id;

  return jsonb_build_object('id', v_order, 'order_no', v_no, 'subtotal', v_sub,
    'discount', v_disc, 'tax', v_tax, 'total', v_total,
    'paid_amount', v_paid, 'change_amount', v_paid - v_total, 'status', 'paid');
end $$;

drop function if exists order_create_pending(jsonb, numeric, numeric, text, text);

create or replace function order_create_pending(
  p_items    jsonb,
  p_discount numeric default 0,
  p_tax      numeric default 0,      -- diabaikan
  p_customer text default 'Umum',
  p_method   text default 'qris'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_biz uuid := app_business_id(); v_me uuid := auth.uid();
  v_name text; v_order uuid; v_no text; v_tax_pct numeric;
  v_sub numeric; v_cost numeric; v_disc numeric; v_tax numeric; v_total numeric; v_cart jsonb;
begin
  if v_biz is null then raise exception 'Tidak punya akses toko'; end if;
  if p_method <> 'qris' then raise exception 'Metode tidak didukung di sini'; end if;

  perform check_stock(v_biz, p_items);
  select jsonb_agg(to_jsonb(x)) into v_cart from price_cart(v_biz, p_items) x;

  select coalesce(sum(c.subtotal), 0), coalesce(sum(c.cost * c.qty), 0) into v_sub, v_cost from jsonb_to_recordset(v_cart) as c(product_id uuid, name text, price numeric, cost numeric, qty numeric, discount numeric, subtotal numeric);
  select tax_percent into v_tax_pct from businesses where id = v_biz;
  v_disc  := least(greatest(coalesce(p_discount, 0), 0), v_sub);
  v_tax   := round((v_sub - v_disc) * coalesce(v_tax_pct, 0) / 100);
  v_total := v_sub - v_disc + v_tax;
  if v_total < 1 then raise exception 'Total minimal Rp 1 untuk pembayaran QRIS'; end if;

  select name into v_name from profiles where id = v_me;
  v_no := next_order_no(v_biz);

  insert into orders (business_id, order_no, user_id, cashier_name, customer_name,
                      subtotal, discount, tax, total, cost_total,
                      payment_method, paid_amount, change_amount, status, shift_id)
  values (v_biz, v_no, v_me, v_name, left(coalesce(nullif(trim(p_customer), ''), 'Umum'), 80),
          v_sub, v_disc, v_tax, v_total, v_cost, 'qris', 0, 0, 'pending', my_open_shift())
  returning id into v_order;

  insert into order_items (order_id, product_id, name, price, cost, qty, discount, subtotal)
  select v_order, c.product_id, c.name, c.price, c.cost, c.qty, c.discount, c.subtotal from jsonb_to_recordset(v_cart) as c(product_id uuid, name text, price numeric, cost numeric, qty numeric, discount numeric, subtotal numeric);

  return jsonb_build_object('id', v_order, 'order_no', v_no, 'business_id', v_biz,
    'subtotal', v_sub, 'discount', v_disc, 'tax', v_tax, 'total', v_total);
end $$;


-- ============================================================
-- F. REFUND SEBAGIAN (owner)
-- ============================================================
create table if not exists refunds (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  order_id    uuid not null references orders(id) on delete cascade,
  amount      numeric(14,2) not null check (amount >= 0),
  cost        numeric(14,2) not null default 0,
  method      text not null default 'cash',
  reason      text,
  items       jsonb not null default '[]',
  user_id     uuid references profiles(id) on delete set null,
  shift_id    uuid references shifts(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists refunds_biz on refunds (business_id, created_at desc);
alter table refunds enable row level security;
drop policy if exists rf_select on refunds;
create policy rf_select on refunds for select to authenticated using (business_id = app_business_id());

-- p_items: [{order_item_id, qty}]
create or replace function refund_items(p_order_id uuid, p_items jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_biz uuid := app_business_id(); o orders; e jsonb; it order_items;
  v_q numeric; v_ratio numeric; v_amt numeric := 0; v_cost numeric := 0; v_list jsonb := '[]';
begin
  if not app_is_owner() then raise exception 'Hanya owner yang boleh refund'; end if;
  select * into o from orders where id = p_order_id and business_id = v_biz for update;
  if not found then raise exception 'Transaksi tidak ditemukan'; end if;
  if o.status <> 'paid' then raise exception 'Hanya transaksi lunas yang bisa direfund'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Alasan refund wajib diisi'; end if;

  /* Diskon & pajak transaksi dibagi rata ke setiap rupiah barang */
  v_ratio := case when o.subtotal > 0 then o.total / o.subtotal else 0 end;

  for e in select * from jsonb_array_elements(p_items) loop
    select * into it from order_items where id = (e->>'order_item_id')::uuid and order_id = o.id for update;
    if not found then raise exception 'Barang tidak ada di transaksi ini'; end if;
    v_q := (e->>'qty')::numeric;
    if v_q is null or v_q <= 0 or v_q > it.qty - it.refunded_qty then
      raise exception 'Jumlah refund % tidak valid (maks %)', it.name, it.qty - it.refunded_qty;
    end if;

    v_amt  := v_amt + round(it.subtotal / it.qty * v_q * v_ratio);
    v_cost := v_cost + it.cost * v_q;
    update order_items set refunded_qty = refunded_qty + v_q where id = it.id;

    if it.product_id is not null then
      update products set stock = stock + v_q where id = it.product_id;
      insert into stock_movements (business_id, product_id, type, qty, note, user_id)
      values (v_biz, it.product_id, 'in', v_q, 'Refund ' || o.order_no || ': ' || trim(p_reason), auth.uid());
    end if;
    v_list := v_list || jsonb_build_object('name', it.name, 'qty', v_q);
  end loop;

  if jsonb_array_length(v_list) = 0 then raise exception 'Pilih barang yang direfund'; end if;

  insert into refunds (business_id, order_id, amount, cost, method, reason, items, user_id, shift_id)
  values (v_biz, o.id, v_amt, v_cost, o.payment_method, trim(p_reason), v_list, auth.uid(), my_open_shift());

  return jsonb_build_object('amount', v_amt, 'items', v_list);
end $$;

-- Void: kembalikan hanya barang yang belum direfund
create or replace function void_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_biz uuid := app_business_id(); v_item record; v_st text;
begin
  if not app_is_owner() then raise exception 'Hanya owner yang boleh void'; end if;
  select status into v_st from orders where id = p_order_id and business_id = v_biz for update;
  if v_st is null then raise exception 'Order tidak ditemukan'; end if;
  if v_st <> 'paid' then raise exception 'Hanya order lunas yang bisa divoid'; end if;
  if exists (select 1 from refunds where order_id = p_order_id) then
    raise exception 'Transaksi ini sudah pernah direfund sebagian. Gunakan refund untuk sisa barang.';
  end if;

  for v_item in select product_id, qty from order_items where order_id = p_order_id loop
    if v_item.product_id is not null then
      update products set stock = stock + v_item.qty where id = v_item.product_id;
      insert into stock_movements (business_id, product_id, type, qty, note, user_id)
      values (v_biz, v_item.product_id, 'in', v_item.qty, 'Void transaksi', auth.uid());
    end if;
  end loop;
  update orders set status = 'void' where id = p_order_id;
  return jsonb_build_object('ok', true);
end $$;


-- ============================================================
-- G. LOG AKTIVITAS (audit) — tidak bisa diubah/dihapus dari aplikasi
-- ============================================================
create table if not exists audit_log (
  id          bigint generated always as identity primary key,
  business_id uuid,             -- sengaja tanpa FK: log tetap tercatat saat data dihapus
  user_id     uuid,
  user_name   text,
  action      text not null,
  entity      text not null,
  entity_id   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_biz on audit_log (business_id, created_at desc);
alter table audit_log enable row level security;
drop policy if exists al_select on audit_log;
create policy al_select on audit_log for select to authenticated
  using (business_id = app_business_id() and app_is_owner());

create or replace function audit_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_diff jsonb := '{}';
  k text;
  v_skip text[] := array['stock','created_at','updated_at','settled_at'];
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if not (k = any(v_skip)) and v_new->k is distinct from v_old->k then
        v_diff := v_diff || jsonb_build_object(k, jsonb_build_array(v_old->k, v_new->k));
      end if;
    end loop;
    if v_diff = '{}' then return new; end if;   -- tidak ada perubahan penting (mis. hanya stok)
  end if;

  /* Saat toko dihapus (cascade), tidak perlu mencatat setiap baris yang ikut terhapus */
  if not exists (select 1 from businesses where id =
       case when tg_table_name = 'businesses' then (v_row->>'id')::uuid else (v_row->>'business_id')::uuid end) then
    return coalesce(new, old);
  end if;

  insert into audit_log (business_id, user_id, user_name, action, entity, entity_id, detail)
  values (
    case when tg_table_name = 'businesses' then (v_row->>'id')::uuid else (v_row->>'business_id')::uuid end,
    auth.uid(),
    coalesce((select name from profiles where id = auth.uid()), case when auth.uid() is null then 'Sistem' end),
    lower(tg_op), tg_table_name, v_row->>'id',
    case tg_op when 'UPDATE' then v_diff
               when 'INSERT' then v_new - array['addons','image_url']
               else v_old - array['addons','image_url'] end);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['products','categories','businesses','profiles','orders','refunds','shifts','expenses'] loop
    execute format('drop trigger if exists trg_audit on %I', t);
  end loop;
  execute 'create trigger trg_audit after insert or update or delete on products   for each row execute function audit_write()';
  execute 'create trigger trg_audit after insert or update or delete on categories for each row execute function audit_write()';
  execute 'create trigger trg_audit after update on businesses                       for each row execute function audit_write()';
  execute 'create trigger trg_audit after insert or update or delete on profiles   for each row execute function audit_write()';
  execute 'create trigger trg_audit after update on orders                           for each row execute function audit_write()';
  execute 'create trigger trg_audit after insert on refunds                          for each row execute function audit_write()';
  execute 'create trigger trg_audit after insert or update on shifts                 for each row execute function audit_write()';
  execute 'create trigger trg_audit after insert or update or delete on expenses   for each row execute function audit_write()';
end $$;


-- ============================================================
-- H. STORAGE — setiap toko hanya bisa menulis ke foldernya sendiri
-- Path: <jenis>/<business_id>/<file>   (qris, products, evidence)
-- ============================================================
update storage.buckets
   set file_size_limit = 8 * 1024 * 1024,
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif']
 where id = 'stockflow';

drop policy if exists "stockflow write"  on storage.objects;
drop policy if exists "stockflow update" on storage.objects;
drop policy if exists "stockflow delete" on storage.objects;

create policy "stockflow write" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'stockflow'
    and (storage.foldername(name))[2] = app_business_id()::text
    and (
      (storage.foldername(name))[1] = 'evidence'                                   -- staff & owner
      or ((storage.foldername(name))[1] in ('qris','products') and app_is_owner()) -- owner saja
    )
  );
create policy "stockflow update" on storage.objects for update to authenticated
  using (bucket_id = 'stockflow' and (storage.foldername(name))[2] = app_business_id()::text and app_is_owner());
create policy "stockflow delete" on storage.objects for delete to authenticated
  using (bucket_id = 'stockflow' and (storage.foldername(name))[2] = app_business_id()::text and app_is_owner());


-- ============================================================
-- I. BATAS PERCOBAAN LOGIN (dipakai Edge Function staff-login & owner-verify)
-- ============================================================
create table if not exists auth_attempts (
  id   bigint generated always as identity primary key,
  key  text not null,
  at   timestamptz not null default now()
);
create index if not exists auth_attempts_key on auth_attempts (key, at desc);
alter table auth_attempts enable row level security;   -- tanpa policy: hanya service_role


-- ============================================================
-- J. ADMIN WAJIB VERIFIKASI 2 LANGKAH (TOTP)
-- Fungsi admin hanya jalan bila sesi sudah lolos kode 6 angka (aal2).
-- ============================================================
create or replace function is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
     and coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
$$;

-- Untuk tampilan: apakah akun ini admin (terlepas dari status 2FA)
create or replace function am_i_admin()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'admin', exists (select 1 from platform_admins where user_id = auth.uid()),
    'aal',   coalesce(auth.jwt()->>'aal', 'aal1'))
$$;


-- ============================================================
-- K. HAK EKSEKUSI FUNGSI
-- ============================================================
do $$
declare f record;
begin
  -- Cabut dari publik & anon untuk SEMUA fungsi di schema public
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;

-- Fungsi internal: tidak untuk dipanggil dari aplikasi sama sekali
revoke execute on function next_order_no(uuid)        from authenticated;
revoke execute on function price_cart(uuid, jsonb)    from authenticated;
revoke execute on function check_stock(uuid, jsonb)   from authenticated;
revoke execute on function audit_write()              from authenticated;
revoke execute on function enforce_subscription()     from authenticated;

-- Fungsi yang boleh dipanggil pengguna yang sudah masuk
grant execute on function app_business_id()                          to authenticated;
grant execute on function app_is_owner()                             to authenticated;
grant execute on function business_is_active(uuid)                   to authenticated;
grant execute on function is_platform_admin()                        to authenticated;
grant execute on function am_i_admin()                               to authenticated;
grant execute on function my_open_shift()                            to authenticated;
grant execute on function shift_open(numeric)                        to authenticated;
grant execute on function shift_summary(uuid)                        to authenticated;
grant execute on function shift_close(numeric, text)                 to authenticated;
grant execute on function checkout_cash(jsonb, numeric, numeric, numeric, text, text, text) to authenticated;
grant execute on function order_create_pending(jsonb, numeric, numeric, text, text)          to authenticated;
grant execute on function refund_items(uuid, jsonb, text)            to authenticated;
grant execute on function void_order(uuid)                           to authenticated;

-- Satu-satunya fungsi yang boleh dipanggil TANPA login: cek kode saat mendaftar
grant execute on function check_activation_code(text) to anon, authenticated;

-- Fungsi tanpa search_path tetap dikunci ke schema public
alter function norm_code(text) set search_path = public;

-- Browser yang masih memakai halaman lama (tanpa kode aktivasi) mendapat
-- pesan yang jelas, bukan error "function not found".
create or replace function setup_owner(p_business_name text, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Halaman Anda versi lama. Tekan Ctrl+Shift+R (atau tutup lalu buka lagi), kemudian isi kode aktivasi.';
end $$;
revoke execute on function setup_owner(text, text) from public, anon;
grant  execute on function setup_owner(text, text) to authenticated;
