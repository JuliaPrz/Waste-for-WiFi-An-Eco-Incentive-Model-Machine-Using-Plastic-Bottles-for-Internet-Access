import { $, openModal, closeModal } from './dom.js';
import { startBottleTimer, registerBottle } from './timer.js';
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

    // Insert Bottle button
    const insertBtn = $('btn-insert-bottle');
    if (insertBtn) {
      insertBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        console.log('Insert Bottle clicked — current status:', currentSessionStatus);

        let sid = getCurrentSessionId();

        // Acquire insertion lock
        if (currentSessionStatus !== 'inserting' && currentSessionStatus !== 'active') {
          try {
            const res = await createSession();
            sid = res?.session?.id || getCurrentSessionId() || sid;
            currentSessionStatus = res?.status || res?.session?.status || 'inserting';
            console.log('Insertion lock acquired — session:', sid, 'status:', currentSessionStatus);
          } catch (err) {
            console.warn('Could not acquire insertion lock', err);
            return;
          }
        }

        // Fetch current session data
        let currentBottles = 0;
        let currentSeconds = 0;
        try {
          if (sid) {
            const resp = await fetch(`/api/session/${encodeURIComponent(sid)}`);
            if (resp.ok) {
              const srv = await resp.json().catch(() => null);
              currentBottles = Number(srv?.bottles_inserted ?? 0);
              currentSeconds = Number(srv?.seconds_earned ?? 0);
            }
          }
        } catch (e) {
          console.warn('Failed to load session data', e);
        }

        // Open modal
        openModal('modal-insert-bottle');
        console.log('Opened insert-bottle modal for session:', sid, 'bottles:', currentBottles, 'seconds:', currentSeconds);
        
        // Start timer with session data
        try { 
          startBottleTimer(sid, currentBottles, currentSeconds); 
        } catch (e) { 
          console.warn('startBottleTimer error', e); 
        }
      });
    }

    // X button handler for modal (single handler)
    const modalCloseX = document.getElementById('modal-close-x');
    if (modalCloseX) {
      modalCloseX.addEventListener('click', async (e) => {
        e.preventDefault();
        console.log('Modal X clicked — cancelling insertion and closing modal');
        try { await cancelInsertion(); } catch (err) { console.error('cancelInsertion error', err); }
        closeModal('modal-insert-bottle');
      });
    }

    // Rate button: navigate to rate page with session id
    const rateBtn = $('btn-rate');
    if (rateBtn) {
      rateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const sid = getCurrentSessionId() || new URL(window.location.href).searchParams.get('session_id') || new URL(window.location.href).searchParams.get('session');
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
  } catch (err) {
    console.error('Error in DOMContentLoaded handler:', err);
  }
});
