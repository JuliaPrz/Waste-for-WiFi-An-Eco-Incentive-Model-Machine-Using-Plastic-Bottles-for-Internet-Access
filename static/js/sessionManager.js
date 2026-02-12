import { $, showToast } from './dom.js';
import { formatTime, getCurrentTimestamp } from './utils.js';
import { lookupSession as apiLookupSession, acquireInsertionLock, unlockInsertion, postBottles, activateSession as apiActivateSession } from './api/sessionApi.js';
import { updateButtonStates, updateConnectionStatus } from './ui.js';
import { startSessionCountdown, stopSessionCountdown } from './timer.js';

let currentSessionId = null;
let pendingSessionData = null;
let bottleCount = 0;
let isCommitting = false;

export function getCurrentSessionId() { return currentSessionId; }

export function setCurrentSessionId(id) {
  currentSessionId = id ? String(id) : null;
  if (id) {
    localStorage.setItem('session_id', id);
    // ensure global used by mock/dev tools is kept in sync
    window.mockSessionId = String(id);
  } else {
    localStorage.removeItem('session_id');
    window.mockSessionId = null;
  }
}

export async function createSession(mac_address = null, ip_address = null) {
  const payload = {};
  if (mac_address) payload.mac_address = mac_address;
  if (ip_address) payload.ip_address = ip_address;

  try {
    console.log('createSession: requesting insertion lock...');
    const res = await acquireInsertionLock(payload);

    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      const msg = body.message || body.error || 'Machine is currently busy';
      showToast(msg, 'error', 8000);
      console.warn('createSession: lock denied:', msg);
      throw new Error(msg);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error('createSession: lock request failed', body);
      throw new Error('Failed to acquire insertion lock');
    }

    const info = await res.json().catch(() => ({}));
    // set client state to inserting and record server session id if returned
    pendingSessionData = {
      id: info.session_id || info.id || null,
      status: 'inserting',
      bottles_inserted: 0,
      session_start: null,
      session_end: null,
      owner: info.owner || window.location.hostname
    };
    if (pendingSessionData.id) setCurrentSessionId(pendingSessionData.id);

    console.log('createSession: insertion lock acquired, local status = inserting', pendingSessionData);
    updateButtonStates(pendingSessionData);
    return { success: true, status: 'inserting', session: pendingSessionData };
  } catch (err) {
    console.error('createSession error', err);
    throw err;
  }
}

export function activateSession(session_id, bottles = 0, seconds = 0) {
  if (!session_id) {
    console.warn('activateSession: missing session_id');
    return;
  }
  setCurrentSessionId(session_id);
  updateConnectionStatus(!!window.mockConnected);
  const now = Math.floor(Date.now() / 1000);
  const sessionData = {
    id: Number(currentSessionId),
    status: bottles > 0 ? 'active' : 'awaiting_insertion',
    bottles_inserted: bottles,
    session_start: now,
    session_end: now + (seconds || 0)
  };
  pendingSessionData = sessionData;
  updateButtonStates(sessionData);
  console.log('Session activated (pending timer start):', sessionData);
}

export function startSessionTimer() {
  if (!pendingSessionData) {
    console.warn('startSessionTimer: no pending session data');
    return;
  }
  // start countdown and clear pending
  startSessionCountdown(pendingSessionData, async () => {
    // on expire
    updateConnectionStatus(false);
    updateButtonStates({ status: 'expired' });
    setCurrentSessionId(null);
  });
  pendingSessionData = null;
}

export async function handleBottleInserted(sessionId, newCount = null, minutesEarned = 0) {
  console.log('handleBottleInserted called for', sessionId, newCount, minutesEarned);
  if (!sessionId) {
    console.warn('handleBottleInserted: missing sessionId');
    return;
  }

  bottleCount = (typeof newCount === 'number' && newCount >= 0) ? newCount : (bottleCount + 1);
  const bottleCountEl = $('bottle-count');
  const timeEarnedEl = $('time-earned');
  if (bottleCountEl) bottleCountEl.textContent = String(bottleCount);
  if (timeEarnedEl && typeof minutesEarned === 'number') timeEarnedEl.textContent = `${minutesEarned} minutes`;

  const doneBtn = $('btn-done-insert');
  if (doneBtn) {
    doneBtn.disabled = bottleCount < 1;
    doneBtn.classList.toggle('disabled', bottleCount < 1);
  }

  try { document.querySelectorAll('.only-if-no-bottle').forEach(el => el.remove()); } catch (err) { console.warn(err); }

  // DO NOT start the server session on first bottle.
  // Only update local pendingSessionData so UI reflects counts while user inserts bottles.
  if (pendingSessionData) {
    pendingSessionData.bottles_inserted = bottleCount;
    updateButtonStates(pendingSessionData);
  }
}

