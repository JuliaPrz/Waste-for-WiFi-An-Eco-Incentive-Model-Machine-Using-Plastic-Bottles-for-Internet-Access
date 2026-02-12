export const $ = (id) => document.getElementById(id);

// Update UI-only responsibilities: button states, connection pill and labels
export function setConnected(flag) {
  const root = document.querySelector('.app-root');
  if (root) root.classList.toggle('connected', !!flag);
}

export function updateConnectionStatus(connected) {
  try {
    console.log('ui.updateConnectionStatus ->', connected);
    setConnected(connected);

    const statusPill = document.querySelector('.status-pill') || document.getElementById('status-pill') || document.querySelector('.connection-pill');
    const connDot = document.getElementById('connection-dot') || document.querySelector('.connection-dot');
    const connLabel = document.getElementById('connected-label') || document.querySelector('.connected-label') || document.querySelector('.connection-label');

    if (statusPill) {
      statusPill.classList.toggle('connected', !!connected);
      statusPill.classList.toggle('disconnected', !connected);
    } else {
      document.body.setAttribute('data-connected', !!connected ? 'true' : 'false');
    }

    if (connDot) connDot.style.backgroundColor = connected ? 'green' : 'red';
    if (connLabel) connLabel.textContent = connected ? 'Connected' : 'Disconnected';
  } catch (err) {
    console.warn('ui.updateConnectionStatus error', err);
  }
}

export function updateButtonStates(sessionData) {
  const insertBtn = $('btn-insert-bottle');
  const rateBtn = $('btn-rate');

  // default state
  if (!sessionData) {
    if (insertBtn) {
      insertBtn.disabled = false;
      insertBtn.textContent = 'Insert Plastic Bottle';
      insertBtn.setAttribute('aria-label', 'Insert Plastic Bottle');
    }
    if (rateBtn) rateBtn.disabled = true;
    console.log('ui.updateButtonStates: no session -> enable Insert, disable Rate');
    try { setConnected(false); } catch (e) {}
    return;
  }

  // session exists: handle by status
  const status = sessionData.status || 'awaiting_insertion';

  // If inserting: follow original logic (prevent new inserts while locked)
  if (status === 'inserting') {
    if (insertBtn) {
      insertBtn.disabled = true;
      insertBtn.textContent = 'Insert Plastic Bottle';
      insertBtn.setAttribute('aria-label', 'Insert Plastic Bottle (locked)');
    }
  }
  // If active: allow adding more bottles (enable and relabel)
  else if (status === 'active') {
    if (insertBtn) {
      insertBtn.disabled = false;
      insertBtn.textContent = 'Add More Bottle';
      insertBtn.setAttribute('aria-label', 'Add More Bottle');
    }
  }
  // Other statuses (awaiting_insertion, expired, etc.)
  else {
    if (insertBtn) {
      insertBtn.disabled = false;
      insertBtn.textContent = 'Insert Plastic Bottle';
      insertBtn.setAttribute('aria-label', 'Insert Plastic Bottle');
    }
  }

  if (rateBtn) rateBtn.disabled = false;

  try { setConnected(status === 'active'); } catch (e) {}
  console.log('ui.updateButtonStates: session exists -> insert disabled:', insertBtn ? insertBtn.disabled : 'n/a', 'label:', insertBtn ? insertBtn.textContent : 'n/a');
}