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
    try { localStorage.removeItem(TOK); localStorage.removeItem(PROF); } catch (e) {}
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
      email: readProf() ? readProf().email : '',
    });
    return { ok: true };
  }

  return {
    user: () => readProf(),
    token,
    /* Profil yang baru berisi email saja belum lengkap — akun Auth sudah ada
       tapi tokonya belum dibuat. Jangan dianggap sudah masuk. */
    isLogged: () => { const p = readProf(); return !!readTok() && !!p && !!p.business_id; },
    /* Punya sesi Auth tapi belum punya toko */
    needsSetup: () => { const p = readProf(); return !!readTok() && (!p || !p.business_id); },
    isOwner: () => { const p = readProf(); return !!p && p.role === 'owner'; },
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
    async completeSetup({ bizName, name }) {
      const tk = await token();
      if (!tk) return { ok: false, msg: 'Sesi berakhir. Masuk kembali.' };

      const { error } = await API.rpc('setup_owner', {
        p_business_name: bizName, p_name: name,
      });
      if (error) return { ok: false, msg: error.message };

      const p = await loadProfile();
      if (!p.ok) { wipe(); return p; }
      return { ok: true };
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
    async signup({ bizName, name, email, password }) {
      if (typeof Demo !== 'undefined' && Demo.on()) {
        return { ok: false, msg: 'Pendaftaran tidak tersedia di mode demo' };
      }

      email = email.trim().toLowerCase();

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
        p_business_name: bizName, p_name: name,
      });
      if (error) { wipe(); return { ok: false, msg: error.message }; }

      const p = await loadProfile();
      if (!p.ok) { wipe(); return p; }
      return { ok: true };
    },

    /* ---------- Ubah password sendiri ---------- */
    async changePassword(newPassword) {
      if (typeof Demo !== 'undefined' && Demo.on()) {
        return { ok: true };
      }
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