// Ensure we listen to timer's registration events and keep local counters in sync
window.addEventListener('bottle-registered', (ev) => {
  try {
    const d = ev.detail || {};
    const sid = d.session_id || currentSessionId;
    const bottles = Number(d.bottles || 0);
    const minutes = Number((d.seconds || 0) / 60);
    if (bottles > 0) {
      // reuse existing handler to update UI/state
      handleBottleInserted(sid, bottles, minutes);
    }
  } catch (e) {
    console.warn('bottle-registered handler error', e);
  }
});

// -----------------------------------------------------------------
// Handle commit event (timer end or Done button) -> persist bottles and activate session
// -----------------------------------------------------------------
window.addEventListener('bottles-committed', async (ev) => {
  if (isCommitting) {
    console.warn('bottles-committed: commit already in progress, ignoring duplicate event');
    return;
  }
  isCommitting = true;
  try {
    const detail = ev.detail || {};
    const sessionId = detail.session_id || currentSessionId;
    let bottles = Number(detail.bottles ?? 0);
    if (!bottles) bottles = typeof bottleCount === 'number' && bottleCount > 0 ? bottleCount : (pendingSessionData?.bottles_inserted || 0);

    if (!sessionId) {
      console.warn('bottles-committed: no session id available');
      return;
    }
    if (!bottles || bottles <= 0) {
      console.warn('bottles-committed: no bottles to commit for session', sessionId);
      return;
    }

    console.log('Committing', bottles, 'bottles for session', sessionId);

    // Preferred: send the total count in a single request
    let res = await postBottles(sessionId, bottles);
    if (!res.ok) {
      // fallback: some servers expect one-by-one increments; try loop fallback
      console.warn('postBottles failed, falling back to single-post loop', res.status);
      for (let i = 0; i < bottles; i++) {
        const r = await fetch('/api/bottle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId })
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          console.error('Failed to register bottle', i + 1, 'of', bottles, r.status, body);
          throw new Error('Failed to register bottle');
        }
      }
    }

    // Activate session on server (server will set status -> active and set start/end)
    const actRes = await apiActivateSession(sessionId);
    if (!actRes.ok) {
      const body = await actRes.json().catch(() => ({}));
      console.error('Failed to activate session', sessionId, actRes.status, body);
      updateButtonStates({ status: 'awaiting_insertion' });
      return;
    }

    const actBody = await actRes.json().catch(()=>null);
    const sessionPayload = actBody && actBody.session ? actBody.session : null;
    if (sessionPayload) {
      pendingSessionData = {
        id: sessionPayload.id,
        status: sessionPayload.status,
        bottles_inserted: sessionPayload.bottles_inserted || 0,
        session_start: sessionPayload.session_start || null,
        session_end: sessionPayload.session_end || null
      };
      setCurrentSessionId(sessionPayload.id);
      try {
        startSessionCountdown(pendingSessionData, async () => {
          updateConnectionStatus(false);
          updateButtonStates({ status: 'expired' });
          setCurrentSessionId(null);
        });
      } catch (e) { console.warn('startSessionCountdown error', e); }
      updateButtonStates(pendingSessionData);
      updateConnectionStatus(true);
      console.log('Session activated after commit:', pendingSessionData);
    } else {
      await lookupSession();
    }
  } catch (err) {
    console.error('Error in bottles-committed handler', err);
  } finally {
    bottleCount = 0;
    isCommitting = false;
  }
});

export { handleBottleInserted as bottleInserted };

