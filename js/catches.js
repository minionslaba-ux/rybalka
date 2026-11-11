// Хранилище отчётов об улове: Supabase (REST) или localStorage, если база не настроена.
(function (global) {
  'use strict';
  const cfg = global.APP_CONFIG || {};
  const remote = !!(cfg.supabaseUrl && cfg.supabaseKey);
  const LS_KEY = 'ff_catches';

  // crypto.randomUUID есть только на https/localhost — для остальных случаев собираем UUID v4 вручную
  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function clientId() {
    try {
      let id = localStorage.getItem('ff_client');
      if (!id) { id = uuid(); localStorage.setItem('ff_client', id); }
      return id;
    } catch (e) { return uuid(); }
  }

  const headers = () => ({
    apikey: cfg.supabaseKey,
    'Content-Type': 'application/json',
  });

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch (e) { return []; }
  }

  async function add(c) {
    const row = {...c, client_id: clientId()};
    if (!remote) {
      const all = readLocal();
      all.push({...row, id: Date.now(), created_at: new Date().toISOString()});
      try { localStorage.setItem(LS_KEY, JSON.stringify(all.slice(-500))); } catch (e) {}
      return;
    }
    const r = await fetch(`${cfg.supabaseUrl}/rest/v1/fishing_catches`, {
      method: 'POST', headers: {...headers(), Prefer: 'return=minimal'}, body: JSON.stringify(row),
    });
    if (!r.ok) {
      let msg = 'Не удалось сохранить отчёт';
      try { const j = await r.json(); if (j.message) msg = j.message; } catch (e) {}
      throw new Error(msg);
    }
  }

  // Отчёты в квадрате ±deg градусов вокруг точки за последние days дней
  async function near(lat, lon, deg = 1, days = 30) {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    if (!remote) {
      return readLocal().filter(c => Math.abs(c.lat - lat) <= deg && Math.abs(c.lon - lon) <= deg && c.caught_at >= since)
        .sort((a, b) => b.caught_at.localeCompare(a.caught_at));
    }
    const q = new URLSearchParams();
    q.set('select', 'id,caught_at,lat,lon,place,fish,season,rating,fish_count,weight_kg,comment,forecast_score,method,bait,depth_m,nickname');
    q.append('lat', `gte.${lat - deg}`); q.append('lat', `lte.${lat + deg}`);
    q.append('lon', `gte.${lon - deg}`); q.append('lon', `lte.${lon + deg}`);
    q.set('caught_at', `gte.${since}`);
    q.set('order', 'caught_at.desc'); q.set('limit', '200');
    const r = await fetch(`${cfg.supabaseUrl}/rest/v1/fishing_catches?${q}`, {headers: headers()});
    if (!r.ok) throw new Error('Не удалось загрузить отчёты');
    return r.json();
  }

  global.Catches = {add, near, remote};
})(window);
