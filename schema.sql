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

  insert into categories (business_id, name, sort_order) values
    (v_biz, 'Makanan', 1), (v_biz, 'Minuman', 2), (v_biz, 'Lainnya', 3);

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
  if p_method not in ('cash','transfer') then
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
