-- ============================================================
-- MIGRASI 02: kategori bawaan dihapus
-- ------------------------------------------------------------
-- 1. Toko baru tidak lagi otomatis mendapat kategori
--    Makanan / Minuman / Lainnya.
-- 2. Di toko yang sudah ada, ketiga kategori bawaan itu dihapus
--    HANYA jika belum dipakai produk mana pun. Kategori yang sudah
--    berisi produk dibiarkan.
--
-- Aman: tidak menghapus produk atau transaksi.
-- Cara pakai: Supabase Dashboard > SQL Editor > tempel > Run
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

delete from categories c
where c.name in ('Makanan', 'Minuman', 'Lainnya')
  and not exists (select 1 from products p where p.category_id = c.id);
