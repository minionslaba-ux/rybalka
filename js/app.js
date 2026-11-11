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
  const METHOD = {spinning: 'спиннинг', jig: 'джиг', float: 'поплавок', feeder: 'фидер', bottom: 'донка',
    fly: 'мормышка', tipup: 'жерлицы', trolling: 'троллинг', other: 'другое'};
  const PAST_DAYS = 30, FUTURE_DAYS = 16;  // Open-Meteo отдаёт до 16 дней вперёд
  const RELIABLE_DAYS = 7;                 // дальше прогноз погоды сильно теряет точность

  const state = {all: [], days: [], place: null, selKey: null, todayKey: null, autoSeason: 'open', catches: [], offset: 0};
  const dayKey = h => h.local.toISOString().slice(0, 10);
  const addDays = (key, n) => new Date(Date.parse(key + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

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
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>'); // без флага
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    catchLayer = L.layerGroup().addTo(map);
    map.on('click', e => {
      const lat = +e.latlng.lat.toFixed(4), lon = +e.latlng.lng.toFixed(4);
      movePin(lat, lon); // метку переносим сразу, не дожидаясь погоды
      run(reverseName(lat, lon).then(n => ({lat, lon, name: n ? `${n} · ${lat}, ${lon}` : `Точка ${lat}, ${lon}`})),
        'Загружаю прогноз для выбранной точки…');
    });
  }
  function movePin(lat, lon) {
    if (!map) return;
    if (pointMarker) pointMarker.setLatLng([lat, lon]);
    else pointMarker = L.marker([lat, lon]).addTo(map);
  }
  if (!map) {
    $('map').style.display = 'none';
    document.querySelector('.map-hint').style.display = 'none';
  }

  // ---------- загрузка данных ----------
  // Поиск места: сначала OpenStreetMap (находит и города, и водоёмы), затем Open-Meteo как запасной вариант
  async function geocodeOSM(q) {
    const r = await fetchT(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ru&q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error('osm ' + r.status);
    const j = await r.json();
    if (!j.length) return null;
    const g = j[0], parts = (g.display_name || '').split(', ');
    const name = parts.length > 3 ? [parts[0], parts[parts.length - 3], parts[parts.length - 1]].join(', ') : g.display_name;
    return {lat: +(+g.lat).toFixed(4), lon: +(+g.lon).toFixed(4), name: name || q};
  }
  async function geocodeOpenMeteo(q) {
    const r = await fetchT(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=ru&format=json`);
    if (!r.ok) throw new Error('om ' + r.status);
    const j = await r.json();
    if (!j.results?.length) return null;
    const g = j.results[0];
    return {lat: g.latitude, lon: g.longitude, name: [g.name, g.admin1, g.country].filter(Boolean).join(', ')};
  }
  async function geocode(q) {
    for (const fn of [geocodeOSM, geocodeOpenMeteo]) {
      try { const res = await fn(q); if (res) return res; } catch (e) { /* пробуем следующий сервис */ }
    }
    throw new Error(`Не нашёл «${q}». Попробуйте написать иначе или нажмите нужное место на карте.`);
  }

  // Точная геопозиция (GPS / Wi-Fi). Свой таймер нужен потому, что iOS может «зависнуть»,
  // если окно с разрешением закрыли или не показали, и тогда штатный timeout не срабатывает.
  function gps() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej({code: 'unsupported'});
      if (!window.isSecureContext) return rej({code: 'insecure'});
      const timer = setTimeout(() => rej({code: 'hang'}), 20000);
      navigator.geolocation.getCurrentPosition(
        p => { clearTimeout(timer); res({lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4)}); },
        err => { clearTimeout(timer); rej({code: err.code}); },
        {enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60000});
    });
  }

  // Примерное место по IP-адресу (точность — город). Запасной вариант, если GPS недоступен.
  async function ipLocate() {
    const sources = [
      async () => { const j = await (await fetchT('https://get.geojs.io/v1/ip/geo.json', {}, 8000)).json();
        return {lat: +j.latitude, lon: +j.longitude, city: j.city || j.region}; },
      async () => { const j = await (await fetchT('https://ipapi.co/json/', {}, 8000)).json();
        return {lat: +j.latitude, lon: +j.longitude, city: j.city || j.region}; },
    ];
    for (const s of sources) {
      try { const r = await s(); if (isFinite(r.lat) && isFinite(r.lon) && (r.lat || r.lon)) return r; } catch (e) {}
    }
    return null;
  }

  async function reverseName(lat, lon) {
    try {
      const r = await fetchT(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&accept-language=ru&lat=${lat}&lon=${lon}`, {}, 6000);
      const j = await r.json(), a = j.address || {};
      return a.city || a.town || a.village || a.municipality || a.county || a.state || null;
    } catch (e) { return null; }
  }

  function gpsHint(code) {
    const ua = navigator.userAgent;
    const inApp = /Telegram|VK|Instagram|FBAN|FBAV|YaBrowser\/.*Mobile.*SA|Line\//i.test(ua);
    const ios = /iPhone|iPad|iPod/.test(ua);
    if (inApp) return 'Встроенный браузер приложения не даёт доступ к геопозиции — откройте сайт в Safari или Chrome.';
    if (code === 1) return ios
      ? 'Чтобы определять точно, разрешите геопозицию: Настройки → Конфиденциальность и безопасность → Службы геолокации (включить) → «Сайты Safari» (или Chrome) → «При использовании». Если раньше нажали «Запретить»: Настройки → Safari → Местонахождение → «Спросить».'
      : 'Чтобы определять точно, разрешите геопозицию в настройках сайта (значок слева от адреса).';
    if (code === 'hang') return 'Телефон не ответил на запрос геопозиции. Проверьте, что службы геолокации включены.';
    return 'Точная геопозиция недоступна.';
  }

  async function locate() {
    let code = null;
    try {
      const p = await gps();
      const city = await reverseName(p.lat, p.lon);
      return {...p, name: city ? `Рядом со мной · ${city}` : 'Моё местоположение'};
    } catch (e) { code = e.code; }
    $('status').textContent = 'Точная геопозиция недоступна, определяю примерно…';
    const ip = await ipLocate();
    if (ip) {
      const lat = +ip.lat.toFixed(4), lon = +ip.lon.toFixed(4), city = (await reverseName(lat, lon)) || ip.city;
      return {lat, lon, name: `≈ ${city || 'Моё местоположение'} (по сети)`,
        hint: `ℹ️ Место определено примерно, по интернет-подключению. Уточните, нажав на карту. ${gpsHint(code)}`};
    }
    throw new Error(`Не удалось определить местоположение. ${gpsHint(code)} Или просто нажмите своё место на карте.`);
  }

  async function loadWeather(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,pressure_msl,wind_speed_10m,precipitation,cloud_cover` +
      `&daily=sunrise,sunset&wind_speed_unit=ms&timezone=auto&past_days=${PAST_DAYS}&forecast_days=${FUTURE_DAYS}&timeformat=unixtime`;
    const r = await fetchT(url);
    if (!r.ok) throw new Error('Не удалось получить погоду');
    return r.json();
  }

  let runId = 0;
  async function run(placeOrPromise, loadingText = 'Загружаю прогноз…') {
    const my = ++runId; // если пользователь успел запросить другое место, старый ответ игнорируем
    $('status').textContent = loadingText;
    $('status').classList.remove('err');
    try {
      const pl = await placeOrPromise;
      if (my !== runId) return;
      $('status').textContent = 'Загружаю прогноз…';
      const w = await loadWeather(pl.lat, pl.lon);
      if (my !== runId) return;
      state.all = buildHours(w);
      state.offset = w.utc_offset_seconds * 1000;
      state.todayKey = new Date(Date.now() + state.offset).toISOString().slice(0, 10);
      // только полные сутки (24 часа), чтобы не показывать обрезанные дни
      const count = new Map();
      for (const h of state.all) count.set(dayKey(h), (count.get(dayKey(h)) || 0) + 1);
      state.days = [...count.entries()].filter(([, n]) => n >= 23).map(([k]) => k);
      state.autoSeason = detectSeason(state.all);
      state.place = pl;
      const first = state.days[0], last = state.days[state.days.length - 1];
      $('date').min = first; $('date').max = last;
      if (!state.selKey || state.selKey < first || state.selKey > last) state.selKey = state.todayKey;
      $('date').value = state.selKey;
      $('cfPlace').textContent = pl.name;
      const {hint, ...savedPlace} = pl;
      store.set({place: savedPlace});
      $('status').textContent = hint || '';
      if (map) {
        movePin(pl.lat, pl.lon);
        map.invalidateSize();
        map.setView([pl.lat, pl.lon], Math.max(map.getZoom(), 9));
      }
      render();
      loadCatches();
    } catch (e) {
      if (my !== runId) return;
      $('status').textContent = '⚠️ ' + e.message;
      $('status').classList.add('err');
    }
  }

  // ---------- прогноз ----------
  function render() {
    if (!state.days.length) return;
    const fishKey = $('fish').value, fish = FISH[fishKey], ss = season();
    // показываем полосу из 7 дней вокруг выбранной даты
    const idx = Math.max(0, state.days.indexOf(state.selKey));
    const start = Math.max(0, Math.min(idx - 3, state.days.length - 7));
    const keys = state.days.slice(start, start + 7);
    const days = keys.map(key => {
      const hs = state.all.filter(h => dayKey(h) === key).map(x => ({...x, ...scoreHour(x, fish, ss)}));
      const top = [...hs].sort((a, b) => b.score - a.score).slice(0, 5);
      const avg = hs.reduce((s, h) => s + h.score, 0) / hs.length;
      return {key, hs, score: Math.round(0.6 * top.reduce((s, h) => s + h.score, 0) / top.length + 0.4 * avg)};
    });

    const auto = $('season').value === 'auto';
    $('place').innerHTML = `${esc(state.place.name)} — ${fish.name}
      <span class="badge ${ss}">${ss === 'ice' ? '❄️ со льда' : '🌊 открытая вода'}${auto ? ' · авто' : ''}</span>`;
    $('days').innerHTML = days.map(d => {
      const dt = new Date(d.key + 'T00:00:00Z'), diff = daysBetween(state.todayKey, d.key);
      const name = diff === 0 ? 'Сегодня' : diff === 1 ? 'Завтра' : diff === -1 ? 'Вчера'
        : WD[dt.getUTCDay()] + ', ' + dt.getUTCDate() + '.' + pad(dt.getUTCMonth() + 1);
      const tag = diff < 0 ? 'факт. погода' : diff >= RELIABLE_DAYS ? 'дальний' : '';
      return `<button class="day ${d.key === state.selKey ? 'active' : ''} ${diff < 0 ? 'past' : ''}" data-k="${d.key}">
        <div class="d">${name}</div>
        <div class="score" style="color:${color(d.score)}">${d.score}</div>
        <div class="lbl">${label(d.score)}</div>${tag ? `<div class="tag">${tag}</div>` : ''}</button>`;
    }).join('');
    document.querySelectorAll('.day').forEach(el => el.onclick = () => selectDate(el.dataset.k));
    renderDetail(days.find(d => d.key === state.selKey) || days[0], fish, ss);
  }

  function selectDate(key) {
    if (!state.days.length) return;
    const first = state.days[0], last = state.days[state.days.length - 1];
    state.selKey = key < first ? first : key > last ? last : key;
    $('date').value = state.selKey;
    render();
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

    const diff = daysBetween(state.todayKey, d.key);
    const dateText = new Date(d.key + 'T00:00:00Z').toLocaleDateString('ru-RU', {day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC'});
    const note = diff < 0
      ? `<div class="note">📅 ${dateText}: прошедший день — показана фактическая погода. Удобно сравнить с вашим уловом.</div>`
      : diff >= RELIABLE_DAYS
        ? `<div class="note warn">⚠️ ${dateText}: прогноз на ${diff} дн. вперёд — погода может сильно измениться, проверьте ближе к дате.</div>`
        : `<div class="note">📅 ${dateText}</div>`;

    $('detail').innerHTML = note + `
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
      const extra = [c.fish_count != null ? `${c.fish_count} шт.` : '', c.weight_kg != null ? `${(+c.weight_kg).toFixed(2)} кг` : '',
        METHOD[c.method] || '', c.bait ? `на ${c.bait}` : '', c.depth_m != null ? `глубина ${(+c.depth_m)} м` : ''].filter(Boolean).join(', ');
      return `<li><b>${esc(FISH[c.fish]?.name || c.fish)}</b> — ${c.rating}/5, ${RATING[c.rating] || ''}${extra ? ' · ' + esc(extra) : ''}
        ${c.season === 'ice' ? ' ❄️' : ''}
        <div class="meta">${d.toLocaleDateString('ru-RU')} ${pad(d.getHours())}:${pad(d.getMinutes())}${c.nickname ? ' · ' + esc(c.nickname) : ''}${c.place ? ' · ' + esc(c.place) : ''}${c.forecast_score != null ? ' · прогноз был ' + c.forecast_score : ''}</div>
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

  function resetForm(fishKey) {
    $('catchForm').reset();
    $('cfFish').value = fishKey || $('fish').value;
    const now = new Date();
    $('cfTime').value = localInputValue(now);
    $('cfTime').max = localInputValue(new Date(now.getTime() + 3600000));
    $('cfTime').min = localInputValue(new Date(now.getTime() - 29 * 86400000));
    try { const n = localStorage.getItem('ff_nick'); if (n) $('catchForm').nickname.value = n; } catch (e) {}
  }
  resetForm();

  $('catchForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!state.place) { $('cfMsg').textContent = 'Сначала выберите место.'; return; }
    const fd = new FormData(e.target);
    const when = new Date(fd.get('caught_at'));
    if (isNaN(when) || when > new Date(Date.now() + 3600000)) { $('cfMsg').textContent = 'Проверьте дату и время — улов не может быть в будущем.'; return; }
    if (when < new Date(Date.now() - 29 * 86400000)) { $('cfMsg').textContent = 'Можно отметить улов только за последние 30 дней.'; return; }
    if (!fd.get('rating')) { $('cfMsg').textContent = 'Отметьте, как клевало.'; return; }

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
    const num = k => fd.get(k) == null || fd.get(k) === '' ? null : Number(fd.get(k));
    const txt = (k, n) => String(fd.get(k) || '').trim().slice(0, n) || null;
    const btn = e.target.querySelector('button');
    btn.disabled = true; $('cfMsg').textContent = 'Отправляю…';
    try {
      await window.Catches.add({
        caught_at: when.toISOString(), lat: +state.place.lat.toFixed(4), lon: +state.place.lon.toFixed(4),
        place: state.place.name.slice(0, 120), fish: fishKey, season: ss, rating: Number(fd.get('rating')),
        fish_count: num('fish_count'), weight_kg: num('weight_kg'), depth_m: num('depth_m'),
        method: fd.get('method') || null, bait: txt('bait', 80), nickname: txt('nickname', 40),
        comment: txt('comment', 500), forecast_score, factors,
      });
      try { if (fd.get('nickname')) localStorage.setItem('ff_nick', String(fd.get('nickname')).trim()); } catch (e) {}
      $('cfMsg').textContent = '✅ Спасибо! Отчёт сохранён.';
      resetForm(fishKey);
      loadCatches();
    } catch (err) {
      $('cfMsg').textContent = '⚠️ ' + err.message;
    } finally { btn.disabled = false; }
  });

  // ---------- события ----------
  $('go').onclick = () => { const q = $('city').value.trim(); if (q) { store.set({city: q}); run(geocode(q)); } };
  $('city').onkeydown = e => { if (e.key === 'Enter') $('go').click(); };
  $('geo').onclick = () => run(locate(), 'Определяю местоположение…');
  $('fish').onchange = () => { store.set({fish: $('fish').value}); render(); renderCatches(); };
  $('season').onchange = () => { store.set({season: $('season').value}); render(); };
  $('date').onchange = () => { if ($('date').value) selectDate($('date').value); };
  $('prevDay').onclick = () => state.selKey && selectDate(addDays(state.selKey, -1));
  $('nextDay').onclick = () => state.selKey && selectDate(addDays(state.selKey, 1));
  $('today').onclick = () => state.todayKey && selectDate(state.todayKey);

  // ---------- старт ----------
  const saved = store.get();
  if (saved.fish && FISH[saved.fish]) $('fish').value = saved.fish;
  if (saved.season) $('season').value = saved.season;
  $('city').value = saved.city || 'Москва';
  if (saved.place && typeof saved.place.lat === 'number') run(Promise.resolve(saved.place));
  else run(geocode($('city').value));
})();
