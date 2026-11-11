// Источники погоды. Основной — MET Norway (api.met.no), запасной — Open-Meteo.
// Оба приводятся к одному формату (как у Open-Meteo), чтобы модель прогноза не зависела от источника:
// {source, utc_offset_seconds, hourly:{time[], temperature_2m[], pressure_msl[], wind_speed_10m[], precipitation[], cloud_cover[]},
//  daily:{time[], sunrise[], sunset[]}} — время в секундах Unix.
(function (global) {
  'use strict';
  const H = 3600000, D = 86400000;

  // ---------- Восход и закат (формула «sunrise equation», точность ±1–2 мин) ----------
  function sunTimes(dayStartUtcMs, lat, lon) {
    const rad = Math.PI / 180;
    const jd = (dayStartUtcMs + D / 2) / D + 2440587.5;          // юлианская дата полудня
    const n = Math.round(jd - 2451545.0 + 0.0008);
    const Js = n - lon / 360;
    const M = (357.5291 + 0.98560028 * Js) % 360;
    const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
    const lambda = (M + C + 180 + 102.9372) % 360;
    const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * lambda * rad);
    const sinD = Math.sin(lambda * rad) * Math.sin(23.4397 * rad), cosD = Math.cos(Math.asin(sinD));
    const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinD) / (Math.cos(lat * rad) * cosD);
    const toMs = j => (j - 2440587.5) * D;
    if (cosW > 1) return {sr: toMs(Jt), ss: toMs(Jt)};                     // полярная ночь
    if (cosW < -1) return {sr: toMs(Jt) - D / 2, ss: toMs(Jt) + D / 2};    // полярный день
    const w = Math.acos(cosW) / rad;
    return {sr: toMs(Jt - w / 360), ss: toMs(Jt + w / 360)};
  }

  // Часовой пояс: у met.no его нет, берём пояс устройства пользователя
  const browserOffsetSec = () => -new Date().getTimezoneOffset() * 60;

  function buildDaily(fromMs, toMs, offSec, lat, lon) {
    const off = offSec * 1000, daily = {time: [], sunrise: [], sunset: []};
    let day = Math.floor((fromMs + off) / D) * D - off;   // местная полночь
    for (; day <= toMs; day += D) {
      const {sr, ss} = sunTimes(day + off, lat, lon);
      daily.time.push(day / 1000); daily.sunrise.push(Math.round(sr / 1000)); daily.sunset.push(Math.round(ss / 1000));
    }
    return daily;
  }

  // ---------- MET Norway ----------
  async function metNo(lat, lon) {
    // по правилам api.met.no координаты — не больше 4 знаков после запятой
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${(+lat).toFixed(4)}&lon=${(+lon).toFixed(4)}`;
    const r = await fetchT(url, {}, 15000);
    if (!r.ok) throw new Error(`MET Norway ответил кодом ${r.status}`);
    const j = await r.json();
    const ts = (j.properties && j.properties.timeseries) || [];
    if (ts.length < 2) throw new Error('MET Norway вернул пустой прогноз');

    // точки прогноза: первые ~2 суток ежечасно, дальше раз в 6 часов
    const pts = ts.map(e => {
      const d = e.data.instant.details;
      return {t: Date.parse(e.time), temp: d.air_temperature, p: d.air_pressure_at_sea_level,
        wind: d.wind_speed, cloud: d.cloud_area_fraction,
        p1: e.data.next_1_hours && e.data.next_1_hours.details.precipitation_amount,
        p6: e.data.next_6_hours && e.data.next_6_hours.details.precipitation_amount};
    }).filter(x => isFinite(x.t) && x.temp != null && x.p != null);

    // переводим в ровную почасовую сетку с линейной интерполяцией
    const hourly = {time: [], temperature_2m: [], pressure_msl: [], wind_speed_10m: [], precipitation: [], cloud_cover: []};
    const first = Math.ceil(pts[0].t / H) * H, last = pts[pts.length - 1].t;
    let k = 0;
    for (let t = first; t <= last; t += H) {
      while (k < pts.length - 2 && pts[k + 1].t <= t) k++;
      const a = pts[k], b = pts[k + 1] || a, f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      const lerp = key => (a[key] == null ? b[key] : b[key] == null ? a[key] : a[key] + (b[key] - a[key]) * f);
      // осадки: за час, если есть; иначе 6-часовая сумма, поделённая поровну
      const src = pts.filter(x => x.t <= t).pop() || a;
      const prec = src.t === t && src.p1 != null ? src.p1 : src.p6 != null ? src.p6 / 6 : (src.p1 || 0);
      hourly.time.push(t / 1000);
      hourly.temperature_2m.push(+lerp('temp').toFixed(1));
      hourly.pressure_msl.push(+lerp('p').toFixed(1));
      hourly.wind_speed_10m.push(+(lerp('wind') || 0).toFixed(1));
      hourly.cloud_cover.push(Math.round(lerp('cloud') || 0));
      hourly.precipitation.push(+prec.toFixed(2));
    }
    const off = browserOffsetSec();
    return {source: 'MET Norway', utc_offset_seconds: off, hourly, daily: buildDaily(first, last, off, lat, lon)};
  }

  // ---------- Open-Meteo (запасной) ----------
  async function openMeteo(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,pressure_msl,wind_speed_10m,precipitation,cloud_cover` +
      `&daily=sunrise,sunset&wind_speed_unit=ms&timezone=auto&past_days=3&forecast_days=10&timeformat=unixtime`;
    const r = await fetchT(url, {}, 15000);
    if (!r.ok) throw new Error(`Open-Meteo ответил кодом ${r.status}`);
    return {source: 'Open-Meteo', ...(await r.json())};
  }

  async function load(lat, lon) {
    const errors = [];
    for (const src of [metNo, openMeteo]) {
      try { return await src(lat, lon); } catch (e) { errors.push(e.message); }
    }
    throw new Error('Не удалось получить погоду: ' + errors.join('; '));
  }

  global.Weather = {load, metNo, openMeteo, sunTimes};
})(window);
