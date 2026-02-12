import { $, showToast } from './dom.js';
import { formatTime, getCurrentTimestamp } from './utils.js';
import { lookupSession as apiLookupSession, acquireInsertionLock, unlockInsertion, postBottles, activateSession as apiActivateSession, getSession as apiGetSession } from './api/sessionApi.js';
import { updateButtonStates, updateConnectionStatus } from './ui.js';
import { startSessionCountdown, stopSessionCountdown } from './timer.js';

let currentSessionId = null;
let pendingSessionData = null;
let bottleCount = 0;
let isCommitting = false;
let serverBottleCount = 0; // track server-side known count to avoid double-posting

// Expose for timer/UI modules
if (typeof window !== 'undefined') {
  window.sessionManager = {
    get pendingSessionData() { return pendingSessionData; },
    get currentSessionId() { return currentSessionId; },
    get bottleCount() { return bottleCount; }
  };
}

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
    const returnedSession = info.session || {};

    // set client state to awaiting_insertion and record server session id if returned
    pendingSessionData = {
      id: info.session_id || returnedSession.id || null,
      status: returnedSession.status || 'inserting',
      bottles_inserted: returnedSession.bottles_inserted || 0,
      seconds_earned: returnedSession.seconds_earned || 0,
      session_start: null,
      session_end: null,
      owner: info.owner || window.location.hostname
    };
    if (pendingSessionData.id) setCurrentSessionId(pendingSessionData.id);

    console.log('createSession: insertion lock acquired', pendingSessionData);
    // Update bottle count from server state
    bottleCount = pendingSessionData.bottles_inserted || 0;
    serverBottleCount = pendingSessionData.bottles_inserted || 0;
    updateButtonStates(pendingSessionData);
    return { success: true, status: pendingSessionData.status, session: pendingSessionData };
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

  // if server returned a count, use it as authoritative and update serverBottleCount
  if (typeof newCount === 'number' && newCount >= 0) {
    bottleCount = newCount;
    serverBottleCount = newCount;
  } else {
    bottleCount = bottleCount + 1;
  }
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

  // Hide helper text in modal once at least one bottle has been inserted
  try {
    const helper = document.getElementById('insert-helper');
    if (helper && bottleCount > 0) helper.style.display = 'none';
  } catch (e) { console.warn('hide helper error', e); }
  
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

    // Compute delta vs what server already knows to avoid double-increment.
    const delta = Math.max(0, bottles - (serverBottleCount || 0));
    let res = null;
    if (delta > 0) {
      // Preferred: send only the delta
      res = await postBottles(sessionId, delta);
      if (!res || !res.ok) {
        // fallback: some servers expect one-by-one increments; try loop fallback
        console.warn('postBottles failed, falling back to per-bottle POST for delta');
        for (let i = 0; i < delta; i++) {
          const r = await fetch('/api/bottle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId })
          });
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            console.error('Failed to register bottle', i + 1, 'of', delta, r.status, body);
            throw new Error('Failed to register bottle');
          }
        }
      }
    } else {
      console.log('No delta to post - server already has the bottles');
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
      // sync server-known count after successful commit/activate
      serverBottleCount = pendingSessionData.bottles_inserted || serverBottleCount;
      bottleCount = pendingSessionData.bottles_inserted || 0;
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
    const resumed = body.resumed || false;
    
    if (resumed) {
      console.log('lookupSession: resumed existing session', session.id, 'status:', session.status);
      // If active session resumed, start countdown immediately
      if (session.status === 'active' && session.session_end) {
        const now = Math.floor(Date.now() / 1000);
        const remaining = Math.max(0, session.session_end - now);
        console.log('Resuming active session with', remaining, 'seconds remaining');
      }
    } else {
      console.log('lookupSession: created new session', session.id);
    }
    
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
  console.log('cancelInsertion: reverting session status');

  const sessionId = currentSessionId || pendingSessionData?.id;
  const currentStatus = pendingSessionData?.status;
  const hasBottles = (pendingSessionData?.bottles_inserted || 0) > 0;

  // Release server-side insertion lock (server will determine correct status)
  try {
    const res = await fetch('/api/session/unlock', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' } 
    });
    
    if (res.ok) {
      console.log('cancelInsertion: server-side insertion lock released');
      
      // Refresh session state from server
      if (sessionId) {
        try {
          const refreshRes = await fetch(`/api/session/${sessionId}`);
          if (refreshRes.ok) {
            const refreshedSession = await refreshRes.json();
            pendingSessionData = refreshedSession;
            console.log('Refreshed session after cancel:', refreshedSession);
            updateButtonStates(refreshedSession);
            updateConnectionStatus(refreshedSession.status === 'active');
            try { 
              showToast(
                hasBottles ? 'Resumed active session' : 'Insertion cancelled', 
                'info', 
                3000
              ); 
            } catch {}
            return;
          }
        } catch (err) {
          console.warn('Failed to refresh session after cancel', err);
        }
      }
      
      // Fallback: update local state based on bottles
      if (hasBottles) {
        pendingSessionData.status = 'active';
        try { showToast('Resumed active session', 'info', 3000); } catch {}
      } else {
        pendingSessionData.status = 'awaiting_insertion';
        setCurrentSessionId(null);
        try { showToast('Insertion cancelled', 'info', 3000); } catch {}
      }
      
      updateButtonStates(pendingSessionData);
      updateConnectionStatus(pendingSessionData.status === 'active');
    } else {
      const body = await res.json().catch(() => ({}));
      console.warn('cancelInsertion: unlock returned non-OK', res.status, body);
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

