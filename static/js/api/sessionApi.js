export async function lookupSession() {
  const res = await fetch('/api/session/lookup', { method: 'GET' });
  if (!res.ok) throw new Error(`lookupSession failed: ${res.status}`);
  return await res.json();
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
    method: 'POST'
  });
}