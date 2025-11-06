// ==UserScript==
// @name         HideoutWarrior
// @namespace    https://github.com/HideoutWarrior/HideoutWarrior
// @version      1
// @description  Empty
// @author       HideoutWarrior
// @match        https://www.pathofexile.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/HideoutWarrior/poe-autoclicker/main/HideoutWarrior.user.js
// @downloadURL  https://raw.githubusercontent.com/HideoutWarrior/poe-autoclicker/main/HideoutWarrior.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ------- Настройки -------
  const BASE_INTERVAL = 7000;
  const JITTER = 800;
  const MOVE_STEPS = 6;
  const MOVE_STEP_MS = 20;
  const CLICK_PRESS_MS = 80;
  const AUTO_PAUSE_AFTER_CLICK = true;
  // --------------------------

  let lastClickTime = 0;
  let isPaused = true; // <-- теперь стартует на паузе
  let enabled = true;

  // === Цветное уведомление ===
  const notifyBox = document.createElement('div');
  notifyBox.style.cssText = `
    position: fixed;
    top: 30px;
    right: 10px;
    z-index: 999999;
    background: rgba(0,0,0,0.8);
    color: #fff;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 13px;
    font-family: Arial, sans-serif;
    pointer-events: none;
    min-width: 180px;
    text-align: center;
    box-shadow: 0 0 10px rgba(0,0,0,0.5);
  `;
  document.body.appendChild(notifyBox);

  function updateNotice() {
    let status = !enabled ? 'ВЫКЛЮЧЕН' : (isPaused ? 'ПАУЗА' : 'ЗАПУЩЕН');
    let color = 'white';
    if (!enabled) color = '#ff4d4d';
    else if (isPaused) color = '#ffa500';
    else color = '#4cff4c';
    notifyBox.innerHTML = `
      <div style="color:${color}; font-weight:bold;">PoE AutoClick — ${status}</div>
    `;
  }
  updateNotice();

  // === Горячие клавиши ===
  window.addEventListener('keydown', e => {
    if (e.code === 'F8') {
      enabled = !enabled;
      if (!enabled) isPaused = true;
      updateNotice();
      console.log('[PoE AutoClick] toggled enabled ->', enabled);
    }
    if (e.code === 'Slash' || e.key === '.' || e.key === 'ю') { // поддержка русской раскладки
      if (!enabled) return console.log('[PoE AutoClick] Скрипт выключен. Включи F8.');
      isPaused = !isPaused;
      updateNotice();
      console.log('[PoE AutoClick] pause toggled ->', isPaused);
    }
  });

  function randBetween(min, max) { return Math.random() * (max - min) + min; }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
           rect.right > 0 && rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
           rect.width > 0 && rect.height > 0;
  }

  async function humanMoveTo(el) {
    try {
      const rect = el.getBoundingClientRect();
      const startX = window.innerWidth / 2 + randBetween(-100, 100);
      const startY = window.innerHeight / 2 + randBetween(-50, 50);
      const targetX = rect.left + rect.width / 2 + randBetween(-3, 3);
      const targetY = rect.top + rect.height / 2 + randBetween(-3, 3);
      for (let i = 1; i <= MOVE_STEPS; i++) {
        const x = startX + (targetX - startX) * (i / MOVE_STEPS) + randBetween(-1, 1);
        const y = startY + (targetY - startY) * (i / MOVE_STEPS) + randBetween(-1, 1);
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(x), clientY: Math.round(y) }));
        await new Promise(r => setTimeout(r, MOVE_STEP_MS + Math.random() * 10));
      }
    } catch (e) {}
  }

  async function humanClick(el) {
    try {
      const rect = el.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2 + randBetween(-2, 2));
      const cy = Math.round(rect.top + rect.height / 2 + randBetween(-2, 2));
      const downType = (typeof PointerEvent === 'function') ? 'pointerdown' : 'mousedown';
      const upType = (typeof PointerEvent === 'function') ? 'pointerup' : 'mouseup';
      el.dispatchEvent(new MouseEvent(downType, { bubbles: true, clientX: cx, clientY: cy }));
      await new Promise(r => setTimeout(r, CLICK_PRESS_MS + randBetween(-50, 60)));
      el.dispatchEvent(new MouseEvent(upType, { bubbles: true, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
    } catch (e) { try { el.click(); } catch {} }
  }

  function handleMutations(mutations) {
    if (!enabled || isPaused) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const btn = node.querySelector('div.right button.direct-btn');
        if (!btn) continue;

        const now = Date.now();
        const effectiveInterval = BASE_INTERVAL + randBetween(-JITTER, JITTER);
        if (now - lastClickTime < effectiveInterval) continue;

        (async () => {
          if (!isVisible(btn)) btn.scrollIntoView({ block: 'center', behavior: 'auto' });
          await new Promise(r => setTimeout(r, randBetween(120, 260)));
          await humanMoveTo(btn);
          try { await humanClick(btn); }
          catch(err){ console.warn('[PoE AutoClick] Ошибка клика:', err); }

          lastClickTime = Date.now();
          updateNotice();
          console.log('[PoE AutoClick] выполнен клик');

          if (AUTO_PAUSE_AFTER_CLICK) {
            isPaused = true;
            updateNotice();
            console.log('[PoE AutoClick] автопауза включена после клика');
          }
        })();

        return;
      }
    }
  }

  function waitForSelector(selector, interval = 300, timeout = 30000) {
    return new Promise(resolve => {
      const start = Date.now();
      const t = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) { clearInterval(t); resolve(el); }
        else if (Date.now() - start > timeout) { clearInterval(t); resolve(null); }
      }, interval);
    });
  }

  (async function init() {
    console.log('[PoE AutoClick] Ожидание контейнера...');
    const target = await waitForSelector('div#trade .results');
    if (!target) return console.error('[PoE AutoClick] Контейнер не найден.');
    const observer = new MutationObserver(handleMutations);
    observer.observe(target, { childList: true, subtree: true });
    console.log('[PoE AutoClick] Наблюдение запущено. "/" или "." — пауза, F8 — вкл/выкл.');
    updateNotice();
  })();

})();
