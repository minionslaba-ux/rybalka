// Интерфейс: поиск места, карта, прогноз по дням и часам, отчёты рыбаков.
(function () {
  'use strict';
  const {FISH, moonName, scoreHour, buildHours, detectSeason, clamp} = window.Forecast;
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const color = s => s >= 70 ? 'var(--good)' : s >= 45 ? 'var(--mid)' : 'var(--bad)';
  const label = s => s >= 80 ? 'Отличный' : s >= 65 ? 'Хороший' : s >= 45 ? 'Средний' : s >= 30 ? 'Слабый' : 'Плохой';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const RATING = ['', 'не клевало', 'слабо', 'средне', 'хорошо', 'отлично'];

  const state = {all: [], hours: [], place: null, sel: 0, autoSeason: 'open', catches: [], offset: 0};

  // ---------- настройки, сохранённые в браузере ----------
  const store = {
    get() { try { return JSON.parse(localStorage.getItem('ff') || '{}'); } catch (e) { return {}; } },
    set(v) { try { localStorage.setItem('ff', JSON.stringify({...store.get(), ...v})); } catch (e) {} },
  };

  for (const [k, v] of Object.entries(FISH)) {
    $('fish').add(new Option(v.name, k));
    $('cfFish').add(new Option(v.name, k));
  }

  const season = () => $('season').value === 'auto' ? state.autoSeason : $('season').value;

  // ---------- карта ----------
  let map = null, pointMarker = null, catchLayer = null;
  if (window.L) {
    map = L.map('map', {scrollWheelZoom: false}).setView([55.75, 37.62], 6);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    catchLayer = L.layerGroup().addTo(map);
    map.on('click', e => {
      const lat = +e.latlng.lat.toFixed(4), lon = +e.latlng.lng.toFixed(4);
      run({lat, lon, name: `Точка ${lat}, ${lon}`});
    });
  } else {
    $('map').style.display = 'none';
    document.querySelector('.map-hint').style.display = 'none';
  }

  // ---------- загрузка данных ----------
  async function geocode(q) {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=ru&format=json`);
    const j = await r.json();
    if (!j.results?.length) throw new Error('Место не найдено');
    const g = j.results[0];
    return {lat: g.latitude, lon: g.longitude, name: [g.name, g.admin1, g.country].filter(Boolean).join(', ')};
  }

  async function loadWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,pressure_msl,wind_speed_10m,precipitation,cloud_cover` +
      `&daily=sunrise,sunset&wind_speed_unit=ms&timezone=auto&past_days=7&forecast_days=7&timeformat=unixtime`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Не удалось получить погоду');
    return r.json();
  }

  async function run(placeOrPromise) {
    $('status').textContent = 'Загружаю прогноз…';
    try {
      const pl = await placeOrPromise;
      const w = await loadWeather(pl.lat, pl.lon);
      state.all = buildHours(w);
      state.offset = w.utc_offset_seconds * 1000;
      const todayKey = new Date(Date.now() + state.offset).toISOString().slice(0, 10);
      state.hours = state.all.filter(x => x.local.toISOString().slice(0, 10) >= todayKey);
      state.autoSeason = detectSeason(state.all);
      state.place = pl; state.sel = 0;
      store.set({place: pl});
      $('status').textContent = '';
      if (map) {
        if (pointMarker) pointMarker.remove();
        pointMarker = L.marker([pl.lat, pl.lon]).addTo(map);
        map.setView([pl.lat, pl.lon], Math.max(map.getZoom(), 9));
      }
      render();
      loadCatches();
    } catch (e) {
      $('status').textContent = '⚠️ ' + e.message;
    }
  }

  // ---------- прогноз ----------
  function render() {
    if (!state.hours.length) return;
    const fishKey = $('fish').value, fish = FISH[fishKey], ss = season();
    const scored = state.hours.map(x => ({...x, ...scoreHour(x, fish, ss)}));
    const byDay = new Map();
    for (const h of scored) {
      const key = h.local.toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(h);
    }
    const days = [...byDay.entries()].slice(0, 7).map(([key, hs]) => {
      const top = [...hs].sort((a, b) => b.score - a.score).slice(0, 5);
      const avg = hs.reduce((s, h) => s + h.score, 0) / hs.length;
      return {key, hs, score: Math.round(0.6 * top.reduce((s, h) => s + h.score, 0) / top.length + 0.4 * avg)};
    });
    state.sel = Math.min(state.sel, days.length - 1);

    const auto = $('season').value === 'auto';
    $('place').innerHTML = `${esc(state.place.name)} — ${fish.name}
      <span class="badge ${ss}">${ss === 'ice' ? '❄️ со льда' : '🌊 открытая вода'}${auto ? ' · авто' : ''}</span>`;
    $('days').innerHTML = days.map((d, i) => {
      const dt = new Date(d.key + 'T00:00:00Z');
      return `<button class="day ${i === state.sel ? 'active' : ''}" data-i="${i}">
        <div class="d">${i === 0 ? 'Сегодня' : WD[dt.getUTCDay()] + ', ' + dt.getUTCDate() + '.' + pad(dt.getUTCMonth() + 1)}</div>
        <div class="score" style="color:${color(d.score)}">${d.score}</div>
        <div class="lbl">${label(d.score)}</div></button>`;
    }).join('');
    document.querySelectorAll('.day').forEach(el => el.onclick = () => { state.sel = +el.dataset.i; render(); });
    renderDetail(days[state.sel], fish, ss);
  }

  function bestWindow(hs) {
    let bi = 0, bs = -1;
    for (let i = 0; i + 2 < hs.length; i++) {
      const s = hs[i].score + hs[i + 1].score + hs[i + 2].score;
      if (s > bs) { bs = s; bi = i; }
    }
    const a = hs[bi].local.getUTCHours(), b = (hs[Math.min(bi + 2, hs.length - 1)].local.getUTCHours() + 1) % 24;
    return `${pad(a)}:00–${pad(b)}:00`;
  }

  function renderDetail(d, fish, ss) {
    const hs = d.hs, mid = hs[Math.floor(hs.length / 2)];
    const avg = k => hs.reduce((s, h) => s + h[k], 0) / hs.length;
    const fa = k => hs.reduce((s, h) => s + h.f[k], 0) / hs.length;
    const dp = hs[hs.length - 1].p - hs[0].p;
    const tm = ms => { const x = new Date(ms + state.offset); return pad(x.getUTCHours()) + ':' + pad(x.getUTCMinutes()); };
    const factor = (n, v, k) => `<div class="f"><div class="n">${n}</div><div class="v">${v}</div>
      <div class="bar"><i style="width:${Math.round(fa(k) * 100)}%;background:${color(fa(k) * 100)}"></i></div></div>`;

    const tips = [];
    if (Math.abs(dp) > 6) tips.push(`Резкое изменение давления (${dp > 0 ? '+' : ''}${dp.toFixed(0)} гПа за день) — рыба может быть пассивной, ловите на глубине.`);
    else tips.push('Давление стабильное — хороший знак.');
    if (ss === 'ice') {
      tips.push('Проверяйте лёд: для одного человека нужно не меньше 7–10 см прозрачного льда, ходите с пешнёй и спасалками.');
      if (fish.winter < 0.5) tips.push(`${fish.name} зимой малоактивен — ищите зимовальные ямы, ловите очень деликатно, мелкой мормышкой с мотылём.`);
      if (fish.winterTime === 'day') tips.push('Основной клёв со льда — в светлое время, ближе к середине дня.');
      if (fish.winterTime === 'night') tips.push(`${fish.name} лучше всего берёт ночью и в сильные морозы на донки и жерлицы.`);
      if (fish === FISH.pike) tips.push('Щуку со льда удобнее ловить на жерлицы, поставленные с утра у бровок и коряжника.');
      if (avg('dt24') > 3) tips.push('Идёт потепление — в оттепель зимний клёв часто оживает.');
      if (avg('air') < -15) tips.push('Сильный мороз: рыба вялая, используйте палатку и мелкие приманки.');
    } else {
      if (avg('water') < fish.tOpt[0]) tips.push(`Вода холоднее комфортной для вида (${fish.tOpt[0]}–${fish.tOpt[1]}°C): медленная проводка, мелкие приманки, ищите ямы.`);
      else if (avg('water') > fish.tOpt[1]) tips.push('Жарко: рыба уходит на глубину, лучшее время — рассвет и ночь.');
      if (avg('wind') > 8) tips.push('Сильный ветер — ищите подветренный берег.');
      else if (avg('wind') >= 2) tips.push('Лёгкая рябь на воде помогает: рыба осторожничает меньше.');
      if (fish.night >= 0.8) tips.push(`${fish.name} хорошо берёт в сумерках и ночью.`);
    }

    const tempText = ss === 'ice'
      ? `воздух ${avg('air').toFixed(0)}°C, ${avg('dt24') >= 0 ? '+' : ''}${avg('dt24').toFixed(1)}° за сутки`
      : `${avg('water').toFixed(1)}°C · воздух ${avg('air').toFixed(0)}°C`;

    $('detail').innerHTML = `
      <div class="panel"><h2>Лучшее время: ${bestWindow(hs)}</h2>
        <div class="hours">${hs.map(h => `<div class="h" title="${pad(h.local.getUTCHours())}:00 — ${h.score}">
          <b style="height:${Math.max(h.score, 2)}%;background:${color(h.score)}"></b><span>${h.local.getUTCHours() % 3 === 0 ? h.local.getUTCHours() : ''}</span></div>`).join('')}</div>
      </div>
      <div class="panel"><h2>Факторы</h2><div class="factors">
        ${factor('Давление', `${avg('p').toFixed(0)} гПа (${(avg('p') * 0.750062).toFixed(0)} мм), ${dp >= 0 ? '+' : ''}${dp.toFixed(1)} за день`, 'pressure')}
        ${factor(ss === 'ice' ? 'Мороз и оттепель' : 'Температура воды (оценка)', tempText, 'temp')}
        ${factor('Ветер', `${avg('wind').toFixed(1)} м/с`, 'wind')}
        ${factor('Осадки', `${hs.reduce((s, h) => s + h.precip, 0).toFixed(1)} мм за день`, 'precip')}
        ${factor('Облачность', `${avg('clouds').toFixed(0)}%`, 'clouds')}
        ${factor('Луна', moonName(mid.moon), 'moon')}
        ${factor('Солнце', `восход ${tm(mid.sunrise)} · закат ${tm(mid.sunset)}`, 'time')}
      </div></div>
      <div class="panel"><h2>Советы</h2><ul class="tips">${tips.map(t => `<li>${t}</li>`).join('')}</ul></div>`;
  }

  // ---------- отчёты рыбаков ----------
  function pearson(xs, ys) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  }

  async function loadCatches() {
    if (!state.place) return;
    try {
      state.catches = await window.Catches.near(state.place.lat, state.place.lon);
    } catch (e) {
      state.catches = [];
      $('stats').innerHTML = `<div class="foot">⚠️ ${esc(e.message)}</div>`;
      return;
    }
    renderCatches();
  }

  function renderCatches() {
    const all = state.catches, fishKey = $('fish').value;
    const same = all.filter(c => c.fish === fishKey);
    const avgR = same.length ? (same.reduce((s, c) => s + c.rating, 0) / same.length).toFixed(1) : '—';
    const pairs = all.filter(c => c.forecast_score != null);
    let acc = 'мало данных';
    if (pairs.length >= 5) {
      const r = pearson(pairs.map(c => c.forecast_score), pairs.map(c => c.rating));
      acc = r > 0.5 ? `хорошая (r=${r.toFixed(2)})` : r > 0.2 ? `средняя (r=${r.toFixed(2)})` : `слабая (r=${r.toFixed(2)})`;
    }
    $('stats').innerHTML = `
      <div class="stat"><div class="n">Отчётов за 30 дней</div><div class="v">${all.length}</div></div>
      <div class="stat"><div class="n">Средний клёв: ${FISH[fishKey].name.toLowerCase()}</div><div class="v">${avgR}${same.length ? ' / 5' : ''}</div></div>
      <div class="stat"><div class="n">Совпадение прогноза с отчётами</div><div class="v" style="font-size:16px;padding-top:6px">${acc}</div></div>
      ${window.Catches.remote ? '' : '<div class="foot">База не подключена — отчёты видны только в этом браузере.</div>'}`;
    $('reports').innerHTML = all.length ? all.slice(0, 10).map(c => {
      const d = new Date(c.caught_at);
      const extra = [c.fish_count != null ? `${c.fish_count} шт.` : '', c.weight_kg != null ? `${(+c.weight_kg).toFixed(2)} кг` : ''].filter(Boolean).join(', ');
      return `<li><b>${esc(FISH[c.fish]?.name || c.fish)}</b> — ${c.rating}/5, ${RATING[c.rating] || ''}${extra ? ' · ' + esc(extra) : ''}
        ${c.season === 'ice' ? ' ❄️' : ''}
        <div class="meta">${d.toLocaleDateString('ru-RU')} ${pad(d.getHours())}:${pad(d.getMinutes())}${c.place ? ' · ' + esc(c.place) : ''}${c.forecast_score != null ? ' · прогноз был ' + c.forecast_score : ''}</div>
        ${c.comment ? `<div>${esc(c.comment)}</div>` : ''}</li>`;
    }).join('') : '<li class="foot">Пока нет отчётов рядом. Будьте первым!</li>';

    if (catchLayer) {
      catchLayer.clearLayers();
      for (const c of all) {
        const s = (c.rating - 1) * 25;
        L.circleMarker([c.lat, c.lon], {radius: 7, color: '#fff', weight: 1, fillOpacity: 0.85,
          fillColor: s >= 70 ? '#16a34a' : s >= 45 ? '#ca8a04' : '#dc2626'})
          .bindPopup(`<b>${esc(FISH[c.fish]?.name || c.fish)}</b>: ${c.rating}/5<br>${new Date(c.caught_at).toLocaleDateString('ru-RU')}${c.comment ? '<br>' + esc(c.comment) : ''}`)
          .addTo(catchLayer);
      }
    }
  }

  function localInputValue(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  $('reportForm').addEventListener('toggle', () => {
    if ($('reportForm').open) {
      $('cfFish').value = $('fish').value;
      if (!$('cfTime').value) $('cfTime').value = localInputValue(new Date());
    }
  });

  $('catchForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!state.place) { $('cfMsg').textContent = 'Сначала выберите место.'; return; }
    const fd = new FormData(e.target);
    const when = new Date(fd.get('caught_at'));
    if (isNaN(when) || when > new Date(Date.now() + 3600000)) { $('cfMsg').textContent = 'Проверьте дату и время.'; return; }
    if (when < new Date(Date.now() - 7 * 86400000)) { $('cfMsg').textContent = 'Можно отметить улов только за последние 7 дней.'; return; }

    // запоминаем, что показывал прогноз в этот час: потом по этим данным можно подобрать веса модели
    const fishKey = fd.get('fish'), ss = season();
    let forecast_score = null, factors = null;
    const hour = state.all.reduce((best, h) => !best || Math.abs(h.time - when) < Math.abs(best.time - when) ? h : best, null);
    if (hour && Math.abs(hour.time - when) <= 2 * 3600000) {
      const r = scoreHour(hour, FISH[fishKey], ss);
      forecast_score = r.score;
      factors = Object.fromEntries(Object.entries(r.f).map(([k, v]) => [k, +v.toFixed(3)]));
      Object.assign(factors, {p: +hour.p.toFixed(1), dp3: +hour.dp3.toFixed(1), dp24: +hour.dp24.toFixed(1),
        air: +hour.air.toFixed(1), water: +hour.water.toFixed(1), wind: +hour.wind.toFixed(1), clouds: hour.clouds, precip: hour.precip});
    }
    const num = k => fd.get(k) === '' ? null : Number(fd.get(k));
    const btn = e.target.querySelector('button');
    btn.disabled = true; $('cfMsg').textContent = 'Отправляю…';
    try {
      await window.Catches.add({
        caught_at: when.toISOString(), lat: +state.place.lat.toFixed(4), lon: +state.place.lon.toFixed(4),
        place: state.place.name.slice(0, 120), fish: fishKey, season: ss, rating: Number(fd.get('rating')),
        fish_count: num('fish_count'), weight_kg: num('weight_kg'),
        comment: (fd.get('comment') || '').trim().slice(0, 500) || null, forecast_score, factors,
      });
      $('cfMsg').textContent = '✅ Спасибо! Отчёт сохранён.';
      e.target.reset(); $('cfTime').value = localInputValue(new Date()); $('cfFish').value = fishKey;
      loadCatches();
    } catch (err) {
      $('cfMsg').textContent = '⚠️ ' + err.message;
    } finally { btn.disabled = false; }
  });

  // ---------- события ----------
  $('go').onclick = () => { const q = $('city').value.trim(); if (q) { store.set({city: q}); run(geocode(q)); } };
  $('city').onkeydown = e => { if (e.key === 'Enter') $('go').click(); };
  $('geo').onclick = () => run(new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Браузер не поддерживает геолокацию'));
    navigator.geolocation.getCurrentPosition(
      p => res({lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4), name: 'Моё местоположение'}),
      () => rej(new Error('Нет доступа к геолокации')));
  }));
  $('fish').onchange = () => { store.set({fish: $('fish').value}); render(); renderCatches(); };
  $('season').onchange = () => { store.set({season: $('season').value}); render(); };

  // ---------- старт ----------
  const saved = store.get();
  if (saved.fish && FISH[saved.fish]) $('fish').value = saved.fish;
  if (saved.season) $('season').value = saved.season;
  $('city').value = saved.city || 'Москва';
  if (saved.place && typeof saved.place.lat === 'number') run(Promise.resolve(saved.place));
  else run(geocode($('city').value));
})();
