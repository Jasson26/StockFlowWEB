// ============================================================
// create-staff — owner membuat / mengubah / menghapus akun karyawan
//
// Membuat user di Supabase Auth butuh service_role key, yang tidak
// boleh ada di browser. Karena itu dikerjakan di sini.
//
// Body salah satu dari:
//   { action:'create', name, email, password, role }
//   { action:'update', user_id, name?, role?, active?, password? }
//   { action:'delete', user_id }
// ============================================================

import {
  corsHeaders, json, fail, sbAdmin, authAdmin, getCaller,
} from '../_shared/lib.ts';

const MIN_PASSWORD = 8;

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail('Metode tidak diizinkan', 405, origin);

  try {
    /* ---------- Hanya owner ---------- */
    const caller = await getCaller(req);
    if (!caller) return fail('Sesi tidak sah. Silakan masuk kembali.', 401, origin);
    if (caller.role !== 'owner') {
      return fail('Hanya owner yang boleh mengelola pengguna', 403, origin);
    }

    const b = await req.json().catch(() => ({}));
    const action = String(b.action || '');

    /* ============ CREATE ============ */
    if (action === 'create') {
      const name     = String(b.name || '').trim();
      const email    = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      const role     = b.role === 'owner' ? 'owner' : 'staff';

      if (!name)  return fail('Nama wajib diisi', 400, origin);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return fail('Format email tidak valid', 400, origin);
      }
      if (password.length < MIN_PASSWORD) {
        return fail(`Password minimal ${MIN_PASSWORD} karakter`, 400, origin);
      }

      /* 1. Buat user di Auth (email langsung dikonfirmasi) */
      const aRes = await authAdmin('/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { name },
        }),
      });

      const aBody = await aRes.json().catch(() => ({}));
      if (!aRes.ok) {
        const msg = String(aBody.msg || aBody.error_description || aBody.message || '');
        if (/already|exists|registered/i.test(msg)) {
          return fail('Email sudah terdaftar', 409, origin);
        }
        console.error('createUser gagal', aRes.status, JSON.stringify(aBody));
        return fail('Gagal membuat akun: ' + (msg || aRes.status), 400, origin);
      }

      const newId = aBody.id;
      if (!newId) return fail('Auth tidak mengembalikan id pengguna', 500, origin);

      /* 2. Buat profil di toko pemanggil */
      const pRes = await sbAdmin('/rest/v1/profiles', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          id: newId,
          business_id: caller.businessId,
          name,
          role,
          active: true,
        }),
      });

      if (!pRes.ok) {
        /* Rollback: hapus user Auth agar tidak jadi akun menggantung */
        await authAdmin(`/users/${newId}`, { method: 'DELETE' });
        const t = await pRes.text();
        console.error('insert profile gagal', t);
        return fail('Gagal menyimpan profil pengguna', 500, origin);
      }

      return json({ ok: true, user_id: newId }, 200, origin);
    }

    /* ============ UPDATE ============ */
    if (action === 'update') {
      const userId = String(b.user_id || '');
      if (!userId) return fail('user_id wajib diisi', 400, origin);

      /* Pastikan target ada di toko yang sama */
      const tRes = await sbAdmin(
        `/rest/v1/profiles?id=eq.${userId}&select=id,business_id,role,active`,
      );
      const target = (await tRes.json())?.[0];
      if (!target) return fail('Pengguna tidak ditemukan', 404, origin);
      if (target.business_id !== caller.businessId) {
        return fail('Pengguna bukan anggota toko Anda', 403, origin);
      }

      const patch: Record<string, unknown> = {};
      if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
      if (b.role === 'owner' || b.role === 'staff')     patch.role = b.role;
      if (typeof b.active === 'boolean')                patch.active = b.active;

      /* Jangan sampai toko kehilangan owner aktif terakhir */
      const losingOwner =
        (patch.role && patch.role !== 'owner' && target.role === 'owner') ||
        (patch.active === false && target.role === 'owner');

      if (losingOwner) {
        const oRes = await sbAdmin(
          `/rest/v1/profiles?business_id=eq.${caller.businessId}` +
          `&role=eq.owner&active=is.true&select=id`,
        );
        const owners = (await oRes.json()) || [];
        if (owners.length <= 1) {
          return fail('Toko harus punya minimal satu owner aktif', 409, origin);
        }
      }

      if (Object.keys(patch).length) {
        const uRes = await sbAdmin(`/rest/v1/profiles?id=eq.${userId}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        if (!uRes.ok) {
          console.error('patch profile gagal', await uRes.text());
          return fail('Gagal memperbarui profil', 500, origin);
        }
      }

      /* Reset password bila diminta */
      if (b.password) {
        const pw = String(b.password);
        if (pw.length < MIN_PASSWORD) {
          return fail(`Password minimal ${MIN_PASSWORD} karakter`, 400, origin);
        }
        const aRes = await authAdmin(`/users/${userId}`, {
          method: 'PUT',
          body: JSON.stringify({ password: pw }),
        });
        if (!aRes.ok) {
          console.error('update password gagal', await aRes.text());
          return fail('Gagal mengubah password', 500, origin);
        }
      }

      return json({ ok: true }, 200, origin);
    }

    /* ============ DELETE ============ */
    if (action === 'delete') {
      const userId = String(b.user_id || '');
      if (!userId) return fail('user_id wajib diisi', 400, origin);
      if (userId === caller.userId) {
        return fail('Tidak bisa menghapus akun sendiri', 400, origin);
      }

      const tRes = await sbAdmin(
        `/rest/v1/profiles?id=eq.${userId}&select=id,business_id,role,active`,
      );
      const target = (await tRes.json())?.[0];
      if (!target) return fail('Pengguna tidak ditemukan', 404, origin);
      if (target.business_id !== caller.businessId) {
        return fail('Pengguna bukan anggota toko Anda', 403, origin);
      }

      if (target.role === 'owner') {
        const oRes = await sbAdmin(
          `/rest/v1/profiles?business_id=eq.${caller.businessId}` +
          `&role=eq.owner&active=is.true&select=id`,
        );
        const owners = (await oRes.json()) || [];
        if (owners.length <= 1) {
          return fail('Toko harus punya minimal satu owner aktif', 409, origin);
        }
      }

      /* Hapus user Auth — profil ikut terhapus lewat ON DELETE CASCADE */
      const dRes = await authAdmin(`/users/${userId}`, { method: 'DELETE' });
      if (!dRes.ok) {
        console.error('delete user gagal', await dRes.text());
        return fail('Gagal menghapus pengguna', 500, origin);
      }

      return json({ ok: true }, 200, origin);
    }

    return fail('action tidak dikenal', 400, origin);

  } catch (e) {
    console.error('create-staff error', e);
    return fail('Terjadi kesalahan di server', 500, origin);
  }
});
