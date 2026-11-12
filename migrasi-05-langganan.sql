-- ============================================================
-- MIGRASI 05: kode aktivasi, masa aktif toko, panel admin
-- ------------------------------------------------------------
-- • Toko baru hanya bisa dibuat dengan KODE AKTIVASI dari admin.
-- • Setiap toko punya masa aktif. active_until = NULL berarti PERMANEN.
--   Toko yang sudah ada sebelum migrasi ini otomatis permanen.
-- • Toko yang habis / dimatikan tidak bisa bertransaksi atau mengubah
--   data, tapi datanya tetap bisa dilihat dan diunduh.
-- • Admin platform = akun yang PALING PERTAMA terdaftar di project ini
--   (akun pemilik StockFlow). Bisa ditambah manual di tabel platform_admins.
--
-- AMAN: tidak ada tabel yang dibuang, data tidak berubah. Boleh diulang.
-- Cara pakai: Supabase Dashboard > SQL Editor > tempel > Run
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
