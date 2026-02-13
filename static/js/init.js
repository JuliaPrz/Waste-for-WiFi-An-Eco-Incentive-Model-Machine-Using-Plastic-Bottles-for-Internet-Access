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
    // Lookup or create session for this device when portal opens
    const session = await lookupSession();
    let currentSessionStatus =
      session?.status ||
      (session && session.session && session.session.status) ||
      'awaiting_insertion';
    console.log('Session lookup result:', session, 'status:', currentSessionStatus);

    // Initialize UI state
    const sessionId = getCurrentSessionId();
    updateButtonStates(
      sessionId ? { status: currentSessionStatus, session_id: sessionId } : null
    );

    // Insert Bottle button — single handler
    const insertBtn = $('btn-insert-bottle');
    if (insertBtn) {
      insertBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        console.log('Insert Bottle clicked — last known status:', currentSessionStatus);

        let sid = getCurrentSessionId();

        // Always acquire insertion lock from server (awaiting_insertion, active, or already inserting)
        try {
          const res = await createSession(); // shows toast on 409 and throws on busy
          sid = res?.session?.id || getCurrentSessionId() || sid;
          // Refresh local status from server response
          currentSessionStatus =
            res?.status || res?.session?.status || 'inserting';
          console.log(
            'Insertion lock acquired — session:',
            sid,
            'status:',
            currentSessionStatus
          );
        } catch (err) {
          console.warn('Could not acquire insertion lock', err);
          // Do NOT open the modal when lock not acquired
          return;
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
        } catch (e2) {
          console.warn('Failed to load session data', e2);
        }

        // Open modal only after lock has been acquired
        openModal('modal-insert-bottle');
        console.log(
          'Opened insert-bottle modal for session:',
          sid,
          'bottles:',
          currentBottles,
          'seconds:',
          currentSeconds
        );

        // Start timer with session data
        try {
          startBottleTimer(sid, currentBottles, currentSeconds);
        } catch (e3) {
          console.warn('startBottleTimer error', e3);
        }
      });
    }

    // X button handler for modal (single handler)
    const modalCloseX = document.getElementById('modal-close-x');
    if (modalCloseX) {
      modalCloseX.addEventListener('click', async (e) => {
        e.preventDefault();
        console.log('Modal X clicked — cancelling insertion and closing modal');
        try {
          await cancelInsertion();
        } catch (err) {
          console.error('cancelInsertion error', err);
        }
        closeModal('modal-insert-bottle');
      });
    }

    // Rate button: navigate to protected rating page
    const rateBtn = $('btn-rate');
    if (rateBtn) {
      rateBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = '/rating';
      });
    }

    // After wiring buttons, check if this session already has a rating
    async function initRatingButtonState() {
      const btn = $('btn-rate');
      if (!btn) return;
      try {
        const res = await fetch('/api/rating/status', { method: 'GET' });
        if (!res.ok) return;
        const info = await res.json().catch(() => ({}));
        if (info.has_rating) {
          // Disable the button if rating already submitted for this session
          btn.disabled = true;
          btn.classList.add('disabled');
          btn.setAttribute('aria-disabled', 'true');
        }
      } catch (e) {
        console.warn('Failed to check rating status', e);
      }
    }

    initRatingButtonState();

    // Remove any older attachGuardedButton('btn-rate', ...) logic below
    // ...existing code...
    const mockBottleBtn = $('mock-bottle-btn');
    if (mockBottleBtn) {
      mockBottleBtn.addEventListener('click', () => {
        console.log('Mock bottle button clicked');
        registerBottle();
      });
    }

    const howBtn = $('btn-howitworks');
    if (howBtn) {
      howBtn.addEventListener('click', () => openModal('modal-howitworks'));
    }

    initMockDevPanel();

    // ✅ If we just returned from rating page, show success toast once
    try {
      const flag = window.localStorage.getItem('rating_submitted');
      if (flag === '1' && window.showToast) {
        window.showToast('Thanks for your feedback!', 'success', 4000);
      }
      if (flag !== null) {
        window.localStorage.removeItem('rating_submitted');
      }
    } catch (_) {}

  } catch (err) {
    console.error('Error in DOMContentLoaded handler:', err);
  }
});

// No extra btn-insert-bottle handlers below this line
