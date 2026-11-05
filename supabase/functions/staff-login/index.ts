// ============================================================
// staff-login — karyawan masuk dengan username + kode unik
//
// Tidak butuh JWT (pengguna belum masuk). Kode dicek di server
// dengan service_role, lalu sesi Supabase Auth biasa diterbitkan:
// password akun internal diganti acak, kemudian dipakai sekali
// untuk login. Kode tidak pernah dipakai sebagai password.
// ============================================================

import { corsHeaders, json, fail, sbAdmin, authAdmin, env, publicKey } from '../_shared/lib.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randomPassword(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail('Metode tidak diizinkan', 405, origin);

  /* Pesan sama untuk semua kegagalan supaya tidak membocorkan
     username mana yang ada; jeda memperlambat tebak-tebakan. */
  const denied = async () => { await sleep(600); return fail('Username atau kode salah', 401, origin); };

  try {
    const b = await req.json().catch(() => ({}));
    const username = String(b.username || '').trim().toLowerCase();
    const code     = String(b.code || '').trim().toUpperCase().replace(/[\s-]/g, '');
    if (!username || code.length < 6 || code.length > 16 || !/^[A-Z0-9]+$/.test(code)) return denied();

    const cRes = await sbAdmin(`/rest/v1/staff_codes?code=eq.${code}&select=profile_id,username`);
    const row = ((await cRes.json()) || [])[0];
    if (!row || String(row.username).toLowerCase() !== username) return denied();

    const pRes = await sbAdmin(`/rest/v1/profiles?id=eq.${row.profile_id}&select=active`);
    const prof = ((await pRes.json()) || [])[0];
    if (!prof) return denied();
    if (!prof.active) return fail('Akun dinonaktifkan. Hubungi owner.', 403, origin);

    const uRes = await authAdmin(`/users/${row.profile_id}`);
    const user = await uRes.json().catch(() => ({}));
    if (!uRes.ok || !user.email) return denied();

    const pw = randomPassword();
    const setRes = await authAdmin(`/users/${row.profile_id}`, {
      method: 'PUT', body: JSON.stringify({ password: pw }),
    });
    if (!setRes.ok) return fail('Gagal menyiapkan sesi', 500, origin);

    const tRes = await fetch(`${env('SUPABASE_URL')}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: publicKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: pw }),
    });
    const tok = await tRes.json().catch(() => ({}));
    if (!tRes.ok || !tok.access_token) {
      console.error('token gagal', tRes.status, JSON.stringify(tok));
      return fail('Gagal masuk, coba lagi', 500, origin);
    }

    return json({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_in: tok.expires_in,
    }, 200, origin);
  } catch (e) {
    console.error('staff-login error', e);
    return fail('Terjadi kesalahan di server', 500, origin);
  }
});
