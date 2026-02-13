function showToast(message, type = 'info', duration = 4000) {
  // Prefer existing global toast helper if available
  if (window.showToast && typeof window.showToast === 'function') {
    window.showToast(message, type, duration);
    return;
  }

  // Minimal local toast implementation (uses same classes/IDs as main page)
  let container = document.getElementById('toasts');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toasts';
    container.className = 'toasts';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('rating-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const payload = {};
    const missing = [];

    // Collect and validate q1..q10 (all required)
    for (let i = 1; i <= 10; i++) {
      const name = `q${i}`;
      const checked = document.querySelector(`input[name="${name}"]:checked`);
      if (!checked) {
        missing.push(name);
        continue;
      }
      payload[name] = Number(checked.value);
    }

    if (missing.length > 0) {
      showToast('Please answer all questions (1–10) before submitting.', 'error');
      return;
    }

    // Comment is optional
    payload.comment = (document.getElementById('rating-comment')?.value || '').trim();

    try {
      const res = await fetch('/api/rating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console.error('Rating submit failed', res.status, body);
        showToast(body.error || 'Failed to submit rating.', 'error');
        return;
      }

      // ✅ Mark that rating was submitted, so main page can show toast
      try {
        window.localStorage.setItem('rating_submitted', '1');
      } catch (_) {}

      window.location.href = '/';
    } catch (err) {
      console.error('Error submitting rating', err);
      showToast('Failed to submit rating. Please try again.', 'error');
    }
  });
});