// ==UserScript==
// @name         HideoutExile
// @namespace    https://github.com/HideoutExile/HideoutExile
// @version      1.3.3
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

  // --- Configuration ---
  const CONFIG = {
    BASE_INTERVAL: 50,
    JITTER: 20,
    QUICK_RETRY_MIN: 10,
    QUICK_RETRY_MAX: 30,
    MOVE_STEPS: 6,
    MOVE_STEP_MS: 20,
    CLICK_PRESS_MS: 10,
    CLICK_JITTER: { min: -5, max: 2 },
    SCROLL_JITTER: { min: 15, max: 20 },
    TARGET_API_URL: "/api/trade/whisper",
  };

  // --- Storage Keys ---
  const STORAGE_KEYS = {
    AUTO_RESUME_ENABLED: 'he_autoResumeEnabled',
    AUTO_RESUME_SECONDS: 'he_autoResumeSeconds',
    RETRY_ON_FAIL_ENABLED: 'he_retryOnFailEnabled',
  };

  // --- State ---
  let lastClickTime = 0;
  let lastFailureTime = 0;
  let isPaused = true;
  let notifyBox = null;
  let observer = null;
  let pollTimer = null;
  let lastHref = location.href;
  let isProcessing = false;
  let autoResumeEnabled = false;
  let autoResumeSeconds = 7;
  let autoResumeTimer = null;
  let countdownInterval = null;
  let countdownValue = 0;
  let isNotifyBoxVisible = true;
  let retryOnFailEnabled = false;
  let soundEnabled = true;

  // --- Load Settings from localStorage ---
  const loadSettings = () => {
    const savedAutoResumeEnabled = localStorage.getItem(STORAGE_KEYS.AUTO_RESUME_ENABLED);
    if (savedAutoResumeEnabled !== null) { autoResumeEnabled = savedAutoResumeEnabled === 'true'; }
    const savedAutoResumeSeconds = localStorage.getItem(STORAGE_KEYS.AUTO_RESUME_SECONDS);
    if (savedAutoResumeSeconds !== null) {
      const parsedSeconds = parseInt(savedAutoResumeSeconds, 10);
      if (!isNaN(parsedSeconds) && parsedSeconds >= 1 && parsedSeconds <= 3600) { autoResumeSeconds = parsedSeconds; }
    }
    const savedRetryOnFailEnabled = localStorage.getItem(STORAGE_KEYS.RETRY_ON_FAIL_ENABLED);
    if (savedRetryOnFailEnabled !== null) { retryOnFailEnabled = savedRetryOnFailEnabled === 'true'; }
  };

  // --- Save Settings to localStorage ---
  const saveAutoResumeEnabled = (value) => { localStorage.setItem(STORAGE_KEYS.AUTO_RESUME_ENABLED, value.toString()); };
  const saveAutoResumeSeconds = (value) => { localStorage.setItem(STORAGE_KEYS.AUTO_RESUME_SECONDS, value.toString()); };
  const saveRetryOnFailEnabled = (value) => { localStorage.setItem(STORAGE_KEYS.RETRY_ON_FAIL_ENABLED, value.toString()); };

  // --- Promise-based request handling ---
  let currentRequestPromise = null;

  // --- DOM helpers ---
  const isLivePath = (href = location.href) => {
    try {
      const u = new URL(href);
      return u.pathname.replace(/\/+$/, '').endsWith('/live');
    } catch (e) { return false; }
  };

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight &&
           rect.right > 0 && rect.left < window.innerWidth &&
           rect.width > 0 && rect.height > 0;
  };

  // --- Sound ---
  const playSuccessSound = () => {
    if (!soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.12);

      gainNode.gain.setValueAtTime(0.25, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.25);
    } catch (e) {
      // Sound failed silently if needed
    }
  };

  // --- DOM Interaction ---
  const humanMoveTo = async (el) => {
    const rect = el.getBoundingClientRect();
    const startX = window.innerWidth / 2 + (Math.random() * 200 - 100);
    const startY = window.innerHeight / 2 + (Math.random() * 100 - 50);
    const targetX = rect.left + rect.width / 2 + (Math.random() * 6 - 3);
    const targetY = rect.top + rect.height / 2 + (Math.random() * 6 - 3);
    const steps = CONFIG.MOVE_STEPS + Math.floor(Math.random() * 5);
    for (let i = 1; i <= steps; i++) {
      const x = startX + (targetX - startX) * (i / steps) + (Math.random() * 5 - 2.5);
      const y = startY + (targetY - startY) * (i / steps) + (Math.random() * 5 - 2.5);
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(x), clientY: Math.round(y) }));
      await new Promise(r => setTimeout(r, CONFIG.MOVE_STEP_MS + Math.random() * 20));
    }
    for (let j = 0; j < 3; j++) {
      const jitterX = (Math.random() * 4 - 2);
      const jitterY = (Math.random() * 4 - 2);
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(targetX + jitterX), clientY: Math.round(targetY + jitterY) }));
      await new Promise(r => setTimeout(r, (Math.random() * 25 + 15)));
    }
  };

  const humanClick = async (el) => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const rect = el.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2 + (Math.random() * 4 - 2));
    const cy = Math.round(rect.top + rect.height / 2 + (Math.random() * 4 - 2));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
    await new Promise(r => setTimeout(r, CONFIG.CLICK_PRESS_MS + ((Math.random() * (CONFIG.CLICK_JITTER.max - CONFIG.CLICK_JITTER.min)) + CONFIG.CLICK_JITTER.min)));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
    return true;
  };

  const findButtonInNode = (node) => {
    if (node.matches && node.matches('button')) return node;
    return node.querySelector('div.right button.direct-btn');
  };

  // --- NEW: Function to perform click and wait for response ---
  const performClickAndAwaitResponse = async (btnElement) => {
    if (currentRequestPromise) {
      try { currentRequestPromise.reject(new Error('New request initiated.')); } catch (e) {}
    }

    const promise = new Promise((resolve, reject) => {
      currentRequestPromise = { resolve, reject, timestamp: Date.now() };
    });

    await humanClick(btnElement);
    return promise;
  };

  // --- Auto-resume Management ---
  const clearAutoResumeTimer = () => {
    if (autoResumeTimer) clearTimeout(autoResumeTimer);
    if (countdownInterval) clearInterval(countdownInterval);
    autoResumeTimer = null;
    countdownInterval = null;
    countdownValue = 0;
  };

  const startAutoResumeTimer = () => {
    if (!autoResumeEnabled || !isPaused) return;
    clearAutoResumeTimer();
    countdownValue = autoResumeSeconds;

    const updateCountdown = () => {
      updateNotice();
      if (countdownValue <= 0) {
        clearAutoResumeTimer();
        setPauseState(false);
        return;
      }
      countdownValue--;
    };

    countdownInterval = setInterval(updateCountdown, 1000);
    autoResumeTimer = setTimeout(() => {
      clearAutoResumeTimer();
      setPauseState(false);
    }, autoResumeSeconds * 1000);

    updateCountdown();
  };

  // --- UI Controls ---
  const togglePause = () => setPauseState(!isPaused);
  const toggleNotifyBox = () => {
    isNotifyBoxVisible = !isNotifyBoxVisible;
    if (notifyBox) notifyBox.style.display = isNotifyBoxVisible ? 'block' : 'none';
  };
  const toggleSound = () => {
    soundEnabled = !soundEnabled;
    updateNotice();
  };

  const setPauseState = (paused) => {
    if (isPaused === paused) return;
    isPaused = paused;

    if (observer) {
      if (paused) observer.disconnect();
      else {
        const target = document.querySelector('div#trade .results');
        if (target) observer.observe(target, { childList: true, subtree: true });
      }
    }

    if (paused && autoResumeEnabled && !autoResumeTimer) startAutoResumeTimer();
    else if (!paused) clearAutoResumeTimer();

    updateNotice();
  };

  // --- UI ---
  let uiElements = null;

  const updateNotice = () => {
    if (!notifyBox || !uiElements) return;

    const { statusDiv, substatusDiv, pauseBtn, soundBtn, autoResumeCheckbox,
            autoResumeInput, retryOnFailCheckbox, toggleBtn, settingsBtn } = uiElements;

    let stateText = '';
    let stateClass = '';
    let substatusText = '';

    if (isPaused) {
      stateClass = autoResumeEnabled && countdownInterval ? 'PAUSED_AUTO' : 'PAUSED';
      stateText = autoResumeEnabled && countdownInterval
        ? `PAUSE (${countdownValue}s)`
        : 'PAUSE';
    } else {
      stateClass = 'RUNNING';
      stateText = 'RUNNING';
      if (currentRequestPromise) substatusText = 'awaiting response...';
    }

    statusDiv.textContent = stateText;
    statusDiv.setAttribute('data-state', stateClass);
    pauseBtn.innerHTML = `<span>${isPaused ? '▶' : '⏸'}</span>`;
    soundBtn.innerHTML = `<span>${soundEnabled ? '🔊' : '🔇'}</span>`;
    soundBtn.title = soundEnabled ? 'Sound ON' : 'Sound OFF';

    if (substatusDiv) {
      substatusDiv.textContent = substatusText;
      substatusDiv.className = substatusText ? 'he-substatus active' : 'he-substatus';
    }

    if (autoResumeCheckbox) {
      autoResumeCheckbox.checked = autoResumeEnabled;
      autoResumeInput.value = autoResumeSeconds;
      autoResumeInput.disabled = !autoResumeEnabled;
    }
    if (retryOnFailCheckbox) {
      retryOnFailCheckbox.checked = retryOnFailEnabled;
    }
    if (toggleBtn) {
      toggleBtn.innerHTML = `<span>${isNotifyBoxVisible ? '👁️' : '👁️'}</span>`;
      toggleBtn.title = isNotifyBoxVisible ? 'Hide panel (>)' : 'Show panel (>)';
    }
    if (settingsBtn) {
        settingsBtn.title = 'Settings';
    }
  };

  const showNotice = () => {
    if (notifyBox && document.body.contains(notifyBox)) return;

    notifyBox = document.createElement('div');
    notifyBox.style.cssText = `
      position: fixed; top: 60px; right: 400px; z-index: 999999;
      background: rgba(25, 25, 35, 0.95); color: #e0e0e0; padding: 12px;
      border-radius: 10px; font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: left; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(100, 100, 120, 0.3);
      user-select: none; cursor: default;
      border: 1px solid rgba(70, 70, 90, 0.6); backdrop-filter: blur(10px);
      min-width: 280px; max-width: 320px; transition: all 0.3s ease;
    `;

    notifyBox.innerHTML = `
      <div class="he-header" style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px;">
        <div class="he-status-wrapper" style="display:flex;align-items:center;gap:6px;">
          <span id="poe-status" class="he-status-badge" data-state="RUNNING">RUNNING</span>
          <span id="poe-substatus" class="he-substatus"></span>
        </div>
        <div class="he-controls" style="display:flex;gap:3px;">
          <button id="poe-pause" class="he-btn he-btn-icon" title="Pause/Resume (<)" style="height: 24px; width: 24px; padding: 4px; min-width: 24px;">⏸</button>
          <button id="poe-sound" class="he-btn he-btn-icon" title="Sound ON/OFF" style="height: 24px; width: 24px; padding: 4px; min-width: 24px;">🔊</button>
          <button id="poe-settings" class="he-btn he-btn-icon" title="Settings" style="height: 24px; width: 24px; padding: 4px; min-width: 24px;">⚙️</button>
          <button id="poe-toggle" class="he-btn he-btn-icon" title="Hide/Show panel (>)" style="height: 24px; width: 24px; padding: 4px; min-width: 24px;">👁️</button>
        </div>
      </div>
      <div class="he-settings-panel" style="display:none;margin-top:10px;padding-top:8px;border-top:1px solid rgba(80,80,100,0.4);">
        <div class="he-setting-row">
          <label class="he-setting-label">
            <input type="checkbox" id="auto-resume-checkbox"> Auto-resume after
          </label>
          <div style="display:flex;gap:2px;align-items:center;">
            <input type="number" id="auto-resume-input" min="1" max="3600" value="${autoResumeSeconds}" class="he-input-number">
            <span class="he-unit">s</span>
          </div>
        </div>
        <div class="he-setting-row">
          <label class="he-setting-label">
            <input type="checkbox" id="retry-on-fail-checkbox"> Force teleport
          </label>
        </div>
      </div>
    `;

    const styleSheet = document.createElement("style");
    styleSheet.textContent = `
      .he-btn {width: auto; height: auto; display: flex; align-items: center; justify-content: center; background: rgba(80, 80, 100, 0.1); border: 1px solid rgba(100, 100, 120, 0.2); border-radius: 4px; color: #aaa; font-size: 14px; cursor: pointer; transition: all 0.15s ease; font-weight: 600; padding: 4px 6px;}
      .he-btn:hover {background: rgba(100, 100, 120, 0.2); border-color: rgba(130, 130, 150, 0.3); color: #ccc; box-shadow: 0 0 3px rgba(130, 130, 150, 0.2); transform: translateY(-1px);}
      .he-btn:active {background: rgba(70, 70, 90, 0.15); border-color: rgba(90, 90, 110, 0.25); color: #999; transform: scale(0.98); box-shadow: 0 0 1px rgba(90, 90, 110, 0.1);}
      .he-btn.he-btn-icon {}
      .he-btn:not(.he-btn-icon) {font-size: 12px; padding: 5px 10px; min-height: 24px; background: rgba(100, 100, 120, 0.15); border-color: rgba(120, 120, 140, 0.25); color: #b0b0c0;}
      .he-btn:not(.he-btn-icon):hover {background: rgba(120, 120, 140, 0.25); border-color: rgba(150, 150, 170, 0.35); color: #d0d0e0;}
      .he-btn:not(.he-btn-icon):active {background: rgba(90, 90, 110, 0.2); border-color: rgba(110, 110, 130, 0.3); color: #a0a0b0; transform: scale(0.97);}
      .he-status-badge {
        font-weight: 700; font-size: 12px; padding: 5px 10px; border-radius: 25px; min-width: 80px; text-align: center; transition: all 0.3s ease;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1);
      }
      .he-status-badge[data-state="RUNNING"] { background: linear-gradient(145deg, #2a7a2a, #1e5a1e); color: #c0f0c0; border: 1px solid #3a9a3a; }
      .he-status-badge[data-state="PAUSED"] { background: linear-gradient(145deg, #7a5a2a, #5a4a1e); color: #f0d0a0; border: 1px solid #9a7a3a; }
      .he-status-badge[data-state="PAUSED_AUTO"] { background: linear-gradient(145deg, #2a5a7a, #1e4a5a); color: #a0d0f0; border: 1px solid #3a7a9a; }
      .he-status-badge[data-state="RUNNING"]::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: #4cff4c; margin-right: 6px; animation: pulse 1.5s infinite; }
      @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.8); } 100% { opacity: 1; transform: scale(1); } }
      .he-substatus { opacity: 0; transition: opacity 0.3s ease; font-size:10px; color:#888; font-style:italic; }
      .he-substatus.active { opacity: 1; }
      .he-setting-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
      .he-setting-label { display:flex; align-items:center; gap:6px; font-size:12px; color:#ccc; }
      .he-setting-label input[type="checkbox"] { width:14px; height:14px; accent-color:#4a90e2; }
      .he-input-number { width:50px; padding:2px 4px; font-size:12px; background:linear-gradient(145deg, #3a3a4a, #2a2a3a); color:white; border:1px solid #555; border-radius:4px; text-align:center; -moz-appearance: textfield; }
      .he-input-number::-webkit-outer-spin-button,.he-input-number::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .he-input-number:focus { outline:none; border-color:#5ca9ff; box-shadow:0 0 0 2px rgba(92,169,255,0.2); }
      .he-unit { font-size:11px; color:#aaa; }
    `;
    document.head.appendChild(styleSheet);
    document.body.appendChild(notifyBox);

    uiElements = {
      statusDiv: notifyBox.querySelector('#poe-status'),
      substatusDiv: notifyBox.querySelector('#poe-substatus'),
      pauseBtn: notifyBox.querySelector('#poe-pause'),
      soundBtn: notifyBox.querySelector('#poe-sound'),
      settingsBtn: notifyBox.querySelector('#poe-settings'),
      toggleBtn: notifyBox.querySelector('#poe-toggle'),
      settingsPanel: notifyBox.querySelector('.he-settings-panel'),
      autoResumeCheckbox: notifyBox.querySelector('#auto-resume-checkbox'),
      autoResumeInput: notifyBox.querySelector('#auto-resume-input'),
      retryOnFailCheckbox: notifyBox.querySelector('#retry-on-fail-checkbox'),
    };

    const { pauseBtn, soundBtn, settingsBtn, toggleBtn, settingsPanel,
            autoResumeCheckbox, autoResumeInput, retryOnFailCheckbox } = uiElements;

    pauseBtn.onclick = togglePause;
    soundBtn.onclick = toggleSound;
    toggleBtn.onclick = toggleNotifyBox;

    settingsBtn.onclick = () => {
      const isVisible = settingsPanel.style.display !== 'none';
      settingsPanel.style.display = isVisible ? 'none' : 'block';
    };

    autoResumeCheckbox.onchange = (e) => {
        autoResumeEnabled = e.target.checked;
        saveAutoResumeEnabled(autoResumeEnabled);
        updateNotice();
        if (isPaused) {
            if (autoResumeEnabled && !autoResumeTimer) startAutoResumeTimer();
            else clearAutoResumeTimer();
        }
    };

    autoResumeInput.onchange = (e) => {
        let value = parseInt(e.target.value, 10);
        if (isNaN(value) || value < 1) value = 1;
        if (value > 3600) value = 3600;
        e.target.value = value;
        autoResumeSeconds = value;
        saveAutoResumeSeconds(autoResumeSeconds);
        updateNotice();
        if (isPaused && autoResumeEnabled && countdownInterval) startAutoResumeTimer();
    };

    retryOnFailCheckbox.onchange = (e) => {
        retryOnFailEnabled = e.target.checked;
        saveRetryOnFailEnabled(retryOnFailEnabled);
        updateNotice();
    };

    let drag = { active: false, x: 0, y: 0 };
    notifyBox.addEventListener('mousedown', e => {
      if (['BUTTON', 'INPUT', 'LABEL', 'SPAN'].includes(e.target.tagName)) return;
      drag.active = true;
      const rect = notifyBox.getBoundingClientRect();
      drag.x = e.clientX - rect.left;
      drag.y = e.clientY - rect.top;
      notifyBox.style.transition = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!drag.active || !notifyBox) return;
      notifyBox.style.left = (e.clientX - drag.x) + 'px';
      notifyBox.style.top = (e.clientY - drag.y) + 'px';
      notifyBox.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      drag.active = false;
      notifyBox.style.transition = 'all 0.25s ease';
    });

    notifyBox.style.display = isNotifyBoxVisible ? 'block' : 'none';
    setTimeout(updateNotice, 0);
  };

  const hideNotice = () => {
    if (!notifyBox) return;
    clearAutoResumeTimer();
    if (currentRequestPromise) {
      try { currentRequestPromise.reject(new Error('Script stopped/stopped observing.')); } catch (e) {}
      currentRequestPromise = null;
    }
    uiElements = null;
    notifyBox.remove();
    notifyBox = null;
  };

  // --- Network Request Interception ---
  const originalFetch = window.fetch;
  const originalXHR = window.XMLHttpRequest;
  const originalOpen = originalXHR.prototype.open;
  const originalSend = originalXHR.prototype.send;

  window.fetch = function (...args) {
    const url = args[0] instanceof Request ? args[0].url : args[0];
    if (url && url.includes(CONFIG.TARGET_API_URL) && currentRequestPromise) {
      const { resolve, reject, timestamp } = currentRequestPromise;
      currentRequestPromise = null;

      return originalFetch.apply(this, args)
        .then(async (response) => {
          const clonedResponse = response.clone();
          try {
            const responseBody = await clonedResponse.json();
            resolve(responseBody);
            if (responseBody.success === true) {
              playSuccessSound();
              if (!isPaused) setPauseState(true);
            } else {
              lastFailureTime = Date.now();
            }
          } catch (e) {
            resolve({ success: false, error: e.message });
            lastFailureTime = Date.now();
          }
          return response;
        })
        .catch((error) => {
          reject(error);
          lastFailureTime = Date.now();
          return Promise.reject(error);
        });
    }
    return originalFetch.apply(this, args);
  };

  originalXHR.prototype.open = function (method, url) {
    this._poetrade_url = url;
    return originalOpen.apply(this, arguments);
  };

  originalXHR.prototype.send = function (body) {
    const originalOnLoad = this.onload;
    const originalOnError = this.onerror;

    if (this._poetrade_url && this._poetrade_url.includes(CONFIG.TARGET_API_URL) && currentRequestPromise) {
      const { resolve, reject, timestamp } = currentRequestPromise;
      currentRequestPromise = null;

      this.onload = function (...args) {
        try {
          const responseBody = JSON.parse(this.responseText);
          resolve(responseBody);
          if (responseBody.success === true) {
            playSuccessSound();
            if (!isPaused) setPauseState(true);
          } else {
            lastFailureTime = Date.now();
          }
        } catch (e) {
          resolve({ success: false, error: e.message });
          lastFailureTime = Date.now();
        }
        if (originalOnLoad) return originalOnLoad.apply(this, args);
      };

      this.onerror = function (...args) {
        reject(new Error('Network error'));
        lastFailureTime = Date.now();
        if (originalOnError) return originalOnError.apply(this, args);
      };
    }

    return originalSend.apply(this, arguments);
  };

  // --- Main DOM Mutation Handling Logic ---
  const handleMutations = (mutations) => {
    if (isPaused || isProcessing) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const btn = findButtonInNode(node);
        if (!btn) continue;

        const text = btn.textContent.trim();
        if (text === "In Demand" || text === "In demand. Teleport anyway?" || text.includes("Teleporting")) {
             continue;
        }

        const now = Date.now();
        let interval = CONFIG.BASE_INTERVAL + ((Math.random() * (CONFIG.JITTER * 2)) - CONFIG.JITTER);

        if (lastFailureTime > 0) {
          const sinceFail = now - lastFailureTime;
          const quick = (Math.random() * (CONFIG.QUICK_RETRY_MAX - CONFIG.QUICK_RETRY_MIN)) + CONFIG.QUICK_RETRY_MIN;
          if (sinceFail < quick && now - lastClickTime > quick) interval = quick;
        }

        if (now - lastClickTime < interval) continue;

        isProcessing = true;

        (async () => {
          try {
            if (!isVisible(btn)) {
              btn.scrollIntoView({ block: 'center' });
              await new Promise(r => setTimeout(r, (Math.random() * (CONFIG.SCROLL_JITTER.max - CONFIG.SCROLL_JITTER.min)) + CONFIG.SCROLL_JITTER.min));
            }
            await humanMoveTo(btn);
            const first = await performClickAndAwaitResponse(btn);

            if (first.success === true) {
              lastClickTime = Date.now();
            } else {
              lastFailureTime = Date.now();
              if (retryOnFailEnabled) {
                const second = await performClickAndAwaitResponse(btn);
                if (second.success === true) {
                  if (!isPaused) setPauseState(true);
                  lastClickTime = Date.now();
                } else {
                  lastClickTime = Date.now();
                }
              } else {
                lastClickTime = Date.now();
              }
            }
          } catch (e) {
            // Error silently if needed
          } finally {
            isProcessing = false;
          }
        })();
        return;
      }
    }
  };

  // --- Script Lifecycle Management ---
  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        onLocationChange();
      }
    }, 500);
  };

  const stopPolling = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const startScript = async () => {
    if (observer) { observer.disconnect(); observer = null; }
    if (!isLivePath()) return;
    loadSettings();
    showNotice();
    setPauseState(false);
    const target = document.querySelector('div#trade .results');
    if (!target) { hideNotice(); return; }
    observer = new MutationObserver(handleMutations);
    observer.observe(target, { childList: true, subtree: true });
    startPolling();
  };

  const stopScript = () => {
    if (observer) { observer.disconnect(); observer = null; }
    stopPolling();
    hideNotice();
    isPaused = true;
    clearAutoResumeTimer();
    if (currentRequestPromise) {
      try { currentRequestPromise.reject(new Error('Script stopped.')); } catch (e) {}
      currentRequestPromise = null;
    }
  };

  const onLocationChange = () => {
    if (isLivePath()) startScript();
    else stopScript();
  };

  // --- Initialization ---
  (function (history) {
    const push = history.pushState;
    const replace = history.replaceState;
    history.pushState = function () { push.apply(history, arguments); window.dispatchEvent(new Event('locationchange')); };
    history.replaceState = function () { replace.apply(history, arguments); window.dispatchEvent(new Event('locationchange')); };
  })(window.history);

  window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
  window.addEventListener('locationchange', onLocationChange);
  window.addEventListener('keydown', e => {
      if (e.code === 'Comma') togglePause();
      if (e.code === 'Period') toggleNotifyBox();
  });

  if (isLivePath()) startScript();
  else { startPolling(); }

})();
