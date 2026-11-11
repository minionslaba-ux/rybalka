// Модель прогноза клёва. Чистые функции без DOM — их можно тестировать отдельно.
(function (global) {
  'use strict';

  // tOpt — комфортная температура воды (°C) на открытой воде
  // night/day — активность ночью/днём; clouds — любит пасмурно (0..1)
  // pressureSens — чувствительность к скачкам давления
  // winter — насколько активно берёт со льда (0..1); winterTime — когда клюёт зимой
  const FISH = {
    pike:    {name:'Щука',   tOpt:[8,18],  night:0.3,  day:0.75, clouds:1,   pressureSens:1.0, winter:0.8,  winterTime:'dawn'},
    perch:   {name:'Окунь',  tOpt:[12,22], night:0.2,  day:0.9,  clouds:0,   pressureSens:1.0, winter:0.95, winterTime:'day'},
    zander:  {name:'Судак',  tOpt:[10,20], night:0.9,  day:0.5,  clouds:0.8, pressureSens:1.1, winter:0.7,  winterTime:'dusk'},
    bream:   {name:'Лещ',    tOpt:[16,24], night:0.85, day:0.55, clouds:0.3, pressureSens:1.2, winter:0.55, winterTime:'dusk'},
    roach:   {name:'Плотва', tOpt:[10,20], night:0.3,  day:0.85, clouds:0.2, pressureSens:0.8, winter:0.85, winterTime:'day'},
    carp:    {name:'Карп',   tOpt:[18,28], night:0.8,  day:0.6,  clouds:0.4, pressureSens:1.2, winter:0.25, winterTime:'day'},
    crucian: {name:'Карась', tOpt:[18,28], night:0.5,  day:0.8,  clouds:0.5, pressureSens:0.9, winter:0.3,  winterTime:'day'},
    burbot:  {name:'Налим',  tOpt:[1,10],  night:1.0,  day:0.3,  clouds:0.6, pressureSens:0.7, winter:1.0,  winterTime:'night'},
  };

  // веса факторов (сумма = 1)
  const W = {
    open: {pressure:0.25, temp:0.22, wind:0.15, time:0.18, precip:0.07, clouds:0.05, moon:0.08},
    ice:  {pressure:0.32, temp:0.25, wind:0.08, time:0.20, precip:0.05, clouds:0.02, moon:0.08},
  };

  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

  // ---------- Луна ----------
  function moonPhase(date) {
    const synodic = 29.530588853;
    const ref = Date.UTC(2000, 0, 6, 18, 14); // известное новолуние
    const age = (((date - ref) / 86400000) % synodic + synodic) % synodic;
    return age / synodic; // 0 — новолуние, 0.5 — полнолуние
  }
  function moonName(p) {
    if (p < 0.03 || p > 0.97) return '🌑 Новолуние';
    if (p < 0.22) return '🌒 Растущий серп';
    if (p < 0.28) return '🌓 Первая четверть';
    if (p < 0.47) return '🌔 Растущая луна';
    if (p < 0.53) return '🌕 Полнолуние';
    if (p < 0.72) return '🌖 Убывающая луна';
    if (p < 0.78) return '🌗 Последняя четверть';
    return '🌘 Убывающий серп';
  }
  // в новолуние и полнолуние клёв считается хуже, в четвертях — лучше
  const moonFactor = p => 0.8 + 0.2 * Math.abs(Math.sin(2 * Math.PI * p));

  // ---------- Факторы ----------
  function tempFactor(x, fish, season) {
    if (season === 'ice') {
      // подо льдом вода ~1–4°C всегда; важнее, насколько вид активен зимой,
      // и тренд погоды: оттепель оживляет клёв, сильный мороз — гасит
      const warmTrend = clamp(0.85 + x.dt24 * 0.03, 0.6, 1.1);
      const frost = x.air < -20 ? 0.75 : x.air < -12 ? 0.9 : 1;
      return clamp(fish.winter * warmTrend * frost, 0.1, 1);
    }
    const [lo, hi] = fish.tOpt, t = x.water;
    if (t >= lo && t <= hi) return 1;
    const d = t < lo ? lo - t : t - hi;
    return clamp(Math.exp(-(d * d) / (2 * 4 * 4)), 0.15, 1);
  }

  function pressureFactor(x, fish, season) {
    const p = x.p;
    let abs = p < 1000 ? 0.7 : p < 1008 ? 0.85 : p <= 1022 ? 1 : p <= 1030 ? 0.85 : 0.7;
    if (season === 'ice' && p > 1030) abs = 0.6; // морозный антициклон — рыба вялая
    const sens = fish.pressureSens * (season === 'ice' ? 1.3 : 1);
    const jump = Math.abs(x.dp3) * 2 + Math.abs(x.dp24) * 0.5;
    const stab = clamp(1 - (jump - 1.5) * 0.08 * sens, 0.3, 1);
    return abs * stab;
  }

  function windFactor(w, season) {
    if (season === 'ice') return w <= 8 ? 1 : w <= 12 ? 0.75 : 0.5; // подо льдом волны нет, мешает только холод
    if (w < 1) return 0.75;
    if (w <= 5) return 1;
    if (w <= 8) return 0.7;
    if (w <= 12) return 0.45;
    return 0.25;
  }

  function precipFactor(mm, season) {
    if (season === 'ice') return mm <= 2 ? 1 : 0.8; // снежок перед потеплением обычно не мешает
    if (mm <= 0.05) return 0.92;
    if (mm <= 1) return 1;
    if (mm <= 3) return 0.75;
    return 0.5;
  }

  function cloudFactor(c, likes) {
    const pref = 0.85 + 0.15 * (c / 100);
    return likes * pref + (1 - likes) * (1 - 0.05 * Math.abs(c - 50) / 50);
  }

  function timeFactor(x, fish, season) {
    const h = x.time.getTime(), sr = x.sunrise, ss = x.sunset;
    const hrs = v => Math.abs(h - v) / 3600000;
    const isDay = h > sr && h < ss;
    if (season === 'ice') {
      const noon = (sr + ss) / 2;
      switch (fish.winterTime) {
        case 'day':   return isDay ? clamp(1 - hrs(noon) * 0.06, 0.6, 1) : 0.25;
        case 'dawn':  return hrs(sr) <= 2 || hrs(ss) <= 1 ? 1 : isDay ? 0.7 : 0.25;
        case 'dusk':  return hrs(ss) <= 2 || hrs(sr) <= 1 ? 1 : isDay ? 0.55 : 0.6;
        case 'night': return isDay ? 0.3 : 1;
      }
    }
    if (Math.min(hrs(sr), hrs(ss)) <= 1.5) return 1; // зорьки
    return isDay ? fish.day : fish.night;
  }

  function scoreHour(x, fish, season) {
    const f = {
      pressure: pressureFactor(x, fish, season),
      temp:     tempFactor(x, fish, season),
      wind:     windFactor(x.wind, season),
      time:     timeFactor(x, fish, season),
      precip:   precipFactor(x.precip, season),
      clouds:   cloudFactor(x.clouds, fish.clouds),
      moon:     moonFactor(x.moon),
    };
    // взвешенное геометрическое среднее: один плохой фактор заметно тянет вниз
    const w = W[season];
    let s = 0;
    for (const k in w) s += w[k] * Math.log(Math.max(f[k], 0.01));
    // растягиваем шкалу: «сырые» 0.45…1 → 0…100
    return {score: Math.round(100 * clamp((Math.exp(s) - 0.45) / 0.55)), f};
  }

  // Превращает ответ Open-Meteo в массив часов с производными величинами
  function buildHours(w) {
    const H = w.hourly, off = w.utc_offset_seconds * 1000;
    const days = w.daily.time.map((t, i) => ({t: t * 1000, sr: w.daily.sunrise[i] * 1000, ss: w.daily.sunset[i] * 1000}));
    const out = [];
    for (let i = 0; i < H.time.length; i++) {
      // «температура воды» ≈ средняя температура воздуха за 72 часа (вода инертна)
      const from = Math.max(0, i - 72);
      let sum = 0;
      for (let j = from; j <= i; j++) sum += H.temperature_2m[j];
      const t = H.time[i] * 1000;
      let day = days[0];
      for (const d of days) if (d.t <= t) day = d;
      const back = n => Math.max(0, i - n);
      out.push({
        time: new Date(t), local: new Date(t + off),
        p: H.pressure_msl[i],
        dp3: H.pressure_msl[i] - H.pressure_msl[back(3)],
        dp24: H.pressure_msl[i] - H.pressure_msl[back(24)],
        dt24: H.temperature_2m[i] - H.temperature_2m[back(24)],
        water: sum / (i - from + 1), air: H.temperature_2m[i],
        wind: H.wind_speed_10m[i], precip: H.precipitation[i], clouds: H.cloud_cover[i],
        moon: moonPhase(new Date(t)), sunrise: day.sr, sunset: day.ss,
      });
    }
    return out;
  }

  // Лёд вероятен, если неделю до сегодняшнего дня в среднем было ниже −3°C
  // или последние 3 дня держится мороз ниже −8°C
  function detectSeason(hours, nowMs = Date.now()) {
    let past = hours.filter(h => h.time.getTime() <= nowMs);
    // у некоторых источников (MET Norway) нет прошлых дней — тогда судим по ближайшим трём суткам
    if (past.length < 24) past = hours.slice(0, 72);
    const avg = arr => arr.reduce((s, h) => s + h.air, 0) / Math.max(arr.length, 1);
    const week = avg(past.slice(-24 * 7)), days3 = avg(past.slice(-72));
    return (week < -3 || days3 < -8) ? 'ice' : 'open';
  }

  global.Forecast = {FISH, W, moonPhase, moonName, scoreHour, buildHours, detectSeason, clamp};
})(window);
