// ============================================================
// delete-account — hapus toko beserta seluruh datanya
//
// Hak pengguna atas penghapusan data (UU PDP). Hanya owner.
//
// Urutan:
//   1. delete_my_business() menghapus baris businesses, dan
//      seluruh data toko ikut terhapus lewat ON DELETE CASCADE.
//      Fungsi itu mengembalikan daftar user_id anggota toko.
//   2. Akun Auth setiap anggota dihapus di sini, karena itu
//      butuh service_role.
//
// Body: { confirm: "HAPUS" }
// ============================================================

import {
  corsHeaders, json, fail, sbAdmin, authAdmin, getCaller,
} from '../_shared/lib.ts';

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail('Metode tidak diizinkan', 405, origin);

  try {
    const caller = await getCaller(req);
    if (!caller) return fail('Sesi tidak sah. Silakan masuk kembali.', 401, origin);
    if (caller.role !== 'owner') {
      return fail('Hanya owner yang boleh menghapus toko', 403, origin);
    }

    const body = await req.json().catch(() => ({}));
    if (String(body.confirm || '') !== 'HAPUS') {
      return fail('Konfirmasi tidak cocok', 400, origin);
    }

    /* ---------- 1. Hapus data toko ---------- */
    const token = (req.headers.get('Authorization') || '').slice(7);

    const rpc = await fetch(`${Deno.env.get('SUPABASE_URL')}/rest/v1/rpc/delete_my_business`, {
      method: 'POST',
      headers: {
        apikey: Deno.env.get('SUPABASE_ANON_KEY') || '',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    const result = await rpc.json().catch(() => null);
    if (!rpc.ok) {
      console.error('delete_my_business gagal', JSON.stringify(result));
      return fail(
        (result && (result.message || result.hint)) || 'Gagal menghapus data toko',
        500, origin);
    }

    /* ---------- 2. Hapus akun Auth setiap anggota ---------- */
    const ids: string[] = Array.isArray(result?.user_ids) ? result.user_ids : [];
    const failed: string[] = [];

    for (const id of ids) {
      if (!id) continue;
      const d = await authAdmin(`/users/${id}`, { method: 'DELETE' });
      if (!d.ok) {
        failed.push(id);
        console.error('gagal hapus auth user', id, await d.text());
      }
    }

    if (failed.length) {
      /* Data toko sudah hilang; akun Auth yang tersisa tidak bisa
         mengakses apa pun, tapi tetap dilaporkan agar bisa ditindak. */
      return json({
        ok: true,
        warning: 'Sebagian akun gagal dihapus. Data toko sudah terhapus seluruhnya.',
        failed: failed.length,
      }, 200, origin);
    }

    return json({ ok: true, deleted_accounts: ids.length }, 200, origin);

  } catch (e) {
    console.error('delete-account error', e);
    return fail('Terjadi kesalahan di server', 500, origin);
  }
});
