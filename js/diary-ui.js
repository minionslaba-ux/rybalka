// Интерфейс дневника: вкладки, вход, форма записи, список и отчёты.
(function () {
  'use strict';
  const {FISH} = window.Forecast;
  const D = window.Diary, App = window.App;
  const $ = id => document.getElementById(id);
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const RATING = ['', 'не клевало', 'слабо', 'средне', 'хорошо', 'отлично'];
  const FACE = ['', '😞', '😕', '😐', '🙂', '🤩'];
  const METHOD = {spinning: 'спиннинг', jig: 'джиг', float: 'поплавок', feeder: 'фидер', bottom: 'донка',
    fly: 'мормышка', tipup: 'жерлицы', trolling: 'троллинг', other: 'другое'};
  const fishName = k => (FISH[k] && FISH[k].name) || 'разная рыба';
  const num = v => v == null || v === '' ? null : Number(v);
  const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('ru-RU');
  const localInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  let trips = [], loaded = false, editing = null, tripPlace = null;

  // ---------- вкладки ----------
  function showTab(tab) {
    const diary = tab === 'diary';
    $('forecastView').hidden = diary;
    $('diaryView').hidden = !diary;
    document.querySelectorAll('.tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    if (diary) { if (!loaded) refresh(); renderAccount(); }
    else App.mapResize();
  }
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.onclick = () => {
    history.replaceState(null, '', b.dataset.tab === 'diary' ? '#diary' : location.pathname + location.search);
    showTab(b.dataset.tab);
    scrollTo(0, 0);
  });
  $('toDiary').onclick = e => { e.preventDefault(); history.replaceState(null, '', '#diary'); showTab('diary'); $('tripPanel').scrollIntoView(); };

  // ---------- аккаунт ----------
  function renderAccount() {
    const el = $('account');
    if (D.email) {
      el.innerHTML = `<h2>👤 ${esc(D.email)}</h2>
        <p class="foot" style="margin-top:0">Дневник сохранён в аккаунте и доступен с любого устройства — просто войдите с этой почтой.</p>
        <button type="button" id="acOut">Выйти</button>`;
      $('acOut').onclick = async () => {
        if (!confirm('Выйти? Дневник останется в аккаунте, а с этого устройства пропадёт до следующего входа.')) return;
        await D.signOut(); trips = []; renderAll(); renderAccount();
      };
      return;
    }
    const link = D.shareLink();
    el.innerHTML = `<h2>👤 Дневник на этом устройстве</h2>
      <p class="foot" style="margin-top:0">Записи сохраняются сразу, без регистрации. Чтобы не потерять дневник при смене телефона
        и открывать его с разных устройств — войдите по почте: записи этого устройства перейдут в аккаунт.</p>
      <form class="form" id="acForm" novalidate>
        <label>Почта<input type="email" name="email" autocomplete="email" required></label>
        <label>Пароль (от 6 символов)<input type="password" name="password" autocomplete="current-password" minlength="6" required></label>
        <div class="wide buttons">
          <button class="primary" type="submit" value="in">Войти</button>
          <button type="submit" value="up">Зарегистрироваться</button>
        </div>
      </form>
      <div class="msg" id="acMsg" role="status"></div>
      <details class="more"><summary>Без регистрации: перенести дневник на другое устройство</summary>
        ${link ? `<p class="foot">Откройте эту ссылку на другом устройстве. <b>Не публикуйте её</b> — по ней любой сможет открыть ваш дневник.</p>
          <div class="keyrow"><input readonly id="acLink" value="${esc(link)}"><button type="button" id="acCopy">Копировать</button></div>`
        : '<p class="foot">Ссылка появится после первой записи.</p>'}
        <p class="foot">Или вставьте ссылку (или ключ) от дневника с другого устройства:</p>
        <div class="keyrow"><input id="acKey" placeholder="ссылка или ключ дневника"><button type="button" id="acOpen">Открыть</button></div>
      </details>`;

    $('acForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, mode = (e.submitter && e.submitter.value) || 'in';
      const email = f.email.value.trim(), pw = f.password.value;
      if (!/^\S+@\S+\.\S+$/.test(email)) { $('acMsg').textContent = '⚠️ Проверьте адрес почты'; return; }
      if (pw.length < 6) { $('acMsg').textContent = '⚠️ Пароль — минимум 6 символов'; return; }
      $('acMsg').textContent = mode === 'up' ? 'Регистрирую…' : 'Вхожу…';
      try {
        const res = await (mode === 'up' ? D.signUp(email, pw) : D.signIn(email, pw));
        $('acMsg').textContent = '';
        await refresh();
        renderAccount();
        flash(res === 'merged' ? '✅ Вы вошли. Записи с этого устройства добавлены в дневник аккаунта.'
          : res === 'linked' ? '✅ Готово: дневник этого устройства привязан к аккаунту.' : '✅ Вы вошли.');
      } catch (err) { $('acMsg').textContent = '⚠️ ' + err.message; }
    };
    if ($('acCopy')) $('acCopy').onclick = async () => {
      try { await navigator.clipboard.writeText($('acLink').value); $('acCopy').textContent = 'Скопировано'; }
      catch (e) { $('acLink').select(); }
    };
    $('acOpen').onclick = async () => {
      const v = $('acKey').value.trim(), k = (v.match(/#diary=([\w-]+)/) || [])[1] || v;
      if (!/^[\w-]{20,}$/.test(k)) { flash('⚠️ Это не похоже на ключ дневника'); return; }
      if (D.hasKey && D.key !== k && trips.length &&
        !confirm('На этом устройстве уже есть дневник. Открыть другой? Сохраните ссылку на текущий, иначе доступ к нему пропадёт.')) return;
      D.useKey(k); await refresh(); renderAccount();
      flash(trips.length ? `✅ Открыт дневник: ${trips.length} записей` : '⚠️ Дневник пустой или ключ неверный');
    };
  }

  function flash(t) { $('tpMsg').textContent = ''; $('status').textContent = t; $('status').classList.toggle('err', t.startsWith('⚠️')); }

  // ---------- форма ----------
  for (const [k, v] of Object.entries(FISH)) $('tpFish').add(new Option(v.name, k));

  function setPlace(p) {
    tripPlace = p && typeof p.lat === 'number' ? p : null;
    $('tpPlace').textContent = tripPlace ? tripPlace.name : 'не указано';
  }
  document.addEventListener('placechange', e => { if (!editing) setPlace(e.detail); });
  $('tpUsePoint').onclick = () => { const p = App.getPlace(); if (p) setPlace(p); else flash('⚠️ Сначала выберите место на вкладке «Прогноз»'); };
  $('tpNoPlace').onclick = () => setPlace(null);

  function resetForm() {
    const f = $('tripForm');
    f.reset(); f.id.value = ''; editing = null;
    $('tpFish').value = App.currentFish() || '';
    const now = new Date();
    $('tpTime').value = localInput(now);
    $('tpTime').max = localInput(new Date(now.getTime() + 86400000));
    try { const n = localStorage.getItem('ff_nick'); if (n) f.nickname.value = n; } catch (e) {}
    setPlace(App.getPlace());
    $('tripTitle').textContent = '📝 Записать рыбалку';
    $('tpCancel').hidden = true;
  }

  function editTrip(t) {
    const f = $('tripForm');
    f.reset(); editing = t;
    f.id.value = t.id;
    $('tpTime').value = localInput(new Date(t.trip_at));
    for (const k of ['hours', 'method', 'bait', 'depth_m', 'fish_count', 'weight_kg', 'biggest_kg', 'notes', 'nickname']) f[k].value = t[k] ?? '';
    $('tpFish').value = t.fish || '';
    const r = f.querySelector(`input[name=rating][value="${t.rating}"]`); if (r) r.checked = true;
    f.is_public.checked = !!t.is_public;
    setPlace(t.lat != null ? {lat: t.lat, lon: t.lon, name: t.place || `${t.lat}, ${t.lon}`} : null);
    $('tripTitle').textContent = '✏️ Правка записи';
    $('tpCancel').hidden = false;
    $('tripPanel').scrollIntoView({behavior: 'smooth'});
  }
  $('tpCancel').onclick = resetForm;

  $('tripForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target, fd = new FormData(f), msg = $('tpMsg');
    const when = new Date(fd.get('trip_at'));
    if (isNaN(when)) { msg.textContent = '⚠️ Укажите дату и время'; return; }
    if (when > new Date(Date.now() + 86400000)) { msg.textContent = '⚠️ Дата рыбалки не может быть в будущем'; return; }
    if (!fd.get('rating')) { msg.textContent = '⚠️ Отметьте, как клевало'; return; }
    const fish = fd.get('fish') || null;
    const snap = App.snapshot(when, fish);
    const trip = {
      id: f.id.value || null, trip_at: when.toISOString(), hours: num(fd.get('hours')),
      lat: tripPlace ? +tripPlace.lat.toFixed(4) : null, lon: tripPlace ? +tripPlace.lon.toFixed(4) : null,
      place: tripPlace ? String(tripPlace.name).slice(0, 120) : null,
      fish, method: fd.get('method') || null, bait: String(fd.get('bait') || '').trim().slice(0, 80) || null,
      depth_m: num(fd.get('depth_m')), rating: Number(fd.get('rating')),
      fish_count: num(fd.get('fish_count')), weight_kg: num(fd.get('weight_kg')), biggest_kg: num(fd.get('biggest_kg')),
      notes: String(fd.get('notes') || '').trim().slice(0, 2000) || null,
      nickname: String(fd.get('nickname') || '').trim().slice(0, 40) || null,
      is_public: fd.get('is_public') === 'on',
      // при правке старой записи сохраняем погоду, записанную тогда
      season: snap ? snap.season : (editing && editing.season) || App.season(),
      forecast_score: snap ? snap.forecast_score : editing ? editing.forecast_score : null,
      weather: snap ? snap.weather : editing ? editing.weather : null,
    };
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true; msg.textContent = 'Сохраняю…';
    try {
      await D.save(trip);
      try { if (trip.nickname) localStorage.setItem('ff_nick', trip.nickname); } catch (x) {}
      const shared = trip.is_public && trip.lat != null && trip.fish && when > new Date(Date.now() - 29 * 86400000);
      msg.textContent = '✅ Сохранено в дневник' + (trip.is_public ? (shared ? ' и в общие отчёты' : '. В общие отчёты не попала: нужны рыба, место и дата за последние 30 дней') : '');
      resetForm();
      await refresh();
      App.refreshCatches();
      if (!D.email) renderAccount(); // появилась ссылка для переноса
    } catch (err) { msg.textContent = '⚠️ ' + err.message; }
    finally { btn.disabled = false; }
  };

  // ---------- данные ----------
  async function refresh() {
    try { trips = await D.list(); loaded = true; }
    catch (e) { flash('⚠️ Дневник не загрузился: ' + e.message); }
    renderAll();
  }

  function filtered() {
    const fish = $('dFilterFish').value, year = $('dFilterYear').value;
    return trips.filter(t => (!fish || t.fish === fish) && (!year || new Date(t.trip_at).getFullYear() === +year));
  }

  function renderAll() {
    const years = [...new Set(trips.map(t => new Date(t.trip_at).getFullYear()))].sort((a, b) => b - a);
    const ySel = $('dFilterYear'), yv = ySel.value;
    ySel.innerHTML = '<option value="">За всё время</option>' + years.map(y => `<option value="${y}">${y}</option>`).join('');
    ySel.value = years.includes(+yv) ? yv : '';
    renderReport(); renderList();
  }

  function renderList() {
    const list = filtered();
    $('tripList').innerHTML = list.length ? list.map(t => {
      const d = new Date(t.trip_at);
      const parts = [t.fish_count != null ? `${t.fish_count} шт.` : '', t.weight_kg != null ? `${fmt(+t.weight_kg, 2)} кг` : '',
        t.biggest_kg != null ? `крупная ${fmt(+t.biggest_kg, 2)} кг` : '', METHOD[t.method] || '', t.bait ? `на ${t.bait}` : '',
        t.depth_m != null ? `глубина ${fmt(+t.depth_m)} м` : '', t.hours != null ? `${fmt(+t.hours)} ч` : ''].filter(Boolean).join(', ');
      const w = t.weather || {};
      const wx = w.p ? ` · ${Math.round(w.p * 0.750062)} мм рт. ст., ${fmt(w.air)}°C, ветер ${fmt(w.wind)} м/с` : '';
      return `<li class="trip">
        <div><b>${FACE[t.rating]} ${esc(fishName(t.fish))}</b> — ${RATING[t.rating]}${parts ? ' · ' + esc(parts) : ''}
          ${t.season === 'ice' ? ' ❄️' : ''}${t.is_public ? ' <span class="badge open" title="Опубликовано в общих отчётах">общий</span>' : ''}</div>
        <div class="meta">${d.toLocaleDateString('ru-RU', {day: 'numeric', month: 'long', year: 'numeric'})} ${pad(d.getHours())}:${pad(d.getMinutes())}
          ${t.place ? ' · ' + esc(t.place) : ''}${t.forecast_score != null ? ' · прогноз был ' + t.forecast_score : ''}${wx}</div>
        ${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ''}
        <div class="buttons"><button type="button" class="small" data-edit="${t.id}">Изменить</button>
          <button type="button" class="small danger" data-del="${t.id}">Удалить</button></div>
      </li>`;
    }).join('') : `<li class="foot">${trips.length ? 'Под фильтр ничего не подходит.' : 'Пока нет записей. Сохраните первую рыбалку в форме выше.'}</li>`;

    $('tripList').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => editTrip(trips.find(t => String(t.id) === b.dataset.edit)));
    $('tripList').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Удалить запись из дневника? Если она была в общих отчётах, оттуда она тоже исчезнет.')) return;
      try { await D.remove(+b.dataset.del); await refresh(); App.refreshCatches(); }
      catch (e) { flash('⚠️ ' + e.message); }
    });
  }

  function pearson(xs, ys) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
  }

  function groupTable(title, list, keyFn, nameFn, limit = 6) {
    const g = new Map();
    for (const t of list) {
      const k = keyFn(t); if (!k) continue;
      const x = g.get(k) || {n: 0, r: 0, fish: 0};
      x.n++; x.r += t.rating; x.fish += t.fish_count || 0; g.set(k, x);
    }
    const rows = [...g.entries()].sort((a, b) => b[1].r / b[1].n - a[1].r / a[1].n || b[1].n - a[1].n).slice(0, limit);
    if (!rows.length) return '';
    return `<div class="gt"><h3>${title}</h3><table>
      <tr><th></th><th>рыбалок</th><th>клёв</th><th>рыб</th></tr>
      ${rows.map(([k, x]) => `<tr><td>${esc(nameFn(k))}</td><td>${x.n}</td><td>${fmt(x.r / x.n)}</td><td>${x.fish}</td></tr>`).join('')}
    </table></div>`;
  }

  function renderReport() {
    const list = filtered(), el = $('dReport');
    if (!list.length) { el.innerHTML = '<p class="foot">Отчёты появятся, когда в дневнике будут записи.</p>'; return; }
    const sum = k => list.reduce((s, t) => s + (+t[k] || 0), 0);
    const big = list.filter(t => t.biggest_kg != null).sort((a, b) => b.biggest_kg - a.biggest_kg)[0];
    const good = list.filter(t => t.rating >= 4).length;

    // по месяцам за последние 12 месяцев
    const now = new Date(), months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const m = list.filter(t => { const x = new Date(t.trip_at); return x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth(); });
      months.push({label: d.toLocaleDateString('ru-RU', {month: 'short'}).replace('.', ''), n: m.length, fish: m.reduce((s, t) => s + (t.fish_count || 0), 0)});
    }
    const maxN = Math.max(1, ...months.map(m => m.n));

    const pairs = list.filter(t => t.forecast_score != null);
    let acc = `нужно хотя бы 5 записей с прогнозом (сейчас ${pairs.length})`;
    if (pairs.length >= 5) {
      const r = pearson(pairs.map(t => t.forecast_score), pairs.map(t => t.rating));
      acc = (r > 0.5 ? 'хорошо совпадает' : r > 0.2 ? 'частично совпадает' : 'пока не совпадает') + ` (r = ${r.toFixed(2)}, записей: ${pairs.length})`;
    }

    el.innerHTML = `
      <div class="stats">
        <div class="stat"><div class="n">Рыбалок</div><div class="v">${list.length}</div></div>
        <div class="stat"><div class="n">Поймано рыбы</div><div class="v">${sum('fish_count')}</div></div>
        <div class="stat"><div class="n">Общий вес</div><div class="v">${fmt(sum('weight_kg'))} кг</div></div>
        <div class="stat"><div class="n">Средний клёв</div><div class="v">${fmt(sum('rating') / list.length)} / 5</div></div>
        <div class="stat"><div class="n">Удачных выездов</div><div class="v">${Math.round(good / list.length * 100)}%</div></div>
        ${big ? `<div class="stat"><div class="n">Трофей</div><div class="v">${fmt(+big.biggest_kg, 2)} кг</div>
          <div class="foot">${esc(fishName(big.fish))}, ${new Date(big.trip_at).toLocaleDateString('ru-RU')}</div></div>` : ''}
      </div>
      <h3>Рыбалки по месяцам</h3>
      <div class="months">${months.map(m => `<div class="m" title="${m.label}: ${m.n} рыбалок, ${m.fish} рыб">
        <span class="mv">${m.n || ''}</span><b style="height:${m.n / maxN * 100}%"></b><span>${m.label}</span></div>`).join('')}</div>
      <div class="gts">
        ${groupTable('По рыбе', list, t => t.fish, fishName)}
        ${groupTable('Что работает: снасть', list, t => t.method, k => METHOD[k] || k)}
        ${groupTable('Что работает: приманка', list, t => t.bait && t.bait.trim().toLowerCase(), k => k)}
        ${groupTable('Места', list, t => t.place, k => k)}
      </div>
      <p class="foot"><b>Насколько прогноз сайта совпал с вашим клёвом:</b> ${acc}.</p>`;
  }

  $('dFilterFish').innerHTML = '<option value="">Все рыбы</option>' + Object.entries(FISH).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  $('dFilterFish').onchange = $('dFilterYear').onchange = () => { renderReport(); renderList(); };

  $('dExport').onclick = () => {
    const list = filtered();
    if (!list.length) { flash('⚠️ Нет записей для выгрузки'); return; }
    const cols = [['trip_at', 'Дата'], ['place', 'Место'], ['lat', 'Широта'], ['lon', 'Долгота'], ['fish', 'Рыба'], ['rating', 'Клёв 1-5'],
      ['method', 'Снасть'], ['bait', 'Приманка'], ['depth_m', 'Глубина, м'], ['fish_count', 'Поймано, шт'], ['weight_kg', 'Вес, кг'],
      ['biggest_kg', 'Крупная, кг'], ['hours', 'Часов'], ['forecast_score', 'Прогноз сайта'], ['notes', 'Заметки']];
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const val = (t, k) => k === 'trip_at' ? new Date(t.trip_at).toLocaleString('ru-RU') : k === 'fish' ? fishName(t.fish)
      : k === 'method' ? (METHOD[t.method] || '') : t[k];
    const csv = '﻿' + [cols.map(c => cell(c[1])).join(';'), ...list.map(t => cols.map(c => cell(val(t, c[0]))).join(';'))].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
    a.download = `rybalka-diary-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  // ---------- старт ----------
  resetForm();
  const m = location.hash.match(/^#diary=([\w-]{20,})$/);
  if (m) {
    if (!D.hasKey || D.key === m[1] || confirm('Открыть дневник по ссылке? Дневник этого устройства будет заменён — сохраните ссылку на него, если она нужна.')) D.useKey(m[1]);
    history.replaceState(null, '', '#diary');
  }
  if (location.hash.startsWith('#diary')) showTab('diary');
})();
