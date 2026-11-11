// Дневник рыбалок: хранение в Supabase через RPC-функции и вход по почте (Supabase Auth, REST без SDK).
// Без входа дневник привязан к устройству секретным ключом; после входа — к аккаунту.
(function (global) {
  'use strict';
  const cfg = global.APP_CONFIG || {};
  const base = cfg.supabaseUrl, apikey = cfg.supabaseKey;
  const LS_KEY = 'ff_diary_key', LS_SES = 'ff_session';

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  };
  let session = null;
  try { session = JSON.parse(ls.get(LS_SES) || 'null'); } catch (e) {}

  function saveSession(s) { session = s; ls.set(LS_SES, s ? JSON.stringify(s) : null); }
  const fromAuth = (j, email) => ({
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    email: (j.user && j.user.email) || email,
  });

  function authMessage(j) {
    const m = String(j.msg || j.error_description || j.message || j.error || '');
    if (/invalid login credentials/i.test(m)) return 'Неверная почта или пароль';
    if (/already registered|already been registered|exists/i.test(m)) return 'Эта почта уже зарегистрирована — нажмите «Войти»';
    if (/password should be at least|weak/i.test(m)) return 'Пароль слишком простой: нужно минимум 6 символов';
    if (/email not confirmed/i.test(m)) return 'Почта не подтверждена — откройте письмо от Supabase';
    if (/rate limit|too many/i.test(m)) return 'Слишком много попыток, подождите несколько минут';
    if (/invalid.*email|validate email|email address/i.test(m)) return 'Проверьте адрес почты';
    if (/signups not allowed|signup.*disabled/i.test(m)) return 'Регистрация новых аккаунтов отключена в настройках базы';
    return m || 'Не удалось войти';
  }

  async function authReq(path, body, token) {
    const r = await fetchT(`${base}/auth/v1/${path}`, {
      method: 'POST',
      headers: {apikey, 'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})},
      body: JSON.stringify(body || {}),
    });
    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw new Error(authMessage(j));
    return j;
  }

  async function token() {
    if (!session) return null;
    if (session.expires_at - 60 < Date.now() / 1000) {
      try {
        saveSession(fromAuth(await authReq('token?grant_type=refresh_token', {refresh_token: session.refresh_token}), session.email));
      } catch (e) { saveSession(null); return null; }
    }
    return session.access_token;
  }

  async function rpc(fn, args) {
    const t = await token();
    const r = await fetchT(`${base}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {apikey, 'Content-Type': 'application/json', ...(t ? {Authorization: 'Bearer ' + t} : {})},
      body: JSON.stringify(args || {}),
    });
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch (e) {}
    if (!r.ok) {
      const err = new Error((j && j.message) || `Ошибка сервера (${r.status})`);
      err.code = j && j.code;
      throw err;
    }
    return j;
  }

  const key = () => ls.get(LS_KEY);
  const notFound = e => e.code === 'P0002' || /Дневник не найден/.test(e.message);

  async function create() {
    const k = await rpc('fishing_diary_create');
    ls.set(LS_KEY, k);
    return k;
  }

  async function list() {
    if (!key() && !session) return [];
    try { return await rpc('fishing_diary_trips', {p_key: key()}) || []; }
    catch (e) { if (notFound(e)) return []; throw e; }
  }

  async function save(trip) {
    if (!key() && !session) await create();
    try { return await rpc('fishing_diary_save', {p_key: key(), p: trip}); }
    catch (e) {
      if (!notFound(e)) throw e;
      await create(); // ключ устарел или у аккаунта ещё нет дневника
      return rpc('fishing_diary_save', {p_key: key(), p: trip});
    }
  }

  const remove = id => rpc('fishing_diary_delete', {p_key: key(), p_id: id});

  async function link() {
    const res = await rpc('fishing_diary_link', {p_key: key()});
    // дальше дневник открывается по аккаунту, а старый ключ устройства в базе уже недействителен
    ls.set(LS_KEY, null);
    return res;
  }

  async function signUp(email, password) {
    const j = await authReq('signup', {email, password});
    if (!j.access_token) throw new Error('Мы отправили письмо для подтверждения. Подтвердите почту и нажмите «Войти».');
    saveSession(fromAuth(j, email));
    return link();
  }

  async function signIn(email, password) {
    saveSession(fromAuth(await authReq('token?grant_type=password', {email, password}), email));
    return link();
  }

  async function signOut() {
    const t = session && session.access_token;
    saveSession(null);
    ls.set(LS_KEY, null); // дневник остаётся в аккаунте, а с этого устройства пропадает
    if (t) { try { await authReq('logout', {}, t); } catch (e) {} }
  }

  function useKey(k) { ls.set(LS_KEY, String(k || '').trim() || null); }
  const shareLink = () => key() ? `${location.origin}${location.pathname}#diary=${key()}` : null;

  global.Diary = {
    list, save, remove, signUp, signIn, signOut, useKey, shareLink,
    get email() { return session && session.email; },
    get hasKey() { return !!key(); },
    get key() { return key(); },
  };
})(window);
