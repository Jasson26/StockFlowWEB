// ============================================================
// payment-create — buat tagihan QRIS di Midtrans
//
// Dipanggil dari kasir setelah order pending dibuat.
// Secret key Midtrans HANYA ada di sini, tidak pernah ke browser.
//
// Body: { order_id: uuid }
// Balas: { qr_url, gateway_order_id, expires_at, amount, order_no }
// ============================================================

import {
  corsHeaders, json, fail, sbAdmin, getCaller,
  credsFor, midtransBase, midtransAuthHeader,
} from '../_shared/lib.ts';

/* Berapa lama QR berlaku (menit) */
const EXPIRY_MINUTES = Number(Deno.env.get('QRIS_EXPIRY_MINUTES') || '15');

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return fail('Metode tidak diizinkan', 405, origin);

  try {
    /* ---------- 1. Otentikasi pemanggil ---------- */
    const caller = await getCaller(req);
    if (!caller) return fail('Sesi tidak sah. Silakan masuk kembali.', 401, origin);

    const body = await req.json().catch(() => ({}));
    const orderId = String(body.order_id || '');
    if (!orderId) return fail('order_id wajib diisi', 400, origin);

    /* ---------- 2. Ambil order & pastikan milik toko pemanggil ---------- */
    const oRes = await sbAdmin(
      `/rest/v1/orders?id=eq.${orderId}&select=id,business_id,order_no,total,status,customer_name`,
    );
    const orders = await oRes.json();
    const order = orders?.[0];

    if (!order) return fail('Order tidak ditemukan', 404, origin);
    if (order.business_id !== caller.businessId) {
      return fail('Order bukan milik toko Anda', 403, origin);
    }
    if (order.status !== 'pending') {
      return fail(`Order sudah berstatus ${order.status}`, 409, origin);
    }

    const amount = Math.round(Number(order.total));
    if (!(amount >= 1)) return fail('Nominal tidak valid', 400, origin);

    /* ---------- 3. Hitung nomor percobaan (retry butuh order_id baru) ---------- */
    const cRes = await sbAdmin(
      `/rest/v1/payments?order_id=eq.${orderId}&select=id`,
      { headers: { Prefer: 'count=exact' } },
    );
    const prev = await cRes.json();
    const attempt = (Array.isArray(prev) ? prev.length : 0) + 1;
    const gatewayOrderId = attempt === 1 ? order.order_no : `${order.order_no}-R${attempt}`;

    /* ---------- 4. Ambil nama item untuk ditampilkan di app pembayaran ---------- */
    const iRes = await sbAdmin(
      `/rest/v1/order_items?order_id=eq.${orderId}&select=name,price,qty`,
    );
    const items = (await iRes.json()) || [];

    /* ---------- 5. Ambil kredensial milik toko ini ---------- */
    const creds = await credsFor(caller.businessId);
    if (!creds) {
      return fail(
        'Pembayaran QRIS belum disiapkan. Owner dapat memasang Server Key Midtrans ' +
        'di menu Pengaturan.', 409, origin);
    }

    /* ---------- 6. Charge ke Midtrans ---------- */
    const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60_000);

    const payload: Record<string, unknown> = {
      payment_type: 'qris',
      transaction_details: { order_id: gatewayOrderId, gross_amount: amount },
      qris: { acquirer: Deno.env.get('MIDTRANS_QRIS_ACQUIRER') || 'gopay' },
      custom_expiry: { expiry_duration: EXPIRY_MINUTES, unit: 'minute' },
    };

    /* item_details harus berjumlah sama dengan gross_amount, jadi hanya
       dikirim bila cocok — menghindari error 400 dari Midtrans. */
    const itemSum = items.reduce(
      (s: number, i: { price: number; qty: number }) => s + Math.round(Number(i.price) * Number(i.qty)),
      0,
    );
    if (itemSum === amount && items.length) {
      payload.item_details = items.map((i: { name: string; price: number; qty: number }, n: number) => ({
        id: `item${n + 1}`,
        name: String(i.name).slice(0, 50),
        price: Math.round(Number(i.price)),
        quantity: Number(i.qty),
      }));
    }

    const mRes = await fetch(`${midtransBase(creds)}/v2/charge`, {
      method: 'POST',
      headers: {
        Authorization: midtransAuthHeader(creds),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        /* Idempotency: percobaan yang sama tidak menagih dua kali */
        'X-Idempotency-Key': gatewayOrderId,
      },
      body: JSON.stringify(payload),
    });

    const mBody = await mRes.json().catch(() => ({}));

    /* Midtrans membalas 201 untuk QRIS yang berhasil dibuat */
    const okCodes = ['200', '201'];
    if (!mRes.ok || !okCodes.includes(String(mBody.status_code))) {
      console.error('Midtrans charge gagal', mRes.status, JSON.stringify(mBody));
      const msg = mBody.status_message || mBody.error_messages?.join(', ') ||
        `Gateway menolak (HTTP ${mRes.status})`;
      return fail(`Pembayaran gagal dibuat: ${msg}`, 502, origin);
    }

    /* Ambil URL QR. Utamakan versi v2 (format ASPI, ada border resmi). */
    const actions: Array<{ name: string; url: string }> = mBody.actions || [];
    const qrUrl =
      actions.find((a) => a.name === 'generate-qr-code-v2')?.url ||
      actions.find((a) => a.name === 'generate-qr-code')?.url ||
      null;

    if (!qrUrl) {
      console.error('Tidak ada URL QR pada respons', JSON.stringify(mBody));
      return fail('Gateway tidak mengirim kode QR', 502, origin);
    }

    /* ---------- 7. Simpan catatan pembayaran ---------- */
    const pRes = await sbAdmin('/rest/v1/payments', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        business_id: caller.businessId,
        order_id: orderId,
        gateway: 'midtrans',
        gateway_order_id: gatewayOrderId,
        gateway_txn_id: mBody.transaction_id || null,
        method: 'qris',
        acquirer: mBody.acquirer || null,
        amount,
        status: 'pending',
        qr_url: qrUrl,
        expires_at: expiresAt.toISOString(),
        raw: mBody,
      }),
    });

    if (!pRes.ok) {
      const t = await pRes.text();
      console.error('Gagal menyimpan payment', t);
      return fail('Tagihan dibuat di gateway tapi gagal disimpan. Cek menu Riwayat.', 500, origin);
    }

    return json({
      qr_url: qrUrl,
      gateway_order_id: gatewayOrderId,
      gateway_txn_id: mBody.transaction_id || null,
      expires_at: expiresAt.toISOString(),
      amount,
      order_no: order.order_no,
      attempt,
    }, 200, origin);

  } catch (e) {
    console.error('payment-create error', e);
    return fail('Terjadi kesalahan di server pembayaran', 500, origin);
  }
});
