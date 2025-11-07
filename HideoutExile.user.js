// ==UserScript==
// @name         HideoutExile
// @namespace    https://github.com/HideoutExile/HideoutExile
// @version      1.3.2
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
    BASE_INTERVAL: 100,
    JITTER: 50,
    QUICK_RETRY_MIN: 50,
    QUICK_RETRY_MAX: 100,
    MOVE_STEPS: 6,
    MOVE_STEP_MS: 20,
    CLICK_PRESS_MS: 10,
    CLICK_JITTER: { min: -5, max: 2 },
    SCROLL_JITTER: { min: 120, max: 200 },
    TARGET_API_URL: "/api/trade/whisper",
    DEBUG: false,
  };

  // --- Helpers ---
  const log = CONFIG.DEBUG ? console.log.bind(console, '[HideoutExile]') : () => {};
  const randBetween = (min, max) => Math.random() * (max - min) + min;

  // --- State ---
  let lastClickTime = 0;
  let lastFailureTime = 0;
  let isPaused = true;
  let notifyBox = null;
  let observer = null;
  let pollTimer = null;
  let lastHref = location.href;
  let isProcessing = false; // Flag to prevent parallel processing
  let autoResumeEnabled = false;
  let autoResumeSeconds = 7; // Default 7 seconds (changed from 10)
  let autoResumeTimer = null; // For storing setTimeout ID
  let countdownInterval = null; // For storing setInterval ID for countdown
  let countdownValue = 0; // Current countdown value
  let isNotifyBoxVisible = true; // Notification panel visibility state
  let retryOnFailEnabled = false; // State for the new checkbox
  let soundEnabled = true; // State for sound toggle (always visible now)

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
      log('Sound failed:', e);
    }
  };

  // --- DOM Interaction ---
  const humanMoveTo = async (el) => {
    const rect = el.getBoundingClientRect();
    const startX = window.innerWidth / 2 + randBetween(-100, 100);
    const startY = window.innerHeight / 2 + randBetween(-50, 50);
    const targetX = rect.left + rect.width / 2 + randBetween(-3, 3);
    const targetY = rect.top + rect.height / 2 + randBetween(-3, 3);
    const steps = CONFIG.MOVE_STEPS + Math.floor(randBetween(0, 5));
    for (let i = 1; i <= steps; i++) {
      const x = startX + (targetX - startX) * (i / steps) + randBetween(-2.5, 2.5);
      const y = startY + (targetY - startY) * (i / steps) + randBetween(-2.5, 2.5);
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(x), clientY: Math.round(y) }));
      await new Promise(r => setTimeout(r, CONFIG.MOVE_STEP_MS + Math.random() * 20));
    }
    for (let j = 0; j < 3; j++) {
      const jitterX = randBetween(-2, 2);
      const jitterY = randBetween(-2, 2);
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(targetX + jitterX), clientY: Math.round(targetY + jitterY) }));
      await new Promise(r => setTimeout(r, randBetween(15, 40)));
    }
  };

  const humanClick = async (el) => {
    await new Promise(resolve => requestAnimationFrame(resolve));
    const rect = el.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2 + randBetween(-2, 2));
    const cy = Math.round(rect.top + rect.height / 2 + randBetween(-2, 2));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
    await new Promise(r => setTimeout(r, CONFIG.CLICK_PRESS_MS + randBetween(CONFIG.CLICK_JITTER.min, CONFIG.CLICK_JITTER.max)));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }));
    log('Click performed');
    return true;
  };

  const findButtonInNode = (node) => {
    if (node.matches && node.matches('button')) return node;
    return node.querySelector('div.right button.direct-btn, button[data-id="live-button"]');
  };

  // --- NEW: Function to perform click and wait for response ---
  const performClickAndAwaitResponse = async (btnElement) => {
    if (currentRequestPromise) {
      log('performClickAndAwaitResponse: Clearing previous unresolved promise.');
      try { currentRequestPromise.reject(new Error('New request initiated.')); } catch (e) {}
    }

    const promise = new Promise((resolve, reject) => {
      currentRequestPromise = { resolve, reject, timestamp: Date.now() };
    });

    await humanClick(btnElement);
    log('performClickAndAwaitResponse: Click performed, awaiting response...');
    return promise;
  };

  // --- Auto-resume Management ---
  const clearAutoResumeTimer = () => {
    if (autoResumeTimer) clearTimeout(autoResumeTimer);
    if (countdownInterval) clearInterval(countdownInterval);
    autoResumeTimer = null;
    countdownInterval = null;
    countdownValue = 0;
    log('Auto-resume timer cleared');
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
    log('Sound', soundEnabled ? 'enabled' : 'disabled');
  };

  const setPauseState = (paused) => {
    if (isPaused === paused) return;
    isPaused = paused;
    log('State changed to:', isPaused ? 'PAUSED' : 'RUNNING');

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
  let uiElements = null; // Cache for UI elements after creation

  const updateNotice = () => {
    if (!notifyBox || !uiElements) return;

    const { statusDiv, substatusDiv, pauseBtn, soundBtn, autoResumeCheckbox,
            autoResumeInput, retryOnFailCheckbox, toggleBtn } = uiElements;

    let stateText = '';
    let stateClass = '';
    let substatusText = '';

    if (isPaused) {
      stateClass = autoResumeEnabled && countdownInterval ? 'PAUSED_AUTO' : 'PAUSED';
      stateText = autoResumeEnabled && countdownInterval
        ? `PAUSE (${countdownValue}s)`
        : 'PAUSE'; // TRANSLATED: ПАУЗА -> PAUSE
    } else {
      stateClass = 'RUNNING';
      stateText = 'RUNNING'; // TRANSLATED: РАБОТАЕТ -> RUNNING
      if (currentRequestPromise) substatusText = 'awaiting response...'; // TRANSLATED
    }

    statusDiv.textContent = stateText;
    statusDiv.setAttribute('data-state', stateClass);
    pauseBtn.innerHTML = `<span>${isPaused ? '▶' : '⏸'}</span>`;
    soundBtn.innerHTML = `<span>${soundEnabled ? '🔊' : '🔇'}</span>`;
    soundBtn.title = soundEnabled ? 'Sound ON' : 'Sound OFF'; // TRANSLATED: Звук вкл/выкл -> Sound ON/OFF

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
      toggleBtn.innerHTML = `<span>${isNotifyBoxVisible ? '👁' : '👁‍🗨'}</span>`;
      toggleBtn.title = isNotifyBoxVisible ? 'Hide panel (>)' : 'Show panel (>)'; // TRANSLATED: Скрыть/Показать панель -> Hide/Show panel
    }
  };

  const showNotice = () => {
    if (notifyBox && document.body.contains(notifyBox)) return;

    notifyBox = document.createElement('div');
    notifyBox.style.cssText = `
      position: fixed; top: 30px; right: 20px; z-index: 999999;
      background: rgba(18, 18, 18, 0.85); color: #e0e0e0; padding: 10px;
      border-radius: 8px; font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-align: left; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
      user-select: none; cursor: default;
      border: 1px solid rgba(70, 70, 70, 0.5); backdrop-filter: blur(8px);
      min-width: 260px; max-width: 300px; transition: all 0.25s ease;
    `;

    // HTML for the panel with translated labels and REMOVED help button
    notifyBox.innerHTML = `
      <div class="he-header" style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:4px;">
        <div class="he-status-wrapper" style="display:flex;align-items:center;gap:6px;">
          <span id="poe-status" class="he-status-badge" data-state="RUNNING">RUNNING</span> <!-- TRANSLATED -->
          <span id="poe-substatus" class="he-substatus"></span>
        </div>
        <div class="he-controls" style="display:flex;gap:3px;">
          <button id="poe-pause" class="he-btn he-btn-icon" title="Pause/Resume (<)">⏸</button> <!-- TRANSLATED: title -->
          <button id="poe-sound" class="he-btn he-btn-icon" title="Sound ON/OFF">🔊</button> <!-- TRANSLATED: title -->
          <button id="poe-settings" class="he-btn he-btn-icon" title="Settings">⚙️</button> <!-- TRANSLATED: title -->
          <button id="poe-toggle" class="he-btn he-btn-icon" title="Hide/Show panel (>)">👁</button> <!-- TRANSLATED: title -->
        </div>
      </div>
      <div class="he-settings-panel" style="display:none;margin-top:10px;padding-top:8px;border-top:1px solid rgba(70,70,70,0.4);">
        <div class="he-setting-row">
          <label class="he-setting-label">
            <input type="checkbox" id="auto-resume-checkbox"> Auto-resume after <!-- TRANSLATED: Автостарт через -> Auto-resume after -->
          </label>
          <div style="display:flex;gap:2px;align-items:center;">
            <input type="number" id="auto-resume-input" min="1" max="3600" value="${autoResumeSeconds}" class="he-input-number">
            <span class="he-unit">s</span>
          </div>
        </div>
        <div class="he-setting-row">
          <label class="he-setting-label">
            <input type="checkbox" id="retry-on-fail-checkbox"> Force teleport <!-- TRANSLATED: Повтор при ошибке -> Force teleport -->
          </label>
        </div>
      </div>
    `;

    const styleSheet = document.createElement("style");
    styleSheet.textContent = `
      .he-btn { width: 26px; height: 26px; display: flex; align-items: center;
        justify-content: center; background: rgba(40,40,40,0.7);
        border: 1px solid rgba(80,80,80,0.6); border-radius: 4px; color: #ccc;
        font-size: 13px; cursor: pointer; transition: all 0.2s ease; }
      .he-btn:hover { background: rgba(60,60,60,0.9); border-color: rgba(100,100,100,0.8); }
      .he-btn:active { transform: scale(0.95); background: rgba(30,30,30,0.9); }
      .he-status-badge {
        font-weight: 600; font-size: 12px; padding: 4px 8px; border-radius: 20px;
        min-width: 80px; text-align: center; transition: all 0.3s ease;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05);
      }
      .he-status-badge[data-state="RUNNING"] { background: rgba(40,120,40,0.2); color: #6cff6c; border: 1px solid rgba(70,180,70,0.3); }
      .he-status-badge[data-state="PAUSED"] { background: rgba(140,80,30,0.2); color: #ffb347; border: 1px solid rgba(200,120,60,0.4); }
      .he-status-badge[data-state="PAUSED_AUTO"] { background: rgba(40,70,140,0.25); color: #6aa8ff; border: 1px solid rgba(80,130,220,0.4); }
      .he-substatus { opacity: 0; transition: opacity 0.3s ease; font-size:10px; color:#888; font-style:italic; }
      .he-substatus.active { opacity: 1; }
      .he-setting-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
      .he-setting-label { display:flex; align-items:center; gap:6px; font-size:12px; color:#ccc; }
      .he-setting-label input[type="checkbox"] { width:14px; height:14px; accent-color:#4a90e2; }
      .he-input-number { width:50px; padding:2px 4px; font-size:12px; background:rgba(30,30,30,0.8);
        color:#e0e0e0; border:1px solid rgba(70,70,70,0.6); border-radius:4px; text-align:center; }
      .he-input-number:focus { outline:none; border-color:#5ca9ff; box-shadow:0 0 0 2px rgba(92,169,255,0.2); }
      .he-unit { font-size:11px; color:#aaa; }
    `;
    document.head.appendChild(styleSheet);
    document.body.appendChild(notifyBox);

    // Cache UI elements once after creation
    uiElements = {
      statusDiv: notifyBox.querySelector('#poe-status'),
      substatusDiv: notifyBox.querySelector('#poe-substatus'),
      pauseBtn: notifyBox.querySelector('#poe-pause'),
      soundBtn: notifyBox.querySelector('#poe-sound'),
      settingsBtn: notifyBox.querySelector('#poe-settings'),
      // helpBtn: notifyBox.querySelector('#poe-help'), // REMOVED
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

    // Handler for the settings button
    settingsBtn.onclick = () => {
      const isVisible = settingsPanel.style.display !== 'none';
      settingsPanel.style.display = isVisible ? 'none' : 'block';
    };

    autoResumeCheckbox.onchange = (e) => {
        autoResumeEnabled = e.target.checked;
        updateNotice(); // Update UI immediately
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
        updateNotice(); // Update UI immediately
        // Restart timer only if script is paused, auto-resume is enabled, and timer was running
        if (isPaused && autoResumeEnabled && countdownInterval) startAutoResumeTimer();
    };

    retryOnFailCheckbox.onchange = (e) => {
        retryOnFailEnabled = e.target.checked;
        log('Force teleport option changed to:', retryOnFailEnabled);
        updateNotice(); // Update UI to reflect the state visually if needed
    };

    // Drag
    let drag = { active: false, x: 0, y: 0 };
    notifyBox.addEventListener('mousedown', e => {
      if (['BUTTON', 'INPUT', 'LABEL'].includes(e.target.tagName)) return; // Don't drag if clicking on control element
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
    setTimeout(updateNotice, 0); // Ensures DOM is ready
    log('UI shown');
  };

  const hideNotice = () => {
    if (!notifyBox) return;
    clearAutoResumeTimer(); // Clear timer when hiding
    if (currentRequestPromise) {
      try { currentRequestPromise.reject(new Error('Script stopped/stopped observing.')); } catch (e) {}
      currentRequestPromise = null;
    }
    uiElements = null; // Clear UI cache when hiding
    notifyBox.remove();
    notifyBox = null;
    log('UI hidden');
  };

  // --- Network Request Interception ---
  const originalFetch = window.fetch;
  const originalXHR = window.XMLHttpRequest;
  const originalOpen = originalXHR.prototype.open;
  const originalSend = originalXHR.prototype.send;

  window.fetch = function (...args) {
    const url = args[0] instanceof Request ? args[0].url : args[0];
    if (url && url.includes(CONFIG.TARGET_API_URL) && currentRequestPromise) {
      log('fetch: Detected request to /api/trade/whisper, resolving pending promise.');
      const { resolve, reject, timestamp } = currentRequestPromise;
      currentRequestPromise = null;

      return originalFetch.apply(this, args)
        .then(async (response) => {
          const clonedResponse = response.clone();
          try {
            const responseBody = await clonedResponse.json();
            log('Response from /api/trade/whisper:', responseBody);
            resolve(responseBody);
            if (responseBody.success === true) {
              playSuccessSound();
              if (!isPaused) setPauseState(true);
            } else {
              lastFailureTime = Date.now();
            }
          } catch (e) {
            log('Error parsing response from /api/trade/whisper:', e);
            resolve({ success: false, error: e.message });
            lastFailureTime = Date.now();
          }
          return response;
        })
        .catch((error) => {
          log('Error fetching /api/trade/whisper:', error);
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
      log('XHR: Detected request to /api/trade/whisper, resolving pending promise.');
      const { resolve, reject, timestamp } = currentRequestPromise;
      currentRequestPromise = null;

      this.onload = function (...args) {
        try {
          const responseBody = JSON.parse(this.responseText);
          log('XHR Response from /api/trade/whisper:', responseBody);
          resolve(responseBody);
          if (responseBody.success === true) {
            playSuccessSound();
            if (!isPaused) setPauseState(true);
          } else {
            lastFailureTime = Date.now();
          }
        } catch (e) {
          log('XHR Error parsing response from /api/trade/whisper:', e, this.responseText);
          resolve({ success: false, error: e.message });
          lastFailureTime = Date.now();
        }
        if (originalOnLoad) return originalOnLoad.apply(this, args);
      };

      this.onerror = function (...args) {
        log('XHR Network error -> Rejecting pending promise.');
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
        let interval = CONFIG.BASE_INTERVAL + randBetween(-CONFIG.JITTER, CONFIG.JITTER);

        if (lastFailureTime > 0) {
          const sinceFail = now - lastFailureTime;
          const quick = randBetween(CONFIG.QUICK_RETRY_MIN, CONFIG.QUICK_RETRY_MAX);
          if (sinceFail < quick && now - lastClickTime > quick) interval = quick;
        }

        if (now - lastClickTime < interval) continue;

        isProcessing = true;

        (async () => {
          try {
            if (!isVisible(btn)) {
              btn.scrollIntoView({ block: 'center' });
              await new Promise(r => setTimeout(r, randBetween(CONFIG.SCROLL_JITTER.min, CONFIG.SCROLL_JITTER.max)));
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
            console.error('[HideoutExile] async handler error', e);
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
    showNotice();
    setPauseState(false); // When starting, unpause, auto-resume is not started
    const target = document.querySelector('div#trade .results');
    if (!target) { hideNotice(); return; }
    observer = new MutationObserver(handleMutations);
    observer.observe(target, { childList: true, subtree: true });
    startPolling();
    log('Script started');
  };

  const stopScript = () => {
    if (observer) { observer.disconnect(); observer = null; log('Observer disconnected'); }
    stopPolling();
    hideNotice();
    isPaused = true; // Set flag to true when stopping
    clearAutoResumeTimer();
    if (currentRequestPromise) {
      try { currentRequestPromise.reject(new Error('Script stopped.')); } catch (e) {}
      currentRequestPromise = null;
    }
    log('Script stopped');
  };

  const onLocationChange = () => {
    log('URL changed, /live?', isLivePath(), location.href);
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
      if (e.code === 'Comma') togglePause(); // < key
      if (e.code === 'Period') toggleNotifyBox(); // > key
  });

  // initial
  if (isLivePath()) startScript();
  else { startPolling(); log('Script ready, waiting for /live'); }

})();
