// ============================================================
// payment-webhook — menerima notifikasi pembayaran dari Midtrans
//
// Dipanggil oleh Midtrans, BUKAN oleh browser.
// Harus dideploy dengan --no-verify-jwt karena Midtrans tidak
// mengirim JWT Supabase.
//
// Keamanan bertumpu pada verifikasi signature:
//   SHA512(order_id + status_code + gross_amount + server_key)
// Tanpa server_key, pihak lain tidak bisa memalsukan notifikasi.
//
// Set URL ini di Midtrans Dashboard > Settings > Configuration
//   > Payment Notification URL
// ============================================================

import {
  json, fail, sbRpc, midtransSignature, safeEqual, mapMidtransStatus,
  credsForGatewayOrder, midtransBase, midtransAuthHeader,
} from '../_shared/lib.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return fail('Metode tidak diizinkan', 405);

  try {
    const n = await req.json().catch(() => null);
    if (!n) return fail('Body bukan JSON', 400);

    const orderId     = String(n.order_id ?? '');
    const statusCode  = String(n.status_code ?? '');
    const grossAmount = String(n.gross_amount ?? '');
    const sigReceived = String(n.signature_key ?? '');

    if (!orderId || !statusCode || !grossAmount || !sigReceived) {
      return fail('Notifikasi tidak lengkap', 400);
    }

    /* ---------- 1. Verifikasi signature ----------
       Signature dihitung dengan Server Key milik toko yang bertransaksi,
       karena tiap toko bisa memakai akun Midtrans sendiri. */
    const creds = await credsForGatewayOrder(orderId);
    if (!creds) {
      console.error('tidak ada kredensial untuk', orderId);
      return fail('Notifikasi tidak dapat diverifikasi', 403);
    }

    const expected = await midtransSignature(orderId, statusCode, grossAmount, creds.serverKey);

    if (!safeEqual(expected, sigReceived.toLowerCase())) {
      /* Jangan beri tahu penyerang bahwa signature-nya salah secara spesifik */
      console.warn('Signature tidak valid untuk order', orderId);
      return fail('Notifikasi tidak dapat diverifikasi', 403);
    }

    /* ---------- 2. Konfirmasi ulang langsung ke Midtrans ----------
       Lapisan kedua: walau signature sah, status diambil dari sumber
       aslinya supaya replay notifikasi lama tidak bisa mengubah status. */
    let txStatus  = String(n.transaction_status ?? '');
    let fraud     = String(n.fraud_status ?? '');
    let txnId     = n.transaction_id ? String(n.transaction_id) : null;
    let issuer    = n.issuer ? String(n.issuer) : (n.acquirer ? String(n.acquirer) : null);

    try {
      const sRes = await fetch(`${midtransBase(creds)}/v2/${encodeURIComponent(orderId)}/status`, {
        headers: { Authorization: midtransAuthHeader(creds), Accept: 'application/json' },
      });
      if (sRes.ok) {
        const s = await sRes.json();
        if (s?.transaction_status) {
          txStatus = String(s.transaction_status);
          fraud    = String(s.fraud_status ?? fraud);
          txnId    = s.transaction_id ? String(s.transaction_id) : txnId;
          issuer   = s.issuer ? String(s.issuer) : (s.acquirer ? String(s.acquirer) : issuer);
        }
      } else {
        console.warn('Cek status ke Midtrans gagal, memakai payload notifikasi', sRes.status);
      }
    } catch (e) {
      console.warn('Cek status ke Midtrans error, memakai payload notifikasi', e);
    }

    const status = mapMidtransStatus(txStatus, fraud);

    /* ---------- 3. Terapkan ke database ---------- */
    if (status === 'paid') {
      const r = await sbRpc('order_settle', {
        p_gateway_order_id: orderId,
        p_txn_id: txnId,
        p_issuer: issuer,
        p_raw: n,
      });
      console.log('settle', orderId, JSON.stringify(r));
    } else if (status === 'expired' || status === 'failed') {
      const r = await sbRpc('order_mark_failed', {
        p_gateway_order_id: orderId,
        p_status: status,
      });
      console.log('mark', status, orderId, JSON.stringify(r));
    } else {
      /* pending — tidak ada yang perlu diubah */
      console.log('pending', orderId);
    }

    /* Midtrans menganggap notifikasi berhasil bila kita balas 200.
       Selalu balas 200 setelah signature terverifikasi, agar Midtrans
       tidak mengirim ulang terus-menerus untuk kondisi yang sudah final. */
    return json({ received: true, status });

  } catch (e) {
    console.error('payment-webhook error', e);
    /* 500 membuat Midtrans mencoba lagi nanti — itu yang kita mau
       kalau kegagalannya di sisi kita. */
    return fail('Gagal memproses notifikasi', 500);
  }
});
