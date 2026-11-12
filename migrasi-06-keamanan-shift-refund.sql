-- ============================================================
-- MIGRASI 06: pengerasan keamanan, shift kasir, refund sebagian,
--             log aktivitas, harga dihitung server
-- ------------------------------------------------------------
-- Jalankan SETELAH migrasi-05-langganan.sql.
-- AMAN: tidak ada tabel yang dibuang, data lama tidak diubah.
-- Boleh dijalankan ulang.
--
-- Celah yang ditutup:
--  1. Staff bisa mengubah perannya sendiri jadi owner lewat API.
--  2. Owner bisa memperpanjang langganannya sendiri lewat API.
--  3. Siapa pun di toko bisa membuat transaksi "lunas" palsu langsung
--     ke tabel orders tanpa lewat kasir.
--  4. Harga & modal barang dikirim dari browser (bisa dimanipulasi).
--  5. File gambar toko lain bisa ditimpa/dihapus (Storage).
--  6. Fungsi database bisa dipanggil tanpa login (anon).
--  7. next_order_no bisa dipakai mengintip jumlah transaksi toko lain.
--
-- Cara pakai: Supabase Dashboard > SQL Editor > tempel > Run
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
