-- ============================================================
-- MIGRASI: izinkan metode 'qris' di checkout_cash
-- ------------------------------------------------------------
-- Dipakai untuk QRIS statis (gambar QRIS yang diunggah owner di
-- Pengaturan). Kasir yang memastikan dana masuk, lalu order
-- dicatat langsung lunas dengan metode 'qris' supaya laporan
-- tidak lagi mencampurnya dengan transfer bank.
--
-- AMAN DIJALANKAN DI DATABASE YANG SUDAH BERISI DATA:
-- hanya mengganti isi fungsi, tidak menyentuh tabel apa pun.
--
-- Cara pakai: Supabase Dashboard > SQL Editor > tempel > Run
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
-- Pastikan bucket Storage untuk gambar QRIS & foto produk ada
-- (aman diulang; tidak menghapus berkas yang sudah terunggah)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('stockflow', 'stockflow', true)
on conflict (id) do update set public = true;

drop policy if exists "stockflow read"   on storage.objects;
drop policy if exists "stockflow write"  on storage.objects;
drop policy if exists "stockflow update" on storage.objects;
drop policy if exists "stockflow delete" on storage.objects;

create policy "stockflow read"   on storage.objects for select
  using (bucket_id = 'stockflow');
create policy "stockflow write"  on storage.objects for insert to authenticated
  with check (bucket_id = 'stockflow');
create policy "stockflow update" on storage.objects for update to authenticated
  using (bucket_id = 'stockflow');
create policy "stockflow delete" on storage.objects for delete to authenticated
  using (bucket_id = 'stockflow');
