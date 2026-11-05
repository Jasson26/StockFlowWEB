// ============================================================
// create-staff — owner mengelola akun karyawan
//
// Karyawan TIDAK memakai email. Owner cukup mengisi nama dan
// username; sistem membuat kode unik yang dipakai untuk masuk.
// Di belakang layar Supabase Auth tetap butuh email, jadi dibuat
// alamat internal yang tidak pernah ditampilkan dan tidak menerima surat.
//
// Body salah satu dari:
//   { action:'create', name, username }
//   { action:'update', user_id, name?, active?, regen_code? }
//   { action:'delete', user_id }
// ============================================================

import {
  corsHeaders, json, fail, sbAdmin, authAdmin, getCaller,
} from '../_shared/lib.ts';

/* Tanpa huruf/angka yang mirip (O/0, I/1/L) supaya mudah didiktekan */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

function randomPassword(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

const USERNAME_RE = /^[a-z0-9._-]{3,24}$/;

async function targetInBiz(userId: string, bizId: string) {
  const r = await sbAdmin(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,business_id,role,active`);
  const t = (await r.json())?.[0];
  if (!t || t.business_id !== bizId) return null;
  return t;
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail('Metode tidak diizinkan', 405, origin);

  try {
    const caller = await getCaller(req);
    if (!caller) return fail('Sesi tidak sah. Silakan masuk kembali.', 401, origin);
    if (caller.role !== 'owner') return fail('Hanya owner yang boleh mengelola pengguna', 403, origin);

    const b = await req.json().catch(() => ({}));
    const action = String(b.action || '');

    /* ============ CREATE ============ */
    if (action === 'create') {
      const name     = String(b.name || '').trim();
      const username = String(b.username || '').trim().toLowerCase();

      if (!name) return fail('Nama wajib diisi', 400, origin);
      if (!USERNAME_RE.test(username)) {
        return fail('Username 3–24 karakter: huruf kecil, angka, titik, strip', 400, origin);
      }

      /* Username unik di dalam toko */
      const dup = await sbAdmin(
        `/rest/v1/staff_codes?business_id=eq.${caller.businessId}&username=ilike.${encodeURIComponent(username)}&select=profile_id`,
      );
      if (((await dup.json()) || []).length) return fail('Username sudah dipakai di toko ini', 409, origin);

      const internalEmail = `staff.${crypto.randomUUID()}@staff.stockflow.invalid`;

      const aRes = await authAdmin('/users', {
        method: 'POST',
        body: JSON.stringify({
          email: internalEmail,
          password: randomPassword(),
          email_confirm: true,
          user_metadata: { name, username, staff: true },
        }),
      });
      const aBody = await aRes.json().catch(() => ({}));
      if (!aRes.ok || !aBody.id) {
        console.error('createUser gagal', aRes.status, JSON.stringify(aBody));
        return fail('Gagal membuat akun karyawan', 400, origin);
      }
      const newId = aBody.id as string;

      const pRes = await sbAdmin('/rest/v1/profiles', {
        method: 'POST',
        body: JSON.stringify({
          id: newId, business_id: caller.businessId, name, username, role: 'staff', active: true,
        }),
      });
      if (!pRes.ok) {
        await authAdmin(`/users/${newId}`, { method: 'DELETE' });
        console.error('insert profile gagal', await pRes.text());
        return fail('Gagal menyimpan profil karyawan', 500, origin);
      }

      /* Kode unik; ulangi kalau kebetulan bentrok */
      let code = '';
      for (let i = 0; i < 5; i++) {
        code = newCode();
        const cRes = await sbAdmin('/rest/v1/staff_codes', {
          method: 'POST',
          body: JSON.stringify({ profile_id: newId, business_id: caller.businessId, username, code }),
        });
        if (cRes.ok) break;
        code = '';
      }
      if (!code) {
        await authAdmin(`/users/${newId}`, { method: 'DELETE' });
        return fail('Gagal membuat kode unik, coba lagi', 500, origin);
      }

      return json({ ok: true, user_id: newId, username, code }, 200, origin);
    }

    /* ============ UPDATE ============ */
    if (action === 'update') {
      const userId = String(b.user_id || '');
      const t = await targetInBiz(userId, caller.businessId);
      if (!t) return fail('Pengguna tidak ditemukan di toko Anda', 404, origin);
      if (t.role === 'owner') return fail('Akun owner tidak diubah dari sini', 400, origin);

      const patch: Record<string, unknown> = {};
      if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim();
      if (typeof b.active === 'boolean') patch.active = b.active;
      if (Object.keys(patch).length) {
        const u = await sbAdmin(`/rest/v1/profiles?id=eq.${userId}`, { method: 'PATCH', body: JSON.stringify(patch) });
        if (!u.ok) return fail('Gagal memperbarui profil', 500, origin);
      }

      let code: string | undefined;
      if (b.regen_code) {
        for (let i = 0; i < 5 && !code; i++) {
          const c = newCode();
          const r = await sbAdmin(`/rest/v1/staff_codes?profile_id=eq.${userId}`, {
            method: 'PATCH', body: JSON.stringify({ code: c }),
          });
          if (r.ok) code = c;
        }
        if (!code) return fail('Gagal membuat kode baru', 500, origin);
        /* Kode lama tidak berlaku lagi: putuskan sesi yang sedang berjalan */
        await authAdmin(`/users/${userId}`, { method: 'PUT', body: JSON.stringify({ password: randomPassword() }) });
      }

      return json({ ok: true, code }, 200, origin);
    }

    /* ============ DELETE ============ */
    if (action === 'delete') {
      const userId = String(b.user_id || '');
      if (userId === caller.userId) return fail('Tidak bisa menghapus akun sendiri', 400, origin);
      const t = await targetInBiz(userId, caller.businessId);
      if (!t) return fail('Pengguna tidak ditemukan di toko Anda', 404, origin);
      if (t.role === 'owner') return fail('Akun owner tidak bisa dihapus dari sini', 400, origin);

      /* Profil & kode ikut terhapus lewat ON DELETE CASCADE */
      const d = await authAdmin(`/users/${userId}`, { method: 'DELETE' });
      if (!d.ok) {
        console.error('delete user gagal', await d.text());
        return fail('Gagal menghapus karyawan', 500, origin);
      }
      return json({ ok: true }, 200, origin);
    }

    return fail('action tidak dikenal', 400, origin);
  } catch (e) {
    console.error('create-staff error', e);
    return fail('Terjadi kesalahan di server', 500, origin);
  }
});
