// Общие помощники: запросы с таймаутом и вывод неожиданных ошибок на экран.
(function (global) {
  'use strict';
  global.APP_VERSION = '4';

  // fetch, который не «висит» бесконечно, если сервис недоступен или режется провайдером
  global.fetchT = function (url, opts = {}, ms = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, {...opts, signal: ctrl.signal})
      .catch(e => {
        const host = (() => { try { return new URL(url).host; } catch (x) { return url; } })();
        throw new Error(e.name === 'AbortError' ? `Сервер ${host} не ответил за ${ms / 1000} с` : `Нет связи с ${host}`);
      })
      .finally(() => clearTimeout(timer));
  };

  // Любая непойманная ошибка — в строку статуса, чтобы было что прислать разработчику
  function show(msg) {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = `⚠️ Ошибка: ${msg} (версия ${global.APP_VERSION})`;
    el.classList.add('err');
  }
  global.addEventListener('error', e => show(e.message || 'неизвестная ошибка'));
  global.addEventListener('unhandledrejection', e => show((e.reason && e.reason.message) || String(e.reason)));
})(window);
