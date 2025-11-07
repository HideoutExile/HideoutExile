// ==UserScript==
// @name         HideoutExile
// @namespace    https://github.com/HideoutExile/HideoutExile
// @version      1.3.1
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
    BASE_INTERVAL: 100, // Base interval between clicks (ms)
    JITTER: 50,        // Randomization of base interval (ms)
    QUICK_RETRY_MIN: 50, // Minimum wait time after failure (ms)
    QUICK_RETRY_MAX: 100, // Maximum wait time after failure (ms)
    MOVE_STEPS: 6,
    MOVE_STEP_MS: 20,
    CLICK_PRESS_MS: 10, // Base click hold delay (ms)
    CLICK_JITTER: { min: -5, max: 2 }, // Click delay randomization
    SCROLL_JITTER: { min: 120, max: 200 }, // Scroll delay randomization
    TARGET_API_URL: "/api/trade/whisper", // Target URL for interception
    DEBUG: false, // Enable/disable logging
  };

  // --- Helper Functions ---
  const log = CONFIG.DEBUG ? console.log.bind(console, '[HideoutExile]') : () => {};
  const randBetween = (min, max) => Math.random() * (max - min) + min;

  // --- States ---
  let lastClickTime = 0;
  let lastFailureTime = 0;
  let isPaused = true;
  let notifyBox = null;
  let observer = null;
  let pollTimer = null;
  let lastHref = location.href;
  let isProcessing = false; // Flag to prevent parallel processing
  let autoResumeEnabled = false;
  let autoResumeSeconds = 10; // Default 10 seconds
  let autoResumeTimer = null; // For storing setTimeout ID
  let countdownInterval = null; // For storing setInterval ID for countdown
  let countdownValue = 0; // Current countdown value
  let isNotifyBoxVisible = true; // Notification panel visibility state
  let retryOnFailEnabled = false; // State for the new checkbox
  let currentRequestPromise = null; // Stores the resolver for the currently pending request

  // --- DOM Helper Functions ---
  const isLivePath = (href = location.href) => {
    try {
      const u = new URL(href);
      return u.pathname.replace(/\/+$/, '').endsWith('/live');
    } catch (e) { return false; }
  };

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth && rect.width > 0 && rect.height > 0;
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
    // Reject any previous pending promise gracefully
    if (currentRequestPromise) {
        log('performClickAndAwaitResponse: Clearing previous unresolved promise.');
        try { currentRequestPromise.reject(new Error('New request initiated.')); } catch (e) {}
    }

    // Create a new promise and store its resolvers
    const promise = new Promise((resolve, reject) => {
        currentRequestPromise = { resolve, reject, timestamp: Date.now() };
    });

    await humanClick(btnElement);
    log('performClickAndAwaitResponse: Click performed, awaiting response...');
    return promise;
  };

  // --- Auto-resume Management ---
  const clearAutoResumeTimer = () => {
    if (autoResumeTimer) {
      clearTimeout(autoResumeTimer);
      autoResumeTimer = null;
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    countdownValue = 0;
    log('Auto-resume timer cleared');
  };

  const startAutoResumeTimer = () => {
    if (!autoResumeEnabled || !isPaused) return;
    clearAutoResumeTimer();
    countdownValue = autoResumeSeconds;
    log('Auto-resume timer started for', countdownValue, 'seconds');

    const updateCountdown = () => {
      log('Auto-resume countdown: ', countdownValue);
      updateNotice();
      if (countdownValue <= 0) {
        log('Auto-resume timer expired, unpausing');
        clearAutoResumeTimer();
        setPauseState(false);
        return;
      }
      countdownValue--;
    };

    countdownInterval = setInterval(updateCountdown, 1000);
    autoResumeTimer = setTimeout(() => {
      log('Auto-resume timer expired (setTimeout), unpausing');
      clearAutoResumeTimer();
      setPauseState(false);
    }, autoResumeSeconds * 1000);

    updateCountdown(); // Initial update
  };

  const togglePause = () => setPauseState(!isPaused);

  const toggleNotifyBox = () => {
      isNotifyBoxVisible = !isNotifyBoxVisible;
      log('Notification panel visibility changed to:', isNotifyBoxVisible);
      if (notifyBox) notifyBox.style.display = isNotifyBoxVisible ? 'block' : 'none';
  };

  const setPauseState = (paused) => {
    if (isPaused === paused) return;
    isPaused = paused;
    log('State changed to:', isPaused ? 'PAUSED' : 'RUNNING');

    if (observer) {
      if (paused) {
        try { observer.disconnect(); log('Observer disconnected'); } catch (e) {}
      } else {
        const target = document.querySelector('div#trade .results');
        if (target) {
          observer.observe(target, { childList: true, subtree: true });
          log('Observer enabled');
        }
      }
    }

    if (paused && autoResumeEnabled && !autoResumeTimer) {
        log('setPauseState: Starting auto-resume timer');
        startAutoResumeTimer();
    } else if (!paused) {
        log('setPauseState: Clearing auto-resume timer');
        clearAutoResumeTimer();
    }
    updateNotice();
  };

  // --- UI ---
  const updateNotice = () => {
    if (!notifyBox) return;
    const statusDiv = notifyBox.querySelector('#poe-status');
    const pauseBtn = notifyBox.querySelector('#poe-pause');
    const autoResumeCheckbox = notifyBox.querySelector('#auto-resume-checkbox');
    const autoResumeInput = notifyBox.querySelector('#auto-resume-input');
    const toggleBtn = notifyBox.querySelector('#poe-toggle');
    const retryOnFailCheckbox = notifyBox.querySelector('#retry-on-fail-checkbox'); // Get the new checkbox element

    const state = isPaused ? 'PAUSED' : 'RUNNING';
    const color = isPaused ? '#ffa500' : '#4cff4c';
    pauseBtn.textContent = isPaused ? '▶' : '⏸';
    pauseBtn.title = isPaused ? 'Resume (<)' : 'Pause (<)';

    let statusText = `${state}`;
    if (isPaused && autoResumeEnabled && countdownInterval) statusText += ` ${countdownValue}s`;
    statusDiv.innerHTML = `<div style="color:${color}; font-weight:bold; font-size: 14px;">${statusText}</div>`;

    autoResumeCheckbox.checked = autoResumeEnabled;
    autoResumeInput.value = autoResumeSeconds;
    autoResumeInput.disabled = !autoResumeEnabled;

    // NEW: Update the new checkbox state
    if (retryOnFailCheckbox) retryOnFailCheckbox.checked = retryOnFailEnabled;

    if (toggleBtn) {
        toggleBtn.textContent = isNotifyBoxVisible ? '👁' : '👁‍🗨';
        toggleBtn.title = isNotifyBoxVisible ? 'Hide panel (>)' : 'Show panel (>)';
    }
  };

  const showNotice = () => {
    if (notifyBox && document.body.contains(notifyBox)) return;
    notifyBox = document.createElement('div');
    notifyBox.style.cssText = `
      position: fixed; top: 30px; left: calc(100% - 500px); z-index: 999999;
      background: rgba(30, 30, 30, 0.95); color: #e0e0e0; padding: 8px 12px; border-radius: 6px;
      font-size: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      text-align: center; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); user-select: none; cursor: move; border: 1px solid #444; backdrop-filter: blur(4px);
    `;
    notifyBox.innerHTML = `
      <div id="poe-status" style="margin-bottom: 4px;"></div>
      <div style="display:flex; align-items: center; gap: 6px; justify-content: center; flex-wrap: nowrap;">
        <input type="checkbox" id="auto-resume-checkbox" title="Enable auto-resume" style="width: 14px; height: 14px; cursor: pointer;">
        <label for="auto-resume-checkbox" style="font-size: 11px; margin: 0; cursor: pointer;">Auto:</label>
        <input type="number" id="auto-resume-input" min="1" max="3600" value="${autoResumeSeconds}" style="width: 40px; padding: 2px 4px; font-size: 11px; background-color: #444; color: white; border: 1px solid #666; border-radius: 4px; text-align: center;" title="Time until auto-resume (sec)">
        <span style="font-size: 11px;">s</span>
        <button id="poe-pause" title="Pause/Resume (<)" style="padding: 4px 8px; font-size: 14px;">⏸</button>
        <button id="poe-toggle" title="Hide panel (>)" style="padding: 4px 8px; font-size: 14px;">👁</button>
        <input type="checkbox" id="retry-on-fail-checkbox" title="Retry clicking if the first attempt fails (success: false)" style="width: 14px; height: 14px; cursor: pointer;">
        <label for="retry-on-fail-checkbox" style="font-size: 11px; margin: 0; cursor: pointer;">Retry:</label>
      </div>
    `;
    document.body.appendChild(notifyBox);

    const pauseBtn = notifyBox.querySelector('#poe-pause');
    pauseBtn.style.cssText += `background:#333; color:#e0e0e0; border:1px solid #555; border-radius:4px; width:30px; height:26px; cursor:pointer; font-size:14px;`;
    pauseBtn.onmouseenter = () => pauseBtn.style.background = '#404040';
    pauseBtn.onmouseleave = () => pauseBtn.style.background = '#333';
    pauseBtn.onclick = togglePause;

    const toggleBtn = notifyBox.querySelector('#poe-toggle');
    toggleBtn.style.cssText += `background:#333; color:#e0e0e0; border:1px solid #555; border-radius:4px; width:30px; height:26px; cursor:pointer; font-size:14px;`;
    toggleBtn.onmouseenter = () => toggleBtn.style.background = '#404040';
    toggleBtn.onmouseleave = () => toggleBtn.style.background = '#333';
    toggleBtn.onclick = toggleNotifyBox;

    const autoResumeCheckbox = notifyBox.querySelector('#auto-resume-checkbox');
    const autoResumeInput = notifyBox.querySelector('#auto-resume-input');
    const retryOnFailCheckbox = notifyBox.querySelector('#retry-on-fail-checkbox');

    autoResumeCheckbox.onchange = (e) => {
        autoResumeEnabled = e.target.checked;
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
        updateNotice();
        if (isPaused && autoResumeEnabled && countdownInterval) startAutoResumeTimer();
    };

    // NEW: Handle the new checkbox change
    retryOnFailCheckbox.onchange = (e) => {
        retryOnFailEnabled = e.target.checked;
        log('Retry on fail option changed to:', retryOnFailEnabled);
        updateNotice();
    };

    let drag = { active: false, offsetX: 0, offsetY: 0 };
    notifyBox.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
      drag.active = true;
      drag.offsetX = e.clientX - notifyBox.getBoundingClientRect().left;
      drag.offsetY = e.clientY - notifyBox.getBoundingClientRect().top;
    });
    document.addEventListener('mousemove', e => {
      if (!drag.active || !notifyBox) return;
      notifyBox.style.left = (e.clientX - drag.offsetX) + 'px';
      notifyBox.style.top = (e.clientY - drag.offsetY) + 'px';
      notifyBox.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => drag.active = false);

    notifyBox.style.display = isNotifyBoxVisible ? 'block' : 'none';
    updateNotice();
    log('Notification shown');
  };

  const hideNotice = () => {
    if (!notifyBox) return;
    clearAutoResumeTimer();
    if (currentRequestPromise) { // NEW: Clear pending promise on hide/stop
        try { currentRequestPromise.reject(new Error('Script stopped.')); } catch (e) {}
        currentRequestPromise = null;
    }
    notifyBox.remove();
    notifyBox = null;
    log('Notification hidden');
  };

  // --- Network Request Interception ---
  const originalFetch = window.fetch;
  const originalXHR = window.XMLHttpRequest;
  const originalOpen = originalXHR.prototype.open;
  const originalSend = originalXHR.prototype.send;

  window.fetch = function (...args) {
    const url = args[0] instanceof Request ? args[0].url : args[0];
    if (url && url.includes(CONFIG.TARGET_API_URL) && currentRequestPromise) { // NEW: Only process if promise exists
      log('fetch: Detected request to /api/trade/whisper, resolving pending promise.');
      const { resolve, reject, timestamp } = currentRequestPromise;
      currentRequestPromise = null; // Clear immediately

      return originalFetch.apply(this, args)
        .then(async (response) => {
          const clonedResponse = response.clone();
          try {
            const responseBody = await clonedResponse.json();
            log('Response from /api/trade/whisper:', responseBody);
            resolve(responseBody);
            if (responseBody.success === true) {
              log('Successful response -> Pausing');
              if (!isPaused) setPauseState(true);
            } else {
              log('Unsuccessful response -> Updating lastFailureTime');
              lastFailureTime = Date.now();
            }
          } catch (e) {
            log('Error parsing response:', e);
            resolve({ success: false, error: e.message });
            lastFailureTime = Date.now();
          }
          return response;
        })
        .catch((error) => {
          log('Error fetching:', error);
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
    const originalOnReadyStateChange = this.onreadystatechange;

    if (this._poetrade_url && this._poetrade_url.includes(CONFIG.TARGET_API_URL) && currentRequestPromise) { // NEW: Only process if promise exists
      log('XHR: Detected request to /api/trade/whisper, resolving pending promise.');
      const { resolve, reject, timestamp } = currentRequestPromise;
      currentRequestPromise = null; // Clear immediately

      this.onload = function (...args) {
        try {
          const responseBody = JSON.parse(this.responseText);
          log('XHR Response:', responseBody);
          resolve(responseBody);
          if (responseBody.success === true) {
            log('XHR Success -> Pausing');
            if (!isPaused) setPauseState(true);
          } else {
            log('XHR Failure -> Updating lastFailureTime');
            lastFailureTime = Date.now();
          }
        } catch (e) {
          log('XHR Parse Error:', e, this.responseText);
          resolve({ success: false, error: e.message });
          lastFailureTime = Date.now();
        }
        if (originalOnLoad) return originalOnLoad.apply(this, args);
      };

      this.onerror = function (...args) {
        log('XHR Network Error -> Rejecting promise');
        reject(new Error('Network error'));
        lastFailureTime = Date.now();
        if (originalOnError) return originalOnError.apply(this, args);
      };

      this.onreadystatechange = function (...args) {
        if (this.readyState === 4 && currentRequestPromise) { // Should not happen if cleared above
            log('XHR: WARNING - ReadyState 4 fired but promise still existed.');
        }
        if (originalOnReadyStateChange) return originalOnReadyStateChange.apply(this, args);
      };
    } else if (this._poetrade_url && this._poetrade_url.includes(CONFIG.TARGET_API_URL)) {
        log('XHR: WARNING - No pending promise found for request.');
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

        const buttonText = btn.textContent.trim();
        if (buttonText === "In Demand" || buttonText === "In demand. Teleport anyway?" || buttonText.includes("Teleporting")) {
             log('Button already taken, skipping:', buttonText);
             continue;
        }

        const now = Date.now();
        let intervalToCheck = CONFIG.BASE_INTERVAL + randBetween(-CONFIG.JITTER, CONFIG.JITTER);

        if (lastFailureTime > 0) {
          const timeSinceFailure = now - lastFailureTime;
          const quickRetryInterval = randBetween(CONFIG.QUICK_RETRY_MIN, CONFIG.QUICK_RETRY_MAX);
          if (timeSinceFailure < quickRetryInterval && now - lastClickTime > quickRetryInterval) {
            intervalToCheck = quickRetryInterval;
            log('Recent failure. Using short interval:', intervalToCheck);
          }
        }

        if (now - lastClickTime < intervalToCheck) {
            log('Interval not passed. now:', now, 'lastClickTime:', lastClickTime, 'intervalToCheck:', intervalToCheck, 'diff:', now - lastClickTime);
            continue;
        }

        isProcessing = true;
        log('Starting button processing');

        (async () => {
          try {
            if (!isVisible(btn)) {
                btn.scrollIntoView({ block: 'center' });
                await new Promise(r => setTimeout(r, randBetween(CONFIG.SCROLL_JITTER.min, CONFIG.SCROLL_JITTER.max)));
            }
            await humanMoveTo(btn);
            const firstResponse = await performClickAndAwaitResponse(btn);
            log('Received response from first request:', firstResponse);

            if (firstResponse.success === true) {
                log('First request was successful.');
                lastClickTime = Date.now();
            } else {
                log('First request failed with response:', firstResponse);
                lastFailureTime = Date.now();

                if (retryOnFailEnabled) {
                    log('Retry on fail is enabled. Attempting retry...');
                    const secondResponse = await performClickAndAwaitResponse(btn);
                    log('Received response from retry request:', secondResponse);

                    if (secondResponse.success === true) {
                        log('Retry request was successful.');
                        if (!isPaused) setPauseState(true);
                        lastClickTime = Date.now();
                    } else {
                        log('Retry request also failed:', secondResponse);
                        lastFailureTime = Date.now();
                        lastClickTime = Date.now();
                    }
                } else {
                    log('Retry on fail is disabled. Not retrying.');
                    lastClickTime = Date.now();
                }
            }
          } catch (e) { console.error('[HideoutExile] async handler error', e); }
          isProcessing = false;
        })();
        return; // Process only the first valid button
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
    setPauseState(false);
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
    isPaused = true;
    clearAutoResumeTimer();
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
