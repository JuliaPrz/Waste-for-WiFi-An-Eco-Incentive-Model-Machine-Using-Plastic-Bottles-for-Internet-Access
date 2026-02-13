/**
 * Mock Dev Panel - Draggable developer controls
 */

let isDragging = false;
let currentX;
let currentY;
let initialX;
let initialY;
let xOffset = 0;
let yOffset = 0;

import { bottleInserted, createSession, lookupSession, getCurrentSessionId } from './sessionManager.js';
import { updateConnectionStatus } from './ui.js';

export function initMockDevPanel() {
  const panel = document.getElementById('mock-dev-panel');
  if (!panel) return; // nothing to do if panel not present

  const dragHandle = document.getElementById('mock-drag-handle');
  const toggleBtn = document.getElementById('mock-toggle-btn');
  const mockBody = document.getElementById('mock-body');
  const bottleInsertBtn = document.getElementById('mock-bottle-insert-btn');
  const startSessionBtn = document.getElementById('mock-start-session-btn');
  const stopSessionBtn = document.getElementById('mock-stop-session-btn');
  const sessionInfo = document.getElementById('mock-session-info');

  // Make panel draggable only if drag handle exists
  if (dragHandle) {
    dragHandle.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
  }

  // Toggle collapse (guard)
  if (toggleBtn && mockBody) {
    toggleBtn.addEventListener('click', () => {
      mockBody.classList.toggle('collapsed');
      toggleBtn.textContent = mockBody.classList.contains('collapsed') ? '+' : '−';
    });
  }

  // Mock bottle insert (guard)
  if (bottleInsertBtn) {
    bottleInsertBtn.addEventListener('click', async () => {
      // ✅ Get current session ID
      let sessionId = window.mockSessionId || getCurrentSessionId();
      
      // If no session id yet, try to perform the portal lookup (session is assigned at page load)
      if (!sessionId) {
        try {
          const sm = await import('./sessionManager.js');
          const session = await sm.lookupSession();
          sessionId = session?.id || session?.session?.id || getCurrentSessionId();
          if (sessionId) window.mockSessionId = sessionId;
        } catch (e) {
          console.warn('lookupSession fallback failed', e);
        }
      }

      if (!sessionId) {
        showToast('No active session. Please click "Insert Bottle" first.', 'error');
        return;
      }

      try {
        const response = await fetch('/api/bottle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId })
        });

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          const text = await response.text();
          console.error('❌ Expected JSON but got:', text.substring(0, 200));
          showToast('Server returned invalid response (not JSON)', 'error', 5000);
          return;
        }

        const data = await response.json();
        
        if (response.ok) {
          if (sessionInfo) {
            const status = data.status || 'active';
            const endTime = data.session_end ? new Date(data.session_end * 1000).toLocaleTimeString() : 'N/A';
            sessionInfo.innerHTML = `✅ Session ID: ${sessionId} <br>Status: ${status} (expires at ${endTime})`;
          }
          showToast(`Bottle inserted!`, 'success');
          
          // ❌ REMOVE extra server call via registerBottle (it was doubling bottles)
          // ✅ Instead, notify session manager with correct minutes
          try {
            const minutesEarned = Number((data.seconds_earned || 0) / 60);
            bottleInserted(sessionId, data.bottles_inserted, minutesEarned);
          } catch (err) { 
            console.error('bottleInserted error', err); 
          }
        } else {
          const errorMsg = data.error || data.message || 'Failed to insert bottle';
          showToast(`❌ ${errorMsg}`, 'error', 5000);
          console.error('Bottle insert failed:', data);
          
          if (errorMsg.includes('not accepting bottles') || errorMsg.includes('expired')) {
            showToast('Session ended. Click "Insert Bottle" to start new session.', 'info', 5000);
          }
        }
      } catch (error) {
        console.error('Mock bottle insert error:', error);
        showToast(`Connection error: ${error.message}`, 'error', 5000);
      }
    });
  }

  // Start new session (guard)
  if (startSessionBtn) {
    startSessionBtn.addEventListener('click', async () => {
      try {
        // Best-effort: release any insertion lock for the current session/device
        // Prefer unlocking over expiring so we don't erase earned time unexpectedly.
        const sid = window.mockSessionId || (typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : null);
        try {
          // Try unlocking by session context (server usually resolves device via cookie/IP)
          await fetch('/api/session/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sid ? { session_id: sid } : {})
          });
        } catch (e) {
          console.warn('Failed to call /api/session/unlock (non-fatal)', e);
        }

        // Now clear device_id cookie to simulate a completely new user
        try {
          await fetch('/api/dev/clear-device', { method: 'POST' });
        } catch (e) { console.warn('Failed to clear device_id (dev endpoint)', e); }
        document.cookie = 'device_id=; Max-Age=0; path=/';

        // Clear local storage and local mock session pointer
        localStorage.removeItem('session_id');
        window.mockSessionId = null;

        // Lookup/create a fresh session in awaiting_insertion state
        await lookupSession();

        showToast('Started new session as new user', 'success');
        await refreshSessionInfo();
      } catch (err) {
        console.error('Start session error', err);
        showToast('Failed to start session', 'error');
      }
    });
  }

  // Stop current session (guard)
  if (stopSessionBtn) {
    stopSessionBtn.addEventListener('click', async () => {
      const sid = window.mockSessionId || getCurrentSessionId();
      if (!sid) {
        showToast('No session to stop', 'error');
        return;
      }

      const payload = { session_id: sid, status: 'expired' }; // use expired instead of disconnected
      const attempts = [
        { url: `/api/session/${sid}/status`, method: 'POST' },
        { url: '/api/session/status', method: 'POST' }
      ];

      let success = false;
      for (const a of attempts) {
        try {
          const res = await fetch(a.url, {
            method: a.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (res.ok) { success = true; break; }
        } catch (e) { /* try next */ }
      }

      if (success) {
        showToast('Session stopped (expired)', 'success');
        const evt = new CustomEvent('session-updated', { detail: { id: sid, status: 'expired' } }); // dispatch expired
        window.dispatchEvent(evt);
        await refreshSessionInfo();
      } else {
        showToast('Failed to stop session (no endpoint)', 'error');
      }
    });
  }

  async function refreshSessionInfo() {
    try {
      const session = await lookupSession();
      const sid = session?.id || getCurrentSessionId();
      if (session) {
        const now = Math.floor(Date.now() / 1000);
        const status = session.status || 'awaiting_insertion';
        const remaining = session.session_end ? Math.max(0, session.session_end - now) : 0;
        if (sessionInfo) sessionInfo.innerHTML = `Session ID: ${sid || 'N/A'}<br>Status: ${status}${status === 'active' ? ` (expires in ${Math.floor(remaining/60)}m ${remaining%60}s)` : ''}<br>Bottles: ${session.bottles_inserted || 0}`;
      } else if (sid) {
        sessionInfo.innerHTML = `Session ID: ${sid}<br>Status: unknown`;
      } else {
        sessionInfo.innerHTML = 'No Active session';
      }
    } catch (e) {
      sessionInfo.innerHTML = 'No Active session';
    }
  }

  // populate session info on panel init
  refreshSessionInfo();

  // update when sessionManager dispatches session-updated
  window.addEventListener('session-updated', (ev) => {
    try {
      const s = ev.detail || {};
      const sid = s.id || getCurrentSessionId();
      const status = s.status || 'awaiting_insertion';
      const now = Math.floor(Date.now() / 1000);
      const remaining = s.session_end ? Math.max(0, s.session_end - now) : 0;
      if (sessionInfo) sessionInfo.innerHTML = `Session ID: ${sid || 'N/A'}<br>Status: ${status}${status === 'active' ? ` (expires in ${Math.floor(remaining/60)}m ${remaining%60}s)` : ''}<br>Bottles: ${s.bottles_inserted || 0}`;
    } catch (e) {
      // ignore
    }
  });

  function dragStart(e) {
    initialX = e.clientX - xOffset;
    initialY = e.clientY - yOffset;

    if (e.target === dragHandle || dragHandle.contains(e.target)) {
      isDragging = true;
      panel.style.cursor = 'grabbing';
    }
  }

  function drag(e) {
    if (isDragging) {
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;

      xOffset = currentX;
      yOffset = currentY;

      setTranslate(currentX, currentY, panel);
    }
  }

  function dragEnd(e) {
    initialX = currentX;
    initialY = currentY;
    isDragging = false;
    panel.style.cursor = 'default';
  }

  function setTranslate(xPos, yPos, el) {
    el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
  }
}

function showToast(message, type = 'info', duration = 3000) {
  // Reuse existing toast system
  if (window.showToast) {
    window.showToast(message, type, duration);
  } else {
    console.log(`[TOAST ${type}]`, message);
  }
}

export async function createMockSession(mac_address = null, ip_address = null) {
  // Instead of creating a DB session immediately, attempt to acquire insertion lock.
  const payload = {};
  if (mac_address) payload.mac_address = mac_address;
  if (ip_address) payload.ip_address = ip_address;

  try {
    console.log('createMockSession: requesting insertion lock...');
    const res = await fetch('/api/session/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      const msg = body.message || body.error || 'Machine is currently busy';
      showToast(msg, 'error', 8000);
      console.warn('createMockSession: lock denied:', msg);
      throw new Error(msg);
    }
    if (!res.ok) {
      const body = await res.json().catch(()=>({}));
      console.error('createMockSession: lock request failed', body);
      throw new Error('Failed to acquire insertion lock');
    }

    const info = await res.json().catch(()=>({}));
    // Do NOT create DB session yet; mark local pending state as "inserting"
    pendingSessionData = {
      id: null,
      status: 'inserting',
      bottles_inserted: 0,
      session_start: null,
      session_end: null,
      owner: info.owner || window.location.hostname
    };
    // set currentSessionId still null (no session id yet)
    setCurrentSessionId(null);
    console.log('createMockSession: insertion lock acquired, local status = inserting', pendingSessionData);
    updateButtonStates(pendingSessionData);
    return { success: true, status: 'inserting' };
  } catch (err) {
    console.error('createMockSession error', err);
    throw err;
  }
}