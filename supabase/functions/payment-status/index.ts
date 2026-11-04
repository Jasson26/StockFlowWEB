// ============================================================
// payment-status — cek status pembayaran langsung ke Midtrans
//
// Jaring pengaman kalau webhook tertunda atau gagal masuk.
// Kasir memanggil ini saat polling; kalau Midtrans sudah
// menyatakan lunas, order langsung dilunasi di sini juga.
//
// Body: { gateway_order_id: string }
// Balas: { status, order_status, issuer }
// ============================================================

import {
  corsHeaders, json, fail, sbAdmin, sbRpc, getCaller,
  credsFor, midtransBase, midtransAuthHeader, mapMidtransStatus,
} from '../_shared/lib.ts';

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail('Metode tidak diizinkan', 405, origin);

  try {
    const caller = await getCaller(req);
    if (!caller) return fail('Sesi tidak sah. Silakan masuk kembali.', 401, origin);

    const body = await req.json().catch(() => ({}));
    const gatewayOrderId = String(body.gateway_order_id || '');
    if (!gatewayOrderId) return fail('gateway_order_id wajib diisi', 400, origin);

    /* ---------- Pastikan pembayaran ini milik toko pemanggil ---------- */
    const pRes = await sbAdmin(
      `/rest/v1/payments?gateway_order_id=eq.${encodeURIComponent(gatewayOrderId)}` +
      `&select=id,business_id,order_id,status`,
    );
    const rows = await pRes.json();
    const pay = rows?.[0];

    if (!pay) return fail('Pembayaran tidak ditemukan', 404, origin);
    if (pay.business_id !== caller.businessId) {
      return fail('Bukan milik toko Anda', 403, origin);
    }

    /* Sudah final di database — tidak perlu tanya gateway lagi */
    if (pay.status !== 'pending') {
      return json({ status: pay.status, final: true }, 200, origin);
    }

    /* ---------- Tanya Midtrans ---------- */
    const creds = await credsFor(caller.businessId);
    if (!creds) return json({ status: 'pending', note: 'kredensial belum dipasang' }, 200, origin);

    const sRes = await fetch(
      `${midtransBase(creds)}/v2/${encodeURIComponent(gatewayOrderId)}/status`,
      { headers: { Authorization: midtransAuthHeader(creds), Accept: 'application/json' } },
    );
    const s = await sRes.json().catch(() => ({}));

    /* 404 dari Midtrans = transaksi belum terdaftar / sudah hilang */
    if (!sRes.ok) {
      console.warn('status gagal', gatewayOrderId, sRes.status, JSON.stringify(s));
      return json({ status: 'pending', note: 'gateway belum menjawab' }, 200, origin);
    }

    const status = mapMidtransStatus(
      String(s.transaction_status || ''),
      String(s.fraud_status || ''),
    );
    const issuer = s.issuer || s.acquirer || null;

    /* ---------- Sinkronkan kalau sudah final ---------- */
    if (status === 'paid') {
      const r = await sbRpc('order_settle', {
        p_gateway_order_id: gatewayOrderId,
        p_txn_id: s.transaction_id || null,
        p_issuer: issuer,
        p_raw: s,
      });
      return json({ status: 'paid', issuer, settle: r }, 200, origin);
    }

    if (status === 'expired' || status === 'failed') {
      await sbRpc('order_mark_failed', {
        p_gateway_order_id: gatewayOrderId,
        p_status: status,
      });
      return json({ status, final: true }, 200, origin);
    }

    return json({ status: 'pending' }, 200, origin);

  } catch (e) {
    console.error('payment-status error', e);
    return fail('Gagal memeriksa status pembayaran', 500, origin);
  }
});
