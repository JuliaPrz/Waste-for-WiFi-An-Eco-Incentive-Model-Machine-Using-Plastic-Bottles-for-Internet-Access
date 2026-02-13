const ONGOING_PAGE_SIZE = 10;
const RATINGS_PAGE_SIZE = 10;
const MAX_PAGES = 10; // maximum pages we show per table

function showToast(message, type = 'info', duration = 4000) {
  if (window.showToast && typeof window.showToast === 'function') {
    window.showToast(message, type, duration);
    return;
  }
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

function updateKpis(payload) {
  const activeEl = document.getElementById('kpi-active-sessions');
  const bottlesTodayEl = document.getElementById('kpi-bottles-today');
  const totalBottlesEl = document.getElementById('kpi-total-bottles');
  const totalReviewsEl = document.getElementById('kpi-total-reviews');

  if (activeEl) activeEl.textContent = payload.active_sessions ?? 0;
  if (bottlesTodayEl) bottlesTodayEl.textContent = payload.bottles_today ?? 0;
  if (totalBottlesEl) totalBottlesEl.textContent = payload.total_bottles ?? 0;
  if (totalReviewsEl) totalReviewsEl.textContent = payload.total_reviews ?? 0;
}

function updateRatingsSummary(means) {
  // means: { q1..q10, composite }
  for (let i = 1; i <= 10; i++) {
    const el = document.getElementById(`rating-q${i}`);
    if (!el) continue;
    const v = means && typeof means[`q${i}`] === 'number' ? means[`q${i}`] : null;
    el.textContent = v != null ? v.toFixed(2) : '-';
  }
  const compEl = document.getElementById('rating-composite');
  if (compEl) {
    const v = means && typeof means.composite === 'number' ? means.composite : null;
    compEl.textContent = v != null ? v.toFixed(2) : '-';
  }
}

function formatTsRelative(sessionEnd) {
  if (!sessionEnd) return '-';
  const now = Math.floor(Date.now() / 1000);
  const diff = sessionEnd - now;
  if (diff <= 0) return 'Expired';
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function formatTs(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

// Ongoing sessions pagination state
let latestOngoing = [];
let ongoingFiltered = [];
let ongoingPage = 1;

function renderOngoingPagination() {
  const container = document.getElementById('ongoing-pagination');
  if (!container) return;
  container.innerHTML = '';

  const totalRows = ongoingFiltered.length;
  if (!totalRows) return;

  const totalPages = Math.min(MAX_PAGES, Math.ceil(totalRows / ONGOING_PAGE_SIZE));

  const prevBtn = document.createElement('button');
  prevBtn.textContent = '‹';
  prevBtn.disabled = ongoingPage <= 1;
  prevBtn.onclick = () => {
    if (ongoingPage > 1) {
      ongoingPage--;
      renderOngoingPage();
    }
  };
  container.appendChild(prevBtn);

  for (let p = 1; p <= totalPages; p++) {
    const btn = document.createElement('button');
    btn.textContent = String(p);
    if (p === ongoingPage) btn.classList.add('active');
    btn.onclick = () => {
      ongoingPage = p;
      renderOngoingPage();
    };
    container.appendChild(btn);
  }

  const nextBtn = document.createElement('button');
  nextBtn.textContent = '›';
  nextBtn.disabled = ongoingPage >= totalPages;
  nextBtn.onclick = () => {
    if (ongoingPage < totalPages) {
      ongoingPage++;
      renderOngoingPage();
    }
  };
  container.appendChild(nextBtn);
}

function renderOngoingPage() {
  const tbody = document.getElementById('table-ongoing');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!ongoingFiltered.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" class="empty-cell">No ongoing sessions.</td>`;
    tbody.appendChild(tr);
    return;
  }

  const start = (ongoingPage - 1) * ONGOING_PAGE_SIZE;
  const end = start + ONGOING_PAGE_SIZE;
  const maxRows = MAX_PAGES * ONGOING_PAGE_SIZE;
  const dataToShow = ongoingFiltered.slice(0, maxRows);
  const pageRows = dataToShow.slice(start, end);

  if (!pageRows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" class="empty-cell">No ongoing sessions.</td>`;
    tbody.appendChild(tr);
  } else {
    pageRows.forEach((row) => {
      const tr = document.createElement('tr');
      const cells = [
        { label: 'Session ID', value: row.id || '-' },
        { label: 'Status', value: row.status || '-' },
        { label: 'Bottles', value: row.bottles_inserted || 0 },
        { label: 'Expires In', value: formatTsRelative(row.session_end) },
      ];

      cells.forEach((cell) => {
        const td = document.createElement('td');
        td.dataset.label = cell.label;
        td.textContent = cell.value;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  renderOngoingPagination();
}

function applyOngoingFilter() {
  const form = document.getElementById('ongoing-filter-form');
  const status = form?.elements?.status?.value || '';

  ongoingFiltered = latestOngoing.filter((row) => {
    if (status && row.status !== status) return false;
    return true;
  });

  ongoingPage = 1;
  renderOngoingPage();
}

function renderOngoingTable(rows) {
  latestOngoing = rows || [];
  applyOngoingFilter();
}

// Ratings pagination state
let ratingsRows = [];
let ratingsPage = 1;

function renderRatingsPagination() {
  const container = document.getElementById('ratings-pagination');
  if (!container) return;
  container.innerHTML = '';

  const totalRows = ratingsRows.length;
  if (!totalRows) return;

  const totalPages = Math.min(MAX_PAGES, Math.ceil(totalRows / RATINGS_PAGE_SIZE));

  const prevBtn = document.createElement('button');
  prevBtn.textContent = '‹';
  prevBtn.disabled = ratingsPage <= 1;
  prevBtn.onclick = () => {
    if (ratingsPage > 1) {
      ratingsPage--;
      renderRatingsPage();
    }
  };
  container.appendChild(prevBtn);

  for (let p = 1; p <= totalPages; p++) {
    const btn = document.createElement('button');
    btn.textContent = String(p);
    if (p === ratingsPage) btn.classList.add('active');
    btn.onclick = () => {
      ratingsPage = p;
      renderRatingsPage();
    };
    container.appendChild(btn);
  }

  const nextBtn = document.createElement('button');
  nextBtn.textContent = '›';
  nextBtn.disabled = ratingsPage >= totalPages;
  nextBtn.onclick = () => {
    if (ratingsPage < totalPages) {
      ratingsPage++;
      renderRatingsPage();
    }
  };
  container.appendChild(nextBtn);
}

function renderRatingsPage() {
  const tbody = document.getElementById('table-ratings');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!ratingsRows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="14" class="empty-cell">No ratings found for this date range.</td>`;
    tbody.appendChild(tr);
    return;
  }

  const start = (ratingsPage - 1) * RATINGS_PAGE_SIZE;
  const end = start + RATINGS_PAGE_SIZE;
  const maxRows = MAX_PAGES * RATINGS_PAGE_SIZE;
  const dataToShow = ratingsRows.slice(0, maxRows);
  const pageRows = dataToShow.slice(start, end);

  pageRows.forEach((r) => {
    const scores = [];
    for (let i = 1; i <= 10; i++) {
      scores.push(r[`q${i}`] || 0);
    }
    const avg = (scores.reduce((a, b) => a + b, 0) / 10).toFixed(2);

    const tr = document.createElement('tr');
    const labels = [
      'Submitted',
      'Session ID',
      ...Array.from({ length: 10 }, (_, i) => `Q${i + 1}`),
      'Avg',
      'Comment',
    ];
    const values = [
      r.submitted_at ? formatTs(r.submitted_at) : '-',
      r.session_id,
      ...scores.map((v) => v || '-'),
      avg,
      (r.comment || '').substring(0, 240),
    ];

    values.forEach((value, idx) => {
      const td = document.createElement('td');
      td.dataset.label = labels[idx];
      td.textContent = value;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  renderRatingsPagination();
}

async function loadRatings(params = {}) {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);

  try {
    const res = await fetch(`/api/admin/ratings?${qs.toString()}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let data = await res.json();
    // Use dummy ratings if backend returns none, for pagination testing
    if (!data || !data.length) {
      data = makeDummyRatings();
    }
    ratingsRows = data;
    ratingsPage = 1;
    renderRatingsPage();
  } catch (e) {
    console.error('loadRatings error', e);
    // On error, also fall back to dummy data so you can still test UI
    ratingsRows = makeDummyRatings();
    ratingsPage = 1;
    renderRatingsPage();
    showToast('Failed to load ratings. Showing dummy data.', 'error');
  }
}

async function fetchMetricsOnce() {
  try {
    const res = await fetch('/api/admin/metrics', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    updateKpis(payload);
    updateRatingsSummary(payload.rating_means || {});

    let ongoing = payload.ongoing_sessions || [];
    // Use dummy ongoing sessions if backend returns none, for pagination testing
    if (!ongoing.length) {
      ongoing = makeDummyOngoingSessions();
    }
    renderOngoingTable(ongoing);
  } catch (e) {
    console.error('fetchMetricsOnce error', e);
    // On error, fall back to dummy ongoing data
    renderOngoingTable(makeDummyOngoingSessions());
  }
}

let metricsPollTimer = null;

function startHttpPolling() {
  if (metricsPollTimer) return;
  fetchMetricsOnce();
  metricsPollTimer = setInterval(fetchMetricsOnce, 5000);
}

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${window.location.host}/ws/admin`;
  let ws;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        updateKpis(payload);
        updateRatingsSummary(payload.rating_means || {});
        renderOngoingTable(payload.ongoing_sessions || []);
      } catch (e) {
        console.error('WS message parse error', e);
      }
    };

    ws.onclose = () => {
      console.log('WS closed, fallback to HTTP polling');
      startHttpPolling();
    };

    ws.onerror = () => {
      console.error('WS error, fallback to HTTP polling');
      startHttpPolling();
    };
  }

  connect();
}

document.addEventListener('DOMContentLoaded', () => {
  initWebSocket();
  loadRatings({});

  const ongoingForm = document.getElementById('ongoing-filter-form');
  if (ongoingForm) {
    ongoingForm.addEventListener('change', () => {
      applyOngoingFilter();
    });
  }

  const ratingsForm = document.getElementById('ratings-filter-form');
  if (ratingsForm) {
    const onChange = () => {
      const from = ratingsForm.elements.from?.value || null;
      const to = ratingsForm.elements.to?.value || null;
      loadRatings({ from, to });
    };
    ratingsForm.addEventListener('change', onChange);
    ratingsForm.addEventListener('input', onChange);
  }
});

// ---------- DUMMY DATA HELPERS FOR PAGINATION TESTING ----------

function makeDummyOngoingSessions(count = 25) {
  const now = Math.floor(Date.now() / 1000);
  const statuses = ['awaiting_insertion', 'inserting', 'active'];
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push({
      id: i,
      mac_address: `AA:BB:CC:DD:EE:${String(i).padStart(2, '0')}`,
      ip_address: `192.168.1.${i}`,
      status: statuses[i % statuses.length],
      bottles_inserted: (i % 7) + 1,
      seconds_earned: ((i % 7) + 1) * 120,
      session_end: now + (i * 60),
      updated_at: now - (i * 15),
    });
  }
  return rows;
}

function makeDummyRatings(count = 35) {
  const now = Math.floor(Date.now() / 1000);
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const baseScore = (i % 5) + 1;
    const row = {
      session_id: i,
      submitted_at: now - i * 3600,
      comment: `Dummy review #${i} - this is sample feedback to test pagination.`,
    };
    for (let q = 1; q <= 10; q++) {
      row[`q${q}`] = ((baseScore + q) % 5) + 1;
    }
    rows.push(row);
  }
  return rows;
}