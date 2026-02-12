import { $, openModal, closeModal } from './dom.js';
import { startBottleTimer, stopBottleTimer, registerBottle } from './timer.js';
import { initMockDevPanel } from './mockDevPanel.js';
import {
  getCurrentSessionId,
  createSession,
  activateSession,
  startSessionTimer,
  cancelInsertion,
  lookupSession
} from './sessionManager.js';
import { updateButtonStates } from './ui.js';

function attachGuardedButton(buttonId, onAllowed) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      e.preventDefault();
      e.stopPropagation();
      console.log(`Action blocked: no session for button ${buttonId}`);
      return;
    }
    if (typeof onAllowed === 'function') onAllowed(e);
  }, { capture: true });
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    console.log('DOMContentLoaded handler running');

    // Lookup or create session for this device when portal opens
    const session = await lookupSession();
    let currentSessionStatus = session?.status || (session && session.session && session.session.status) || 'awaiting_insertion';
    console.log('Session lookup result:', session, 'status:', currentSessionStatus);

    // Initialize UI state
    const sessionId = getCurrentSessionId();
    updateButtonStates(sessionId ? { status: currentSessionStatus, session_id: sessionId } : null);

    // Insert Bottle button: create session if none, then open modal & start timer
    const insertBtn = $('btn-insert-bottle');
    if (insertBtn) {
      insertBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        console.log('Insert Bottle clicked — current status:', currentSessionStatus);

        let sid = getCurrentSessionId();

        // Attempt to acquire server-side insertion lock (creates/claims session with status='inserting')
        // If the session is already 'inserting' or 'active' we skip acquisition.
        if (currentSessionStatus !== 'inserting' && currentSessionStatus !== 'active') {
          try {
            const res = await createSession();
            // createSession throws on failure; on success it returns { success: true, status: 'inserting', session: {...} }
            sid = res?.session?.id || getCurrentSessionId() || sid;
            currentSessionStatus = res?.status || res?.session?.status || 'inserting';
            console.log('Insertion lock acquired — session:', sid, 'status:', currentSessionStatus, res);
          } catch (err) {
            // createSession already shows toast on 409; do not open modal
            console.warn('Could not acquire insertion lock, aborting modal open', err);
            return;
          }
        } else {
          console.log('Using existing session id:', sid, 'status:', currentSessionStatus);
        }

        // Only open modal after lock acquired
        // Populate modal with current session bottle/time data from server, then open modal & start timer
        try {
          if (sid) {
            const resp = await fetch(`/api/session/${encodeURIComponent(sid)}`);
            if (resp.ok) {
              const srv = await resp.json().catch(()=>null);
              const bottles = Number(srv?.bottles_inserted ?? srv?.bottles ?? 0);
              const seconds = Number(srv?.seconds_earned ?? 0);
              const bottleCountEl = document.getElementById('bottle-count');
              const timeEarnedEl = document.getElementById('time-earned');
              if (bottleCountEl) bottleCountEl.textContent = String(bottles);
              if (timeEarnedEl) timeEarnedEl.textContent = `${Math.floor(seconds/60)} minutes`;
            }
          }
        } catch (e) {
          console.warn('Failed to load session bottle/time data', e);
        }

        openModal('modal-insert-bottle');
        console.log('Opened insert-bottle modal for session:', sid, 'status:', currentSessionStatus);
        try { startBottleTimer(sid); } catch (e) { console.warn('startBottleTimer error', e); }
      });
    } else {
      console.warn('Insert button not found in DOM');
    }

    // Rate button: navigate to rate page with session id
    const rateBtn = $('btn-rate');
    if (rateBtn) {
      rateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const sid = getCurrentSessionId() || (pendingSessionData && pendingSessionData.id) || new URL(window.location.href).searchParams.get('session') || new URL(window.location.href).searchParams.get('session_id');
        if (!sid) {
          console.warn('Rate clicked but no session id available');
          return;
        }
        window.location.href = `/rate.html?session_id=${encodeURIComponent(sid)}`;
      });
    }

    // Rate button: require session
    attachGuardedButton('btn-rate', () => openModal('modal-rate'));

    const mockBottleBtn = $('mock-bottle-btn');
    if (mockBottleBtn) {
      mockBottleBtn.addEventListener('click', () => {
        console.log('Mock bottle button clicked');
        registerBottle();
      });
    }

    const howBtn = $('btn-howitworks');
    if (howBtn) howBtn.addEventListener('click', () => openModal('modal-howitworks'));

    initMockDevPanel();

    // Ensure the top-right X closes the modal and reverts insertion (uses imported cancelInsertion)
    const modalCloseX = document.getElementById('modal-close-x');
    if (modalCloseX) {
      modalCloseX.addEventListener('click', async (e) => {
        e.preventDefault();
        console.log('Modal X clicked — cancelling insertion and closing modal');
        try { await cancelInsertion(); } catch (err) { console.error('cancelInsertion error', err); }
        closeModal('modal-insert-bottle');
      });
    }
   } catch (err) {
     console.error('Error in DOMContentLoaded handler:', err);
   }
});
