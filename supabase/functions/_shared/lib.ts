// ============================================================
// StockFlow v5 — helper bersama untuk semua Edge Function
// ============================================================

/* ---------- CORS ----------
   ALLOWED_ORIGINS adalah daftar origin dipisah koma, mis.
   "https://jasson26.github.io,http://localhost:5500"
   Kalau tidak diset, semua origin diizinkan (hanya untuk pengembangan). */
export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',')
    .map((s) => s.trim()).filter(Boolean);

  let allowOrigin = '*';
  if (allowed.length) {
    allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export function json(body: unknown, status = 200, origin: string | null = null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

export function fail(message: string, status = 400, origin: string | null = null) {
  return json({ error: message }, status, origin);
}

/* ---------- Env wajib ---------- */
export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Environment variable ${name} belum diset`);
  return v;
}

/* ---------- Key Supabase: dukung format lama & baru ----------
   Supabase sedang memindahkan anon/service_role (JWT) ke
   publishable/secret (bukan JWT, disimpan sebagai JSON per nama).
   Keduanya didukung di sini supaya kode jalan di project lama maupun baru. */

function fromJsonEnv(name: string): string | null {
  const raw = Deno.env.get(name);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o.default || o[Object.keys(o)[0]] || null;
  } catch {
    return null;
  }
}

/** Key publik — untuk memverifikasi token pengguna. */
export function publicKey(): string {
  const k = Deno.env.get('SUPABASE_ANON_KEY') || fromJsonEnv('SUPABASE_PUBLISHABLE_KEYS');
  if (!k) throw new Error('Tidak ada SUPABASE_ANON_KEY / SUPABASE_PUBLISHABLE_KEYS');
  return k;
}

/** Key rahasia — melewati RLS. Hanya untuk dipakai di dalam fungsi ini. */
export function adminKey(): string {
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || fromJsonEnv('SUPABASE_SECRET_KEYS');
  if (!k) throw new Error('Tidak ada SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEYS');
  return k;
}

/* Key format baru bukan JWT, jadi tidak boleh dikirim sebagai Bearer. */
const isJwt = (k: string) => k.startsWith('eyJ');

function keyHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key };
  if (isJwt(key)) h.Authorization = `Bearer ${key}`;
  return h;
}

/* ---------- Supabase REST dengan service_role ----------
   Dipakai untuk operasi yang harus melewati RLS (webhook, buat user). */
export async function sbAdmin(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${env('SUPABASE_URL')}${path}`, {
    ...init,
    headers: {
      ...keyHeaders(adminKey()),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

/* Panggil Auth Admin API (buat/ubah/hapus pengguna) dengan key rahasia */
export async function authAdmin(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${env('SUPABASE_URL')}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      ...keyHeaders(adminKey()),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

/* Panggil RPC Postgres sebagai service_role */
export async function sbRpc(fn: string, args: unknown): Promise<unknown> {
  const res = await sbAdmin(`/rest/v1/rpc/${fn}`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC ${fn} gagal (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

/* ---------- Identitas pemanggil dari JWT ----------
   Memverifikasi token lewat Supabase Auth, lalu membaca profilnya.
   Mengembalikan null kalau token tidak sah atau profil tidak aktif. */
export type Caller = {
  userId: string;
  businessId: string;
  name: string;
  role: 'owner' | 'staff';
};

export async function getCaller(req: Request): Promise<Caller | null> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);

  // 1. Verifikasi token
  const uRes = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: publicKey() },
  });
  if (!uRes.ok) return null;
  const user = await uRes.json();
  if (!user?.id) return null;

  // 2. Ambil profil (service_role, karena RLS butuh konteks yang sama)
  const pRes = await sbAdmin(
    `/rest/v1/profiles?id=eq.${user.id}&select=business_id,name,role,active`,
  );
  if (!pRes.ok) return null;
  const rows = await pRes.json();
  const p = rows?.[0];
  if (!p || !p.active) return null;

  return { userId: user.id, businessId: p.business_id, name: p.name, role: p.role };
}

/* ---------- Midtrans ----------
   Tiap toko boleh memasang Server Key-nya sendiri supaya dana masuk
   ke rekening mereka. Kalau belum dipasang, dipakai key dari
   environment (akun pemilik deployment) sebagai cadangan. */

export type MidtransCreds = {
  serverKey: string;
  isProduction: boolean;
  /** true kalau berasal dari toko, false kalau dari environment */
  perBusiness: boolean;
};

export function envCreds(): MidtransCreds | null {
  const k = Deno.env.get('MIDTRANS_SERVER_KEY');
  if (!k) return null;
  return {
    serverKey: k,
    isProduction: (Deno.env.get('MIDTRANS_IS_PRODUCTION') || 'false').toLowerCase() === 'true',
    perBusiness: false,
  };
}

/** Ambil kredensial milik toko; jatuh ke environment bila belum ada. */
export async function credsFor(businessId: string): Promise<MidtransCreds | null> {
  try {
    const res = await sbAdmin(
      `/rest/v1/payment_credentials?business_id=eq.${businessId}` +
      `&select=server_key,is_production&limit=1`,
    );
    if (res.ok) {
      const row = (await res.json())?.[0];
      if (row?.server_key) {
        return {
          serverKey: row.server_key,
          isProduction: !!row.is_production,
          perBusiness: true,
        };
      }
    }
  } catch (e) {
    console.error('gagal membaca payment_credentials', e);
  }
  return envCreds();
}

/** Cari kredensial dari gateway_order_id (dipakai webhook). */
export async function credsForGatewayOrder(gatewayOrderId: string): Promise<MidtransCreds | null> {
  try {
    const res = await sbAdmin(
      `/rest/v1/payments?gateway_order_id=eq.${encodeURIComponent(gatewayOrderId)}` +
      `&select=business_id&limit=1`,
    );
    if (res.ok) {
      const row = (await res.json())?.[0];
      if (row?.business_id) return await credsFor(row.business_id);
    }
  } catch (e) {
    console.error('gagal mencari business dari gateway_order_id', e);
  }
  return envCreds();
}

export function midtransBase(c: MidtransCreds): string {
  return c.isProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
}

export function midtransAuthHeader(c: MidtransCreds): string {
  // Basic base64(server_key + ":")
  return 'Basic ' + btoa(c.serverKey + ':');
}

/* SHA512(order_id + status_code + gross_amount + server_key) */
export async function midtransSignature(
  orderId: string,
  statusCode: string,
  grossAmount: string,
  serverKey: string,
): Promise<string> {
  const input = `${orderId}${statusCode}${grossAmount}${serverKey}`;
  const buf = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* Perbandingan waktu-konstan agar tidak bocor lewat timing */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* Petakan status Midtrans -> status internal kita */
export function mapMidtransStatus(
  transactionStatus: string,
  fraudStatus?: string,
): 'paid' | 'pending' | 'expired' | 'failed' {
  if (fraudStatus === 'deny') return 'failed';
  switch (transactionStatus) {
    case 'capture':
    case 'settlement':
      return 'paid';
    case 'pending':
      return 'pending';
    case 'expire':
      return 'expired';
    case 'deny':
    case 'cancel':
    case 'failure':
      return 'failed';
    default:
      return 'pending';
  }
}