// Helper: load session object into manager state + UI, dispatch update event
export function loadSession(session) {
  if (!session) {
    pendingSessionData = null;
    setCurrentSessionId(null);
    updateButtonStates(null);
    try { updateConnectionStatus(false); } catch (e) {}
    window.dispatchEvent(new CustomEvent('session-updated', { detail: pendingSessionData || {} }));
    return null;
  }

  const sess = {
    id: session.id || session.session_id || null,
    status: session.status || 'awaiting_insertion',
    bottles_inserted: session.bottles_inserted ?? 0,
    seconds_earned: session.seconds_earned ?? 0,
    session_start: session.session_start || null,
    session_end: session.session_end || null
  };

  if (sess.id) setCurrentSessionId(sess.id);

  pendingSessionData = {
    id: sess.id,
    status: sess.status,
    bottles_inserted: sess.bottles_inserted,
    session_start: sess.session_start,
    session_end: sess.session_end
  };

  updateButtonStates(pendingSessionData);

  const now = Math.floor(Date.now() / 1000);
  const isConnected = (sess.status === 'active') && (!!sess.session_end && sess.session_end > now);
  try { updateConnectionStatus(isConnected); } catch (e) {}

  if (isConnected) {
    // start/refresh client session countdown and ensure server expiry is handled on end
    try {
      startSessionCountdown(pendingSessionData, makeExpireCallback(pendingSessionData.id));
    } catch (e) { console.warn('startSessionCountdown error', e); }
  } else {
    try { stopSessionCountdown(); } catch (e) {}
  }

  window.dispatchEvent(new CustomEvent('session-updated', { detail: pendingSessionData || {} }));
  return pendingSessionData;
}

// Replace lookupSession to use loadSession
export async function lookupSession() {
  try {
    console.log('lookupSession: requesting /api/session/lookup (via api module)');
    const body = await apiLookupSession();
    const session = body.session || body;
    loadSession(session);
    return session;
  } catch (err) {
    console.error('lookupSession error', err);
    return null;
  }
}

// Also ensure after activation we compute connected based on session_end > now
// (the bottles-committed handler already sets pendingSessionData; ensure it uses same logic)

export async function cancelInsertion() {
  console.log('cancelInsertion: reverting to awaiting_insertion');

  if (pendingSessionData) {
    pendingSessionData.status = 'awaiting_insertion';
    pendingSessionData.bottles_inserted = 0;
    pendingSessionData.session_start = null;
    pendingSessionData.session_end = null;
  } else {
    pendingSessionData = { id: null, status: 'awaiting_insertion', bottles_inserted: 0 };
  }

  // clear local session id
  setCurrentSessionId(null);

  // update UI
  try {
    updateButtonStates(pendingSessionData);
    updateConnectionStatus(false);
  } catch (err) {
    console.warn('cancelInsertion: UI update error', err);
  }

  // best-effort: release server-side insertion lock
  try {
    const res = await fetch('/api/session/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (res.ok) {
      try { showToast('Insertion cancelled', 'info', 3000); } catch {}
      console.log('cancelInsertion: server-side insertion lock released');
    } else {
      const body = await res.json().catch(() => ({}));
      console.warn('cancelInsertion: unlock returned non-OK', res.status, body);
      try { showToast(body.message || 'Failed to release lock', 'warning', 4000); } catch {}
    }
  } catch (err) {
    console.warn('cancelInsertion: unlock request failed', err);
  }
}

// -----------------------------------------------------------------
// When starting a client countdown for an active session, ensure server is
// notified on expiry so DB status is updated. Use the same onExpire hook
// everywhere we call startSessionCountdown.
function makeExpireCallback(sessionId) {
  return async function onExpire() {
    try {
      // best-effort: tell server this session expired
      await fetch(`/api/session/${sessionId}/expire`, { method: 'POST' });
    } catch (e) {
      console.warn('Failed to notify server of session expiry', e);
    } finally {
      updateConnectionStatus(false);
      updateButtonStates({ status: 'expired' });
      setCurrentSessionId(null);
      // notify listeners
      window.dispatchEvent(new CustomEvent('session-updated', { detail: { id: sessionId, status: 'expired' } }));
    }
  };
}

// Example usage in bottles-committed handler (after setting pendingSessionData):
// startSessionCountdown(pendingSessionData, makeExpireCallback(pendingSessionData.id));
// ...existing code...