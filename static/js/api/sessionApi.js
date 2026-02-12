function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}

export async function lookupSession() {
  try {
    // Include device_id from cookie if available
    const deviceId = getCookie('device_id');
    const url = deviceId ? `/api/session/lookup?device_id=${encodeURIComponent(deviceId)}` : '/api/session/lookup';

    const res = await fetch(url, { method: 'GET', credentials: 'same-origin' });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }

    if (!res.ok) {
      const detail = (body && (body.detail || body.error || body.message)) || JSON.stringify(body) || '';
      const msg = `lookupSession failed: ${res.status} ${res.statusText}${detail ? ' - ' + detail : ''}`;
      throw new Error(msg);
    }
    return body;
  } catch (err) {
    throw new Error(err && err.message ? err.message : 'lookupSession failed');
  }
}

// Acquire insertion lock (server creates session with status='inserting' if available)
export async function acquireInsertionLock(payload = {}) {
  return await fetch('/api/session/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export async function unlockInsertion(payload = {}) {
  return await fetch('/api/session/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

export async function postBottles(sessionId, count = 1) {
  return await fetch('/api/bottle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, count })
  });
}

export async function activateSession(sessionId) {
  return await fetch(`/api/session/${sessionId}/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
}

// Get session by ID
export async function getSession(sessionId) {
  const res = await fetch(`/api/session/${sessionId}`, { 
    method: 'GET', 
    credentials: 'same-origin' 
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  
  if (!res.ok) {
    const detail = (body && (body.detail || body.error || body.message)) || JSON.stringify(body) || '';
    throw new Error(`getSession failed: ${res.status} ${res.statusText}${detail ? ' - ' + detail : ''}`);
  }
  return body;
}

// Update session status
export async function updateSessionStatus(sessionId, status) {
  return await fetch(`/api/session/${sessionId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
}

// Expire session
export async function expireSession(sessionId) {
  return await fetch(`/api/session/${sessionId}/expire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
}