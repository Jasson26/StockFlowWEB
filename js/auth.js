/* ============================================================
   STOCKFLOW v5 — Otentikasi via Supabase Auth
   ------------------------------------------------------------
   Password tidak pernah disimpan oleh aplikasi. Supabase yang
   melakukan hashing dan menerbitkan JWT. Yang kita simpan di
   localStorage hanyalah token (access + refresh) dan profil.
   ============================================================ */

const Auth = (function () {
  const TOK  = 'sf5_token';
  const PROF = 'sf5_profile';
  const MFA  = 'sf5_mfa_pending';   // sesi sementara menunggu kode 6 angka (sessionStorage)

  /* ---------- Penyimpanan token ---------- */
  function readTok() {
    try { return JSON.parse(localStorage.getItem(TOK) || 'null'); }
    catch (e) { return null; }
  }
  function writeTok(t) {
    try {
      localStorage.setItem(TOK, JSON.stringify({
        access_token:  t.access_token,
        refresh_token: t.refresh_token,
        /* Beri margin 60 detik supaya tidak dipakai saat hampir mati */
        expires_at: Date.now() + ((t.expires_in || 3600) - 60) * 1000,
      }));
    } catch (e) {}
  }
  function readProf() {
    try { return JSON.parse(localStorage.getItem(PROF) || 'null'); }
    catch (e) { return null; }
  }
  function writeProf(p) {
    try { localStorage.setItem(PROF, JSON.stringify(p)); } catch (e) {}
  }
  function wipe() {
    try { localStorage.removeItem(TOK); localStorage.removeItem(PROF); sessionStorage.removeItem(MFA); } catch (e) {}
  }

  const H = () => ({ apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' });

  /* ---------- Refresh token ---------- */
  let refreshing = null;

  async function refresh() {
    const t = readTok();
    if (!t || !t.refresh_token) return null;

    /* Hindari beberapa refresh paralel */
    if (refreshing) return refreshing;

    refreshing = (async function () {
      try {
        const res = await fetch(
          SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token',
          { method: 'POST', headers: H(), body: JSON.stringify({ refresh_token: t.refresh_token }) },
        );
        if (!res.ok) { wipe(); return null; }
        const d = await res.json();
        if (!d.access_token) { wipe(); return null; }
        writeTok(d);
        return d.access_token;
      } catch (e) {
        return null;
      } finally {
        refreshing = null;
      }
    })();

    return refreshing;
  }

  /* Token yang dijamin masih berlaku — dipakai api.js */
  async function token() {
    if (typeof Demo !== 'undefined' && Demo.on()) return 'demo';
    const t = readTok();
    if (!t) return null;
    if (Date.now() < t.expires_at) return t.access_token;
    return await refresh();
  }

  /* ---------- Muat profil + info toko ---------- */
  async function loadProfile() {
    const { data: prof, error: e1 } = await API.from('profiles')
      .select('id,business_id,name,role,active').limit(1).maybeSingle();

    /* Akun Auth ada tapi belum punya profil. Terjadi kalau konfirmasi email
       aktif: sesi baru terbit setelah link diklik, sehingga setup_owner
       belum sempat jalan saat mendaftar. Bukan error — tinggal diselesaikan. */
    if (e1 || !prof) {
      /* Akun khusus admin platform: tidak punya toko, hanya membuka panel Admin */
      const adm = await API.rpc('am_i_admin', {});
      if (!adm.error && adm.data && adm.data.admin) {
        const old = readProf() || {};
        writeProf({
          name: 'Admin StockFlow', role: 'admin', business_id: null,
          business_name: 'Admin StockFlow', is_admin: true, admin_only: true,
          email: old.email || '',
        });
        return { ok: true, adminOnly: true };
      }
      return {
        ok: false,
        needSetup: true,
        msg: 'Akun Anda sudah aktif, tapi datanya belum lengkap. Lengkapi nama toko untuk melanjutkan.',
      };
    }
    if (!prof.active) {
      return { ok: false, msg: 'Akun Anda dinonaktifkan. Hubungi owner.' };
    }

    const { data: biz } = await API.from('businesses')
      .select('*').eq('id', prof.business_id).maybeSingle();

    writeProf({
      id: prof.id,
      name: prof.name,
      role: prof.role,
      business_id: prof.business_id,
      business_name: biz ? biz.name : 'Toko Saya',
      business_address: biz ? biz.address : null,
      business_phone: biz ? biz.phone : null,
      tax_percent: biz ? Number(biz.tax_percent || 0) : 0,
      qris_enabled: biz ? !!biz.qris_enabled : false,
      qris_static_url: biz ? biz.qris_static_url : null,
      receipt_note: biz ? biz.receipt_note : '',
      active_until: biz ? biz.active_until || null : null,
      suspended: biz ? !!biz.suspended : false,
      is_admin: await (async function () {
        const r = await API.rpc('am_i_admin', {});
        if (!r.error && r.data) return !!r.data.admin;
        const r2 = await API.rpc('is_platform_admin', {});   // sebelum migrasi 06
        return !r2.error && r2.data === true;
      })(),
      email: readProf() ? readProf().email : '',
    });
    return { ok: true };
  }

  /* Minta tantangan lalu kirim kode 6 angka; hasilnya sesi baru (aal2) */
  async function mfaChallengeVerify(accessToken, factorId, code) {
    if (!/^\d{6}$/.test(String(code || '').trim())) return { ok: false, msg: 'Kode harus 6 angka' };
    const H2 = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' };
    try {
      const c = await fetch(SUPABASE_URL + '/auth/v1/factors/' + factorId + '/challenge', { method: 'POST', headers: H2, body: '{}' });
      const cd = await c.json().catch(() => ({}));
      if (!c.ok || !cd.id) return { ok: false, msg: cd.msg || 'Gagal meminta verifikasi' };
      const v = await fetch(SUPABASE_URL + '/auth/v1/factors/' + factorId + '/verify', {
        method: 'POST', headers: H2, body: JSON.stringify({ challenge_id: cd.id, code: String(code).trim() }),
      });
      const vd = await v.json().catch(() => ({}));
      if (!v.ok || !vd.access_token) return { ok: false, msg: 'Kode salah atau sudah kedaluwarsa' };
      return { ok: true, session: vd };
    } catch (e) {
      return { ok: false, msg: 'Tidak bisa menghubungi server' };
    }
  }

  return {
    user: () => readProf(),
    token,
    /* Profil yang baru berisi email saja belum lengkap — akun Auth sudah ada
       tapi tokonya belum dibuat. Jangan dianggap sudah masuk. */
    isLogged: () => { const p = readProf(); return !!readTok() && !!p && (!!p.business_id || !!p.admin_only); },
    /* Punya sesi Auth tapi belum punya toko (akun khusus admin dikecualikan) */
    needsSetup: () => { const p = readProf(); return !!readTok() && (!p || (!p.business_id && !p.admin_only)); },
    /* Halaman awal setelah masuk */
    home: () => { const p = readProf(); return p && p.admin_only ? 'admin.html' : 'pos.html'; },
    isOwner: () => { const p = readProf(); return !!p && p.role === 'owner'; },
    isAdmin: () => { const p = readProf(); return !!p && !!p.is_admin; },
    /* Status langganan toko: { active, permanent, daysLeft, until } */
    subscription: () => {
      const p = readProf() || {};
      if (p.suspended) return { active: false, suspended: true };
      if (!p.active_until) return { active: true, permanent: true };
      const ms = new Date(p.active_until) - Date.now();
      return { active: ms > 0, permanent: false, until: p.active_until, daysLeft: Math.ceil(ms / 86400000) };
    },
    bizId:   () => { const p = readProf(); return p ? p.business_id : null; },

    /* ---------- Masuk ---------- */
    async login(email, password) {
      if (typeof Demo !== 'undefined' && Demo.on()) return Demo.login(email, password);

      let res;
      try {
        res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
          method: 'POST', headers: H(),
          body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
        });
      } catch (e) {
        return { ok: false, msg: 'Tidak bisa menghubungi server. Cek koneksi internet.' };
      }

      const d = await res.json().catch(() => ({}));

      if (!res.ok) {
        const m = String(d.error_description || d.msg || d.message || '');
        if (/invalid login/i.test(m))      return { ok: false, msg: 'Email atau password salah' };
        if (/not confirmed/i.test(m))      return { ok: false, msg: 'Email belum dikonfirmasi' };
        if (/rate limit|too many/i.test(m)) return { ok: false, msg: 'Terlalu banyak percobaan. Tunggu sebentar.' };
        return { ok: false, msg: m || 'Gagal masuk' };
      }

      /* Verifikasi 2 langkah aktif: sesi belum dianggap masuk sampai kode 6 angka benar */
      const factors = ((d.user && d.user.factors) || []).filter((f) => f.status === 'verified' && f.factor_type === 'totp');
      if (factors.length) {
        try {
          sessionStorage.setItem(MFA, JSON.stringify({
            access_token: d.access_token, refresh_token: d.refresh_token, expires_in: d.expires_in,
            factor_id: factors[0].id, email: (d.user && d.user.email) || email.trim().toLowerCase(),
          }));
        } catch (e) {}
        return { ok: false, needMfa: true };
      }

      writeTok(d);
      /* Simpan email dari respons untuk ditampilkan di Pengaturan */
      writeProf({ email: (d.user && d.user.email) || email.trim().toLowerCase() });

      const p = await loadProfile();
      /* Kalau tinggal melengkapi toko, sesi DIPERTAHANKAN — setup_owner
         butuh token ini. Hanya sesi yang benar-benar bermasalah yang dihapus. */
      if (!p.ok && !p.needSetup) { wipe(); return p; }
      return p.ok ? { ok: true } : p;
    },

    /* ---------- Lengkapi toko untuk akun yang sudah aktif ----------
       Dipakai kalau pendaftaran sempat terputus oleh konfirmasi email. */
    async completeSetup({ bizName, name, code }) {
      const tk = await token();
      if (!tk) return { ok: false, msg: 'Sesi berakhir. Masuk kembali.' };

      const { error } = await API.rpc('setup_owner', {
        p_business_name: bizName, p_name: name, p_code: code || '',
      });
      if (error) return { ok: false, msg: error.message };
      try { localStorage.removeItem('sf5_pending_code'); } catch (e) {}

      const p = await loadProfile();
      if (!p.ok) { wipe(); return p; }
      return { ok: true };
    },

    /* ---------- Verifikasi 2 langkah (TOTP, mis. Google Authenticator) ---------- */
    async verifyLoginMfa(code) {
      let p = null;
      try { p = JSON.parse(sessionStorage.getItem(MFA) || 'null'); } catch (e) {}
      if (!p) return { ok: false, msg: 'Sesi masuk kedaluwarsa. Ulangi dari awal.' };
      const r = await mfaChallengeVerify(p.access_token, p.factor_id, code);
      if (!r.ok) return r;
      try { sessionStorage.removeItem(MFA); } catch (e) {}
      writeTok(r.session);
      writeProf({ email: p.email });
      const lp = await loadProfile();
      if (!lp.ok && !lp.needSetup) { wipe(); return lp; }
      return lp.ok ? { ok: true } : lp;
    },

    mfaPending: () => { try { return !!sessionStorage.getItem(MFA); } catch (e) { return false; } },

    /* Daftar faktor milik akun yang sedang masuk */
    async mfaFactors() {
      const tk = await token();
      if (!tk || tk === 'demo') return [];
      const res = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tk } });
      const d = await res.json().catch(() => ({}));
      return (d.factors || []).filter((f) => f.factor_type === 'totp');
    },

    /* Mulai pendaftaran: kembalikan QR & kode rahasia untuk dipindai */
    async mfaEnroll() {
      const tk = await token();
      if (!tk || tk === 'demo') return { ok: false, msg: 'Tidak tersedia di mode demo' };
      const H2 = { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
      /* Hapus pendaftaran lama yang belum selesai */
      for (const f of await Auth.mfaFactors()) {
        if (f.status !== 'verified') await fetch(SUPABASE_URL + '/auth/v1/factors/' + f.id, { method: 'DELETE', headers: H2 });
      }
      const res = await fetch(SUPABASE_URL + '/auth/v1/factors', {
        method: 'POST', headers: H2,
        body: JSON.stringify({ factor_type: 'totp', friendly_name: 'StockFlow ' + new Date().toISOString().slice(0, 16), issuer: 'StockFlow' }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, msg: d.msg || d.message || 'Gagal memulai verifikasi 2 langkah' };
      return { ok: true, id: d.id, qr: d.totp && d.totp.qr_code, secret: d.totp && d.totp.secret };
    },

    async mfaConfirm(factorId, code) {
      const tk = await token();
      const r = await mfaChallengeVerify(tk, factorId, code);
      if (!r.ok) return r;
      writeTok(r.session);          // sesi naik ke aal2
      return { ok: true };
    },

    async mfaRemove(factorId) {
      const tk = await token();
      const res = await fetch(SUPABASE_URL + '/auth/v1/factors/' + factorId, {
        method: 'DELETE', headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tk },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        return { ok: false, msg: /aal2|AAL2/.test(d.msg || d.message || '') ? 'Masuk ulang dengan kode 6 angka dulu' : (d.msg || d.message || 'Gagal') };
      }
      return { ok: true };
    },

    /* Tingkat keamanan sesi saat ini: 'aal1' (password) / 'aal2' (password + kode) */
    aal() {
      const t = readTok();
      if (!t || !t.access_token || t.access_token === 'demo') return 'aal1';
      try {
        const b = t.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(b)).aal || 'aal1';
      } catch (e) { return 'aal1'; }
    },

    /* Aturan password: minimal 8 karakter, ada huruf dan angka */
    passwordIssue(pw) {
      pw = String(pw || '');
      if (pw.length < 8) return 'Password minimal 8 karakter';
      if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password harus berisi huruf dan angka';
      if (/^(password|12345678|qwerty12|stockflow1?)$/i.test(pw)) return 'Password terlalu mudah ditebak';
      return null;
    },

    /* ---------- Masuk sebagai karyawan: username + kode unik ---------- */
    async staffLogin(username, code) {
      if (typeof Demo !== 'undefined' && Demo.on()) {
        return { ok: false, msg: 'Tidak tersedia di mode demo' };
      }
      let res;
      try {
        res = await fetch(FUNCTIONS_URL + '/staff-login', {
          method: 'POST', headers: H(),
          body: JSON.stringify({ username: String(username || '').trim(), code: String(code || '').trim() }),
        });
      } catch (e) {
        return { ok: false, msg: 'Tidak bisa menghubungi server. Cek koneksi internet.' };
      }
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.access_token) return { ok: false, msg: d.error || 'Username atau kode salah' };

      writeTok(d);
      writeProf({ email: '' });
      const p = await loadProfile();
      if (!p.ok) { wipe(); return p; }
      return { ok: true };
    },

    /* ---------- Daftar toko baru (owner) ---------- */
    /* Kode aktivasi dicek dulu supaya akun tidak terlanjur dibuat
       dengan kode yang salah. Pengecekan final tetap di setup_owner. */
    async checkCode(code) {
      if (typeof Demo !== 'undefined' && Demo.on()) return { ok: true };
      const { data, error } = await API.rpc('check_activation_code', { p_code: code || '' });
      if (error) return { ok: false, msg: 'Tidak bisa memeriksa kode. Cek koneksi.' };
      return data && data.ok ? { ok: true, days: data.days } : { ok: false, msg: 'Kode aktivasi tidak valid atau sudah dipakai' };
    },

    async signup({ bizName, name, email, password, code }) {
      if (typeof Demo !== 'undefined' && Demo.on()) {
        return { ok: false, msg: 'Pendaftaran tidak tersedia di mode demo' };
      }

      email = email.trim().toLowerCase();

      const pwi = Auth.passwordIssue(password);
      if (pwi) return { ok: false, msg: pwi };

      const cc = await Auth.checkCode(code);
      if (!cc.ok) return cc;
      /* Disimpan sementara: dipakai lagi kalau konfirmasi email membuat
         pembuatan toko tertunda sampai pengguna masuk */
      try { localStorage.setItem('sf5_pending_code', code); } catch (e) {}

      let res;
      try {
        res = await fetch(SUPABASE_URL + '/auth/v1/signup', {
          method: 'POST', headers: H(),
          body: JSON.stringify({ email, password, data: { name: name } }),
        });
      } catch (e) {
        return { ok: false, msg: 'Tidak bisa menghubungi server. Cek koneksi internet.' };
      }

      const d = await res.json().catch(() => ({}));

      if (!res.ok) {
        const m = String(d.error_description || d.msg || d.message || '');
        if (/already registered|already exists/i.test(m)) {
          return { ok: false, msg: 'Email sudah terdaftar. Silakan masuk.' };
        }
        if (/password/i.test(m) && /short|least/i.test(m)) {
          return { ok: false, msg: 'Password terlalu pendek (minimal 8 karakter)' };
        }
        return { ok: false, msg: m || 'Gagal mendaftar' };
      }

      /* Kalau konfirmasi email aktif, belum ada sesi yang bisa dipakai */
      if (!d.access_token) {
        return {
          ok: false,
          needConfirm: true,
          msg: 'Akun dibuat. Cek email untuk konfirmasi, lalu masuk.',
        };
      }

      writeTok(d);
      writeProf({ email: email });

      /* Buat business + profile owner lewat RPC */
      const { data: r, error } = await API.rpc('setup_owner', {
        p_business_name: bizName, p_name: name, p_code: code,
      });
      if (error) { wipe(); return { ok: false, msg: error.message }; }
      try { localStorage.removeItem('sf5_pending_code'); } catch (e) {}

      const p = await loadProfile();
      if (!p.ok) { wipe(); return p; }
      return { ok: true };
    },

    /* ---------- Ubah password sendiri ---------- */
    async changePassword(newPassword) {
      if (typeof Demo !== 'undefined' && Demo.on()) {
        return { ok: true };
      }
      const pwi = Auth.passwordIssue(newPassword);
      if (pwi) return { ok: false, msg: pwi };

      const tk = await token();
      if (!tk) return { ok: false, msg: 'Sesi berakhir. Masuk kembali.' };

      const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
        method: 'PUT',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        const m = String(d.error_description || d.msg || d.message || '');
        return { ok: false, msg: m || 'Gagal mengubah password' };
      }
      return { ok: true };
    },

    /* ---------- Kirim email reset password ---------- */
    async resetPassword(email) {
      if (typeof Demo !== 'undefined' && Demo.on()) {
        return { ok: false, msg: 'Tidak tersedia di mode demo' };
      }
      const res = await fetch(SUPABASE_URL + '/auth/v1/recover', {
        method: 'POST', headers: H(),
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      /* Supabase selalu membalas 200 agar tidak membocorkan email mana
         yang terdaftar — kita tampilkan pesan netral yang sama. */
      return { ok: res.ok };
    },

    /* Segarkan profil (setelah ubah info toko) */
    reload: loadProfile,

    async logout() {
      /* Karyawan butuh izin owner (password akun owner) untuk keluar */
      const me = readProf();
      if (me && me.role === 'staff' && typeof UI !== 'undefined' && UI.ownerUnlock &&
          !(typeof Demo !== 'undefined' && Demo.on())) {
        const ok = await UI.ownerUnlock();
        if (!ok) return;
      }

      const tk = readTok();
      if (tk && typeof Demo !== 'undefined' && !Demo.on()) {
        /* Cabut refresh token di server; abaikan kalau gagal */
        try {
          await fetch(SUPABASE_URL + '/auth/v1/logout', {
            method: 'POST',
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + tk.access_token },
          });
        } catch (e) {}
      }
      wipe();
      location.href = 'masuk.html';
    },

    /* Pasang di awal setiap halaman internal */
    guard(ownerOnly) {
      if (!readTok() || !readProf()) { location.replace('masuk.html'); return false; }
      /* Akun khusus admin tidak punya toko: hanya boleh di panel Admin */
      if (readProf().admin_only && !/admin\.html$/.test(location.pathname)) {
        location.replace('admin.html'); return false;
      }
      if (ownerOnly && !Auth.isOwner()) { location.replace('pos.html'); return false; }
      return true;
    },

    /* Dipanggil api.js saat server membalas 401 */
    sessionExpired() {
      wipe();
      location.replace('masuk.html?expired=1');
    },
  };
})();
