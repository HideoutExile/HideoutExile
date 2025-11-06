// ==UserScript==
// @name         HideoutExile
// @namespace    https://github.com/HideoutExile/HideoutExile
// @version      1.22
// @description  None
// @match        https://*.pathofexile.com/trade/search/*
// @match        https://*.pathofexile.com/trade2/search/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/HideoutExile/HideoutExile/main/HideoutExile.user.js
// @downloadURL  https://raw.githubusercontent.com/HideoutExile/HideoutExile/main/HideoutExile.user.js
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG = true; // включи/выключи подробные логи
  const BASE_INTERVAL = 7000;
  const JITTER = 800;
  const MOVE_STEPS = 6;
  const MOVE_STEP_MS = 20;
  const CLICK_PRESS_MS = 80;
  const AUTO_PAUSE_AFTER_CLICK = true;

  function log(...args) { if (DEBUG) console.log('[HideoutExile]', ...args); }

  let lastClickTime = 0;
  let isPaused = true;
  let notifyBox = null;
  let drag = { active: false, offsetX: 0, offsetY: 0 };
  let observer = null;
  let pollTimer = null;
  let lastHref = location.href;
  let mutationThrottle = null;

  // проверка /live на конце пути (учитывает слеши, query, hash)
  function isLivePath(href = location.href) {
    try {
      const u = new URL(href);
      return u.pathname.replace(/\/+$/, '').endsWith('/live');
    } catch (e) { return false; }
  }

  // SPA hooks
  (function (history) {
    const push = history.pushState;
    const replace = history.replaceState;
    history.pushState = function () { push.apply(history, arguments); window.dispatchEvent(new Event('locationchange')); };
    history.replaceState = function () { replace.apply(history, arguments); window.dispatchEvent(new Event('locationchange')); };
  })(window.history);

  window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
  window.addEventListener('locationchange', onLocationChange);

  // polling как резерв
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onLocationChange();
      }
    }, 500);
  }
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // UI: уведомление (появляется только на /live)
  function showNotice() {
    try {
      if (notifyBox && document.body.contains(notifyBox)) return;
      notifyBox = document.createElement('div');
      notifyBox.style.cssText = `
        position: fixed;
        top: 30px;
        right: 10px;
        z-index: 999999;
        background: rgba(0,0,0,0.85);
        color: #fff;
        padding: 10px 14px;
        border-radius: 8px;
        font-size: 13px;
        font-family: Arial, sans-serif;
        text-align: center;
        box-shadow: 0 0 10px rgba(0,0,0,0.5);
        user-select: none;
        cursor: move;
      `;
      notifyBox.innerHTML = `
        <div id="poe-status" style="margin-bottom:6px;"></div>
        <div style="display:flex; gap:10px; justify-content:center;">
          <button id="poe-pause" title="Пауза/Возобновить (/)">⏸</button>
        </div>
      `;
      document.body.appendChild(notifyBox);

      notifyBox.querySelectorAll('button').forEach(btn => {
        btn.style.cssText = `
          background:#222;
          color:#fff;
          border:1px solid #555;
          border-radius:6px;
          width:36px;
          height:30px;
          cursor:pointer;
          font-size:16px;
        `;
        btn.onmouseenter = () => btn.style.background = '#333';
        btn.onmouseleave = () => btn.style.background = '#222';
      });

      const pauseBtn = notifyBox.querySelector('#poe-pause');
      pauseBtn.onclick = () => togglePause();

      // drag
      notifyBox.addEventListener('mousedown', e => {
        if (e.target.tagName === 'BUTTON') return;
        drag.active = true;
        drag.offsetX = e.clientX - notifyBox.getBoundingClientRect().left;
        drag.offsetY = e.clientY - notifyBox.getBoundingClientRect().top;
      });
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);

      updateNotice();
      log('Уведомление показано');
    } catch (e) { console.error('[HideoutExile] showNotice error', e); }
  }

  function onDragMove(e) {
    if (!drag.active || !notifyBox) return;
    notifyBox.style.left = (e.clientX - drag.offsetX) + 'px';
    notifyBox.style.top = (e.clientY - drag.offsetY) + 'px';
    notifyBox.style.right = 'auto';
  }
  function onDragEnd() { drag.active = false; }

  function hideNotice() {
    try {
      if (!notifyBox) return;
      notifyBox.remove();
      notifyBox = null;
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
      log('Уведомление скрыто');
    } catch (e) { console.error('[HideoutExile] hideNotice error', e); }
  }

  function updateNotice() {
    if (!notifyBox) return;
    const statusDiv = notifyBox.querySelector('#poe-status');
    const pauseBtn = notifyBox.querySelector('#poe-pause');
    const state = isPaused ? 'ПАУЗА' : 'ЗАПУЩЕН';
    const color = isPaused ? '#ffa500' : '#4cff4c';
    pauseBtn.textContent = isPaused ? '▶' : '⏸';
    statusDiv.innerHTML = `<div style="color:${color}; font-weight:bold;">PoE AutoClick — ${state}</div>`;
    log('Состояние:', state);
  }

  function togglePause() { setPauseState(!isPaused); }
  function setPauseState(paused) {
    isPaused = paused;
    if (observer) {
      if (paused) {
        try { observer.disconnect(); } catch (e) {}
      } else {
        const target = document.querySelector('div#trade .results');
        if (target) observer.observe(target, { childList: true, subtree: true });
      }
    }
    updateNotice();
  }

  window.addEventListener('keydown', e => {
    if (e.code === 'Slash' || e.key === '.' || e.key === 'ю') {
      togglePause();
    }
  });

  // humanized helpers
  function randBetween(min, max) { return Math.random() * (max - min) + min; }
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && rect.width > 0 && rect.height > 0;
  }

  async function humanMoveTo(el) {
    try {
      const rect = el.getBoundingClientRect();
      const startX = window.innerWidth / 2 + randBetween(-100, 100);
      const startY = window.innerHeight / 2 + randBetween(-50, 50);
      const targetX = rect.left + rect.width / 2 + randBetween(-3, 3);
      const targetY = rect.top + rect.height / 2 + randBetween(-3, 3);
      const steps = MOVE_STEPS + Math.floor(randBetween(0, 5));
      for (let i = 1; i <= steps; i++) {
        const x = startX + (targetX - startX) * (i / steps) + randBetween(-2.5, 2.5);
        const y = startY + (targetY - startY) * (i / steps) + randBetween(-2.5, 2.5);
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(x), clientY: Math.round(y) }));
        await new Promise(r => setTimeout(r, MOVE_STEP_MS + Math.random() * 20));
      }
      for (let j = 0; j < 3; j++) {
        const jitterX = randBetween(-2, 2);
        const jitterY = randBetween(-2, 2);
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(targetX + jitterX), clientY: Math.round(targetY + jitterY) }));
        await new Promise(r => setTimeout(r, randBetween(15, 40)));
      }
    } catch (e) { console.warn('[HideoutExile] humanMoveTo error', e); }
  }

  async function humanClick(el) {
    try {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2 + randBetween(-2, 2));
      const cy = Math.round(rect.top + rect.height / 2 + randBetween(-2, 2));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
      await new Promise(r => setTimeout(r, CLICK_PRESS_MS + randBetween(-60, 60)));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
      log('Клик выполнен');
      return true;
    } catch (e) {
      console.warn('[HideoutExile] humanClick failed', e);
      return false;
    }
  }

  // расширенный поиск кнопки: несколько вариантов селекторов
  function findButtonInNode(node) {
    const selectors = [
      'div.right button.direct-btn',
      'button[data-id="live-button"]',
      'button:contains("Whisper")', // это псевдо — не работает в querySelector, но оставлю для заметности
    ];
    for (const s of selectors) {
      try {
        if (s === 'button:contains("Whisper")') continue;
        const btn = node.querySelector(s);
        if (btn) return btn;
      } catch (e) {}
    }
    // если node сам является кнопкой
    if (node.matches && node.matches('button')) return node;
    return null;
  }

  function handleMutations(mutations) {
    if (isPaused) return;
    if (mutationThrottle) return;
    mutationThrottle = setTimeout(() => {
      mutationThrottle = null;
      try {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            const btn = findButtonInNode(node);
            if (!btn) continue;
            const now = Date.now();
            const interval = BASE_INTERVAL + randBetween(-JITTER, JITTER);
            if (now - lastClickTime < interval) continue;
            (async () => {
              try {
                if (!isVisible(btn)) btn.scrollIntoView({ block: 'center' });
                await new Promise(r => setTimeout(r, randBetween(120, 400)));
                await humanMoveTo(btn);
                const success = await humanClick(btn);
                lastClickTime = Date.now();
                if (AUTO_PAUSE_AFTER_CLICK && success) {
                  setPauseState(true);
                  log('Автопауза после успешного клика');
                }
              } catch (e) { console.error('[HideoutExile] inner click flow error', e); }
              updateNotice();
            })();
            return; // только первая кнопка
          }
        }
      } catch (e) { console.error('[HideoutExile] handleMutations error', e); }
    }, 150);
  }

  function waitForSelector(selector, interval = 300, timeout = 30000) {
    return new Promise(resolve => {
      const start = Date.now();
      const t = setInterval(() => {
        try {
          const el = document.querySelector(selector);
          if (el) { clearInterval(t); resolve(el); }
          else if (Date.now() - start > timeout) { clearInterval(t); resolve(null); }
        } catch (e) { clearInterval(t); resolve(null); }
      }, interval);
    });
  }

  async function startScript() {
    try {
      if (observer) { log('observer уже запущен — перезапуск'); observer.disconnect(); observer = null; }
      if (!isLivePath()) { log('startScript: не /live — выходим'); return; }
      showNotice();
      setPauseState(false); // при старте снимаем паузу, но можно изменить
      const target = await waitForSelector('div#trade .results', 200, 15000);
      if (!target) { log('Контейнер results не найден'); hideNotice(); return; }
      observer = new MutationObserver(handleMutations);
      observer.observe(target, { childList: true, subtree: true });
      startPolling();
      log('Скрипт запущен, наблюдение включено');
    } catch (e) { console.error('[HideoutExile] startScript error', e); }
  }

  function stopScript() {
    try {
      if (observer) { observer.disconnect(); observer = null; log('Наблюдение отключено'); }
      stopPolling();
      hideNotice();
      isPaused = true;
      log('Скрипт остановлен');
    } catch (e) { console.error('[HideoutExile] stopScript error', e); }
  }

  // robust location change handler
  function onLocationChange() {
    try {
      const live = isLivePath();
      log('URL изменился, /live?', live, location.href);
      if (live) startScript();
      else stopScript();
    } catch (e) { console.error('[HideoutExile] onLocationChange error', e); }
  }

  // initial
  try {
    if (isLivePath()) startScript();
    else {
      // не стартуем, но включаем polling чтобы поймать быстрый SPA-change
      startPolling();
      log('Скрипт готов, ждёт /live (polling включён)');
    }
  } catch (e) { console.error('[HideoutExile] init error', e); }

})();
