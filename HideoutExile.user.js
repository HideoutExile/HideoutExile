// ==UserScript==
// @name         HideoutExile
// @namespace    https://github.com/HideoutExile/HideoutExile
// @version      1.2
// @description  Empty
// @author       HideoutExile
// @match        https://www.pathofexile.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/HideoutExile/HideoutExile/main/HideoutExile.user.js
// @downloadURL  https://raw.githubusercontent.com/HideoutExile/HideoutExile/main/HideoutExile.user.js
// ==/UserScript==

(function () {
  'use strict';

  const BASE_INTERVAL = 7000;
  const JITTER = 800;
  const MOVE_STEPS = 6;
  const MOVE_STEP_MS = 20;
  const CLICK_PRESS_MS = 80;
  const AUTO_PAUSE_AFTER_CLICK = true;

  let lastClickTime = 0;
  let isPaused = true;

  let notifyBox = null;
  let drag = { active: false, offsetX: 0, offsetY: 0 };

  function ensureNotice() {
    if (notifyBox && document.body.contains(notifyBox)) return;
    if (!document.body) return setTimeout(ensureNotice, 100);

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
    pauseBtn.onclick = () => {
      isPaused = !isPaused;
      updateNotice();
    };

    notifyBox.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      drag.active = true;
      drag.offsetX = e.clientX - notifyBox.getBoundingClientRect().left;
      drag.offsetY = e.clientY - notifyBox.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', e => {
      if (!drag.active) return;
      notifyBox.style.left = (e.clientX - drag.offsetX) + 'px';
      notifyBox.style.top = (e.clientY - drag.offsetY) + 'px';
      notifyBox.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => (drag.active = false));

    updateNotice();
  }

  function updateNotice() {
    ensureNotice();
    if (!notifyBox) return;

    const statusDiv = notifyBox.querySelector('#poe-status');
    const pauseBtn = notifyBox.querySelector('#poe-pause');

    const state = isPaused ? 'ПАУЗА' : 'ЗАПУЩЕН';
    const color = isPaused ? '#ffa500' : '#4cff4c';

    pauseBtn.textContent = isPaused ? '▶' : '⏸';
    statusDiv.innerHTML = `<div style="color:${color}; font-weight:bold;">PoE AutoClick — ${state}</div>`;
  }

  window.addEventListener('keydown', e => {
    if (e.code === 'Slash' || e.key === '.' || e.key === 'ю') {
      isPaused = !isPaused;
      updateNotice();
    }
  });

  function randBetween(min, max) { return Math.random() * (max - min) + min; }
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  async function humanMoveTo(el) {
    const rect = el.getBoundingClientRect();
    let startX = window.innerWidth / 2 + randBetween(-100, 100);
    let startY = window.innerHeight / 2 + randBetween(-50, 50);
    const targetX = rect.left + rect.width / 2 + randBetween(-3, 3);
    const targetY = rect.top + rect.height / 2 + randBetween(-3, 3);
    const steps = MOVE_STEPS + Math.floor(randBetween(0, 5));
    for (let i = 1; i <= steps; i++) {
      const x = startX + (targetX - startX) * (i / steps) + randBetween(-2.5, 2.5);
      const y = startY + (targetY - startY) * (i / steps) + randBetween(-2.5, 2.5);
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      await new Promise(r => setTimeout(r, MOVE_STEP_MS + randBetween(0, 20)));
    }
    for (let j = 0; j < 3; j++) {
      const jitterX = randBetween(-2, 2);
      const jitterY = randBetween(-2, 2);
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: targetX + jitterX, clientY: targetY + jitterY }));
      await new Promise(r => setTimeout(r, randBetween(15, 40)));
    }
  }

  async function humanClick(el) {
    try {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2 + randBetween(-2, 2);
      const cy = rect.top + rect.height / 2 + randBetween(-2, 2);
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
      await new Promise(r => setTimeout(r, CLICK_PRESS_MS + randBetween(-60, 60)));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
      return true;
    } catch (e) {
      console.warn('Click failed:', e);
      return false;
    }
  }

  function handleMutations(mutations) {
    if (isPaused) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const btn = node.querySelector('div.right button.direct-btn');
        if (!btn) continue;

        const now = Date.now();
        const interval = BASE_INTERVAL + randBetween(-JITTER, JITTER);
        if (now - lastClickTime < interval) continue;

        (async () => {
          if (!isVisible(btn)) btn.scrollIntoView({ block: 'center' });
          await new Promise(r => setTimeout(r, randBetween(120, 400))); // рандомная задержка перед движением
          await humanMoveTo(btn);
          const success = await humanClick(btn);
          lastClickTime = Date.now();
          if (AUTO_PAUSE_AFTER_CLICK && success) isPaused = true;
          updateNotice();
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
    ensureNotice();
    const target = await waitForSelector('div#trade .results');
    if (!target) return;
    const observer = new MutationObserver(handleMutations);
    observer.observe(target, { childList: true, subtree: true });
    updateNotice();
  })();

})();

