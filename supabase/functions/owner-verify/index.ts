// ============================================================
// owner-verify — memastikan password owner benar
//
// Dipakai saat karyawan ingin keluar dari mode staff: owner
// mengetik password akunnya di perangkat itu. Email owner tidak
// pernah dikirim ke browser; pencocokan dilakukan di server.
// ============================================================

import { corsHeaders, json, fail, sbAdmin, authAdmin, env, publicKey, getCaller } from '../_shared/lib.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail('Metode tidak diizinkan', 405, origin);

  try {
    const caller = await getCaller(req);
    if (!caller) return fail('Sesi tidak sah', 401, origin);

    const b = await req.json().catch(() => ({}));
    const password = String(b.password || '');
    if (!password) return fail('Password owner wajib diisi', 400, origin);

    const oRes = await sbAdmin(
      `/rest/v1/profiles?business_id=eq.${caller.businessId}&role=eq.owner&active=is.true&select=id`,
    );
    const owners = (await oRes.json()) || [];

    for (const o of owners) {
      const u = await authAdmin(`/users/${o.id}`);
      const user = await u.json().catch(() => ({}));
      if (!user.email) continue;

      const t = await fetch(`${env('SUPABASE_URL')}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: publicKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, password }),
      });
      if (t.ok) {
        /* Sesi uji ini tidak dipakai — langsung dicabut */
        const tok = await t.json().catch(() => ({}));
        if (tok.access_token) {
          await fetch(`${env('SUPABASE_URL')}/auth/v1/logout`, {
            method: 'POST',
            headers: { apikey: publicKey(), Authorization: `Bearer ${tok.access_token}` },
          }).catch(() => {});
        }
        return json({ ok: true }, 200, origin);
      }
    }

    await sleep(600);
    return fail('Password owner salah', 403, origin); // bukan 401: 401 membuat aplikasi menganggap sesi habis
  } catch (e) {
    console.error('owner-verify error', e);
    return fail('Terjadi kesalahan di server', 500, origin);
  }
});
