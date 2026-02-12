export const $ = (id) => document.getElementById(id);

export function openModal(id) {
  const modal = $(id);
  if (modal) modal.classList.add('active');
}

export function closeModal(id) {
  const modal = $(id);
  if (modal) modal.classList.remove('active');
}

export function showToast(message, type = 'info', duration = 2500) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.classList.add(`toast-${type}`);
  t.innerText = message;
  const container = $('toasts');
  if (!container) return;
  container.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// expose to global so other modules/legacy handlers can call it without extra toast code
window.showToast = showToast;

export function setConnected(flag){ const root = document.querySelector('.app-root'); if(!root) return; root.classList.toggle('connected', !!flag); }

// Delegated handler: close modal when a .modal-close or .modal-close-x button is clicked
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.modal-close, .modal-close-x');
  if (!btn) return;
  const modal = btn.closest('.modal');
  if (modal) modal.classList.remove('active');
});
