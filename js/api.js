/* ============================================================
   STOCKFLOW v5 — Klien Supabase (REST + RPC + Storage + Functions)

   Semua permintaan membawa JWT pengguna, sehingga RLS di database
   menentukan baris mana yang boleh dibaca/ditulis. Tidak ada
   penyaringan business_id dari sisi klien yang bisa dipalsukan.
   ============================================================ */

const API = (function () {

  /* Header permintaan.
     apikey selalu dikirim. Authorization HANYA dikirim kalau ada JWT
     pengguna sungguhan — key publishable baru (sb_publishable_...) bukan
     JWT, dan Supabase menolak permintaan dengan "Invalid JWT" kalau key
     itu ikut dikirim sebagai Bearer. */
  async function authHeaders() {
    const tk = await Auth.token();
    const h = {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    };
    if (tk) h.Authorization = 'Bearer ' + tk;
    return h;
  }

  function Query(table) {
    this.t = table;
    this.m = 'GET';
    this.cols = '*';
    this.f = [];
    this.ord = null;
    this.lim = null;
    this.body = null;
  }

  Query.prototype.select  = function (c) { this.cols = c || '*'; return this; };
  Query.prototype.eq      = function (c, v) { this.f.push([c, 'eq.' + v]); return this; };
  Query.prototype.neq     = function (c, v) { this.f.push([c, 'neq.' + v]); return this; };
  Query.prototype.gte     = function (c, v) { this.f.push([c, 'gte.' + v]); return this; };
  Query.prototype.lte     = function (c, v) { this.f.push([c, 'lte.' + v]); return this; };
  Query.prototype.lt      = function (c, v) { this.f.push([c, 'lt.' + v]); return this; };
  Query.prototype.ilike   = function (c, v) { this.f.push([c, 'ilike.' + v]); return this; };
  Query.prototype.is      = function (c, v) { this.f.push([c, 'is.' + v]); return this; };
  Query.prototype.inList  = function (c, a) { this.f.push([c, 'in.(' + a.join(',') + ')']); return this; };
  Query.prototype.order   = function (c, asc) { this.ord = c + '.' + (asc === false ? 'desc' : 'asc'); return this; };
  Query.prototype.limit   = function (n) { this.lim = n; return this; };
  Query.prototype.insert  = function (d) { this.m = 'POST'; this.body = Array.isArray(d) ? d : [d]; return this; };
  Query.prototype.update  = function (d) { this.m = 'PATCH'; this.body = d; return this; };
  Query.prototype.remove  = function () { this.m = 'DELETE'; return this; };

  Query.prototype.url = function () {
    const p = new URLSearchParams();
    if (this.m === 'GET') p.set('select', this.cols);
    this.f.forEach(([k, v]) => p.append(k, v));
    if (this.ord) p.set('order', this.ord);
    if (this.lim) p.set('limit', this.lim);
    const qs = p.toString();
    return SUPABASE_URL + '/rest/v1/' + this.t + (qs ? '?' + qs : '');
  };

  Query.prototype.run = async function (mode) {
    if (typeof Demo !== 'undefined' && Demo.on()) return Demo.query(this, mode);
    if (!SF_CONFIGURED) {
      return { data: null, error: { message: 'Supabase belum dikonfigurasi. Edit js/config.js' } };
    }

    const h = await authHeaders();
    if (this.m !== 'GET' && this.m !== 'DELETE') h.Prefer = 'return=representation';

    const opt = { method: this.m, headers: h };
    if (this.body) opt.body = JSON.stringify(this.body);

    try {
      const res  = await fetch(this.url(), opt);
      const txt  = await res.text();
      const json = txt ? JSON.parse(txt) : null;

      if (res.status === 401) { Auth.sessionExpired(); return { data: null, error: { message: 'Sesi berakhir' } }; }

      if (!res.ok) {
        let msg = (json && (json.message || json.hint || json.details)) || 'HTTP ' + res.status;
        /* Terjemahkan pesan RLS yang membingungkan */
        if (/row-level security|violates row-level/i.test(msg)) {
          msg = 'Anda tidak punya izin untuk tindakan ini';
        }
        return { data: null, error: { message: msg, status: res.status } };
      }

      if (this.m === 'DELETE') return { data: null, error: null };

      const arr = Array.isArray(json) ? json : json ? [json] : [];
      if (mode === 'single') {
        if (!arr.length) return { data: null, error: { message: 'Data tidak ditemukan' } };
        return { data: arr[0], error: null };
      }
      if (mode === 'maybe') return { data: arr.length ? arr[0] : null, error: null };
      return { data: arr, error: null };

    } catch (e) {
      return { data: null, error: { message: 'Koneksi gagal. Cek internet Anda.' } };
    }
  };

  Query.prototype.single      = function () { return this.run('single'); };
  Query.prototype.maybeSingle = function () { return this.run('maybe'); };
  Query.prototype.then        = function (ok, no) { return this.run().then(ok, no); };

  return {
    from: (t) => new Query(t),

    /* ---------- RPC (fungsi PostgreSQL) ---------- */
    async rpc(fn, args) {
      if (typeof Demo !== 'undefined' && Demo.on()) return Demo.rpc(fn, args || {});
      if (!SF_CONFIGURED) return { data: null, error: { message: 'Supabase belum dikonfigurasi' } };

      try {
        const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
          method: 'POST',
          headers: await authHeaders(),
          body: JSON.stringify(args || {}),
        });

        if (res.status === 401) { Auth.sessionExpired(); return { data: null, error: { message: 'Sesi berakhir' } }; }

        const txt  = await res.text();
        const json = txt ? JSON.parse(txt) : null;

        if (!res.ok) {
          let msg = (json && (json.message || json.hint)) || 'HTTP ' + res.status;
          /* RAISE EXCEPTION dari Postgres sampai di sini apa adanya */
          msg = msg.replace(/^ERROR:\s*/i, '');
          return { data: null, error: { message: msg, status: res.status } };
        }
        return { data: json, error: null };

      } catch (e) {
        return { data: null, error: { message: 'Koneksi gagal. Cek internet Anda.' } };
      }
    },

    /* ---------- Edge Function ---------- */
    async invoke(name, body) {
      if (typeof Demo !== 'undefined' && Demo.on()) return Demo.invoke(name, body || {});
      if (!SF_CONFIGURED) return { data: null, error: { message: 'Supabase belum dikonfigurasi' } };

      const tk = await Auth.token();
      if (!tk) { Auth.sessionExpired(); return { data: null, error: { message: 'Sesi berakhir' } }; }

      try {
        const res = await fetch(FUNCTIONS_URL + '/' + name, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: 'Bearer ' + tk,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body || {}),
        });

        const txt  = await res.text();
        const json = txt ? JSON.parse(txt) : null;

        if (res.status === 401) { Auth.sessionExpired(); return { data: null, error: { message: 'Sesi berakhir' } }; }

        if (!res.ok) {
          return {
            data: null,
            error: {
              message: (json && json.error) || 'Fungsi gagal (HTTP ' + res.status + ')',
              status: res.status,
            },
          };
        }
        return { data: json, error: null };

      } catch (e) {
        return {
          data: null,
          error: { message: 'Tidak bisa menghubungi server pembayaran. Cek internet.' },
        };
      }
    },

    /* ---------- Upload ke Storage ---------- */
    async upload(file, folder) {
      if (typeof Demo !== 'undefined' && Demo.on()) return Demo.upload(file);
      if (!SF_CONFIGURED) return null;

      const tk = await Auth.token();
      if (!tk) return null;

      try {
        const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const path = folder + '/' + Date.now() + '-' +
                     Math.random().toString(36).slice(2, 8) + '.' + ext;

        const res = await fetch(
          SUPABASE_URL + '/storage/v1/object/' + STORAGE_BUCKET + '/' + path,
          {
            method: 'POST',
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: 'Bearer ' + tk,
              'Content-Type': file.type || 'image/jpeg',
              'x-upsert': 'true',
            },
            body: file,
          },
        );
        if (!res.ok) return null;
        return SUPABASE_URL + '/storage/v1/object/public/' + STORAGE_BUCKET + '/' + path;
      } catch (e) {
        return null;
      }
    },
  };
})();
