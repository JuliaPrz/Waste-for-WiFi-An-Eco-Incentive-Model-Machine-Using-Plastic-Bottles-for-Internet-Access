const BOTTLE_TIMER_DURATION = 180; // seconds (3 minutes)
const SECONDS_PER_BOTTLE = 120; // seconds earned per bottle

import { $ } from './ui.js';
import { closeModal } from './dom.js';

let bottleTimerInterval = null;
let bottleTimeRemaining = BOTTLE_TIMER_DURATION;
let bottleCount = 0;
let currentSessionId = null;

// session countdown (exported for sessionManager.js)
let sessionTimerInterval = null;

export function startBottleTimer(sessionId = null) {
  currentSessionId = sessionId || currentSessionId || null;
  bottleTimeRemaining = BOTTLE_TIMER_DURATION;
  bottleCount = 0;

  const progressBar = $('bottle-progress');
  const countdownEl = $('bottle-countdown');
  const bottleCountEl = $('bottle-count');
  const timeEarnedEl = $('time-earned');
  const doneBtn = $('btn-done-insert');
  const helper = $('insert-helper');

  if (bottleCountEl) bottleCountEl.textContent = '0';
  if (timeEarnedEl) timeEarnedEl.textContent = '0 minutes';
  if (countdownEl) countdownEl.textContent = formatSeconds(bottleTimeRemaining);
  if (progressBar) progressBar.style.width = '100%';
  if (helper) helper.style.display = 'block';
  if (doneBtn) {
    doneBtn.disabled = true;
    doneBtn.classList.add('disabled');
  }

  if (bottleTimerInterval) {
    clearInterval(bottleTimerInterval);
    bottleTimerInterval = null;
  }

  bottleTimerInterval = setInterval(() => {
    bottleTimeRemaining -= 1;
    if (countdownEl) countdownEl.textContent = formatSeconds(bottleTimeRemaining);
    if (progressBar) progressBar.style.width = `${Math.max(0, Math.round((bottleTimeRemaining / BOTTLE_TIMER_DURATION) * 100))}%`;

    if (bottleTimeRemaining <= 0) {
      clearInterval(bottleTimerInterval);
      bottleTimerInterval = null;
      handleTimerEnd();
    }
  }, 1000);

  // Attach Done button handler (idempotent)
  if (doneBtn) {
    doneBtn.onclick = () => {
      stopBottleTimer();
    };
  }
}

export function stopBottleTimer() {
  if (bottleTimerInterval) {
    clearInterval(bottleTimerInterval);
    bottleTimerInterval = null;
  }
  handleTimerEnd();
}

function handleTimerEnd() {
  try { closeModal('modal-insert-bottle'); } catch (e) {}
  const secondsEarned = bottleCount * SECONDS_PER_BOTTLE;
  // emit an event other modules listen to
  window.dispatchEvent(new CustomEvent('bottles-committed', {
    detail: { session_id: currentSessionId, bottles: bottleCount, seconds: secondsEarned }
  }));
  // reset local counters
  bottleCount = 0;
  bottleTimeRemaining = BOTTLE_TIMER_DURATION;

  // update UI (safely)
  const progressBar = $('bottle-progress');
  const countdownEl = $('bottle-countdown');
  const bottleCountEl = $('bottle-count');
  const timeEarnedEl = $('time-earned');
  const doneBtn = $('btn-done-insert');
  const helper = $('insert-helper');
  if (bottleCountEl) bottleCountEl.textContent = '0';
  if (timeEarnedEl) timeEarnedEl.textContent = '0 minutes';
  if (countdownEl) countdownEl.textContent = formatSeconds(bottleTimeRemaining);
  if (progressBar) progressBar.style.width = '100%';
  if (helper) helper.style.display = 'block';
  if (doneBtn) { doneBtn.disabled = true; doneBtn.classList.add('disabled'); }
}

export function registerBottle() {
  bottleCount += 1;
  const bottleCountEl = $('bottle-count');
  const timeEarnedEl = $('time-earned');
  const doneBtn = $('btn-done-insert');
  const helper = $('insert-helper');

  if (bottleCountEl) bottleCountEl.textContent = String(bottleCount);
  if (timeEarnedEl) timeEarnedEl.textContent = `${Math.floor((bottleCount * SECONDS_PER_BOTTLE) / 60)} minutes`;
  if (helper) helper.style.display = 'none';
  if (doneBtn) { doneBtn.disabled = false; doneBtn.classList.remove('disabled'); }

  // notify others (optional)
  window.dispatchEvent(new CustomEvent('bottle-registered', {
    detail: { session_id: currentSessionId, bottles: bottleCount, seconds: bottleCount * SECONDS_PER_BOTTLE }
  }));
}

function formatSeconds(sec) {
  if (sec <= 0) return '0 min 00 sec';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m} min. ${String(s).padStart(2, '0')} sec.`;
}

export function getBottleCount() { return bottleCount; }
export function getCurrentSessionId() { return currentSessionId; }

export function startSessionCountdown(sessionData, onExpire) {
  const timerCard = document.getElementById('timer-card');
  const timerEl = document.getElementById('timer');
  if (!timerCard || !timerEl || !sessionData) return;

  // hide if not active
  const now = Math.floor(Date.now() / 1000);
  if (sessionData.status !== 'active' || !sessionData.session_end || sessionData.session_end <= now) {
    timerCard.classList.remove('active');
    timerCard.style.display = 'none';
    if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
    return;
  }

  timerCard.classList.add('active');
  timerCard.style.display = 'block';

  let remaining = sessionData.session_end - now;
  timerEl.textContent = formatSeconds(remaining);

  if (sessionTimerInterval) clearInterval(sessionTimerInterval);

  sessionTimerInterval = setInterval(async () => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
      timerEl.textContent = 'Expired';
      if (typeof onExpire === 'function') {
        try { await onExpire(); } catch (e) { console.error('onExpire callback error', e); }
      }
      timerCard.classList.remove('active');
      timerCard.style.display = 'none';
    } else {
      timerEl.textContent = formatSeconds(remaining);
    }
  }, 1000);
}

export function stopSessionCountdown() {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
  const timerCard = document.getElementById('timer-card');
  const timerEl = document.getElementById('timer');
  if (timerCard) { timerCard.classList.remove('active'); timerCard.style.display = 'none'; }
  if (timerEl) timerEl.textContent = '';
}