'use strict';

// ============================================================
// Timestamp localisation — display in browser's local time/locale
// ============================================================

function fmtTs(ts, fmt) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  if (fmt === 'full') return d.toLocaleString();
  if (fmt === 'date') return d.toLocaleDateString();
  // default: relative for recent, date for older
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60)     return 'just now';
  if (diff < 3600)   return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

function localiseTimestamps(root) {
  (root || document).querySelectorAll('[data-ts]').forEach(el => {
    const ts = parseInt(el.dataset.ts, 10);
    if (!ts) return;
    el.textContent = fmtTs(ts, el.dataset.fmt);
    // For ticket-list rows: update the hover title with full date + optional actor
    if ('actor' in el.dataset) {
      el.title = fmtTs(ts, 'full') + (el.dataset.actor ? ` · by ${el.dataset.actor}` : '');
    }
  });
}

document.addEventListener('DOMContentLoaded', () => localiseTimestamps());

// ============================================================
// Server-Sent Events — real-time updates
// ============================================================

(function initSSE() {
  // Only connect if the user is logged in (page has a main element with real content)
  if (!document.querySelector('main')) return;

  // Don't open SSE on auth pages
  if (window.location.pathname.startsWith('/auth')) return;

  let evtSource;
  let retryDelay = 3000;

  function connect() {
    evtSource = new EventSource('/events');

    evtSource.addEventListener('message', (e) => {
      try {
        const event = JSON.parse(e.data);
        handleEvent(event);
      } catch (_) { /* ignore malformed */ }
    });

    evtSource.addEventListener('open', () => {
      retryDelay = 3000; // reset backoff on successful connect
    });

    evtSource.addEventListener('error', () => {
      evtSource.close();
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000); // exponential backoff
    });
  }

  function handleEvent(event) {
    const path = window.location.pathname;

    if (event.type === 'ticket_created' || event.type === 'ticket_updated') {
      if (path === '/tickets' || path === '/') {
        // Refresh the ticket list silently
        refreshTicketList();
      }
    }

    if (event.type === 'comment_added' && path === `/tickets/${event.ticketId}`) {
      // New comment on the ticket we're viewing — fetch and append it
      fetchAndAppendComment(event.ticketId, event.commentId);
    }

    if (event.type === 'ticket_updated' && path === `/tickets/${event.ticketId}`) {
      const f  = event.field;
      const _e = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      if (f === 'status' && event.value) {
        const sv = event.value;
        document.querySelectorAll('#status-pills .pill-btn').forEach(b =>
          b.classList.toggle('pill-active', b.dataset.status === sv));
        const badge = document.getElementById('badge-status');
        if (badge) { badge.className = `badge badge-status-${sv}`; badge.textContent = sv.replace(/_/g, ' '); }

      } else if (f === 'priority' && event.value) {
        const pv = event.value;
        document.querySelectorAll('#priority-pills .pill-btn').forEach(b =>
          b.classList.toggle('pill-active', b.dataset.priority === pv));
        const badge = document.getElementById('badge-priority');
        if (badge) { badge.className = `badge badge-priority-${pv}`; badge.textContent = pv; }

      } else if (f === 'subject' && event.value) {
        document.title = document.title.replace(/—.*/, `\u2014 ${event.value}`);
        const input = document.getElementById('subject-input');
        // Don't clobber an in-progress edit
        if (input && input.dataset.dirty !== 'true') input.value = event.value;
        const h1 = document.querySelector('.ticket-title');
        if (h1) h1.textContent = event.value;

      } else if (f === 'due_date') {
        const meta = document.getElementById('due-date-meta');
        if (meta) {
          if (event.value) {
            const dtEl = document.getElementById('due-date-text');
            dtEl.textContent = fmtTs(event.value, 'date');
            dtEl.dataset.ts = event.value;
            const overdue = event.value < Math.floor(Date.now() / 1000);
            meta.className = 'meta-item' + (overdue ? ' overdue' : '');
            meta.style.display = '';
            const dateInput = document.querySelector('#due-date-form [name="due_date"]');
            if (dateInput) dateInput.value = new Date(event.value * 1000).toISOString().slice(0, 10);
          } else {
            meta.style.display = 'none';
          }
        }

      } else if (f === 'org') {
        const input = document.getElementById('org-name-input');
        if (input) input.value = event.value || '';

      } else if (f === 'party_added' && event.party) {
        const list = document.getElementById('party-list');
        if (list && !list.querySelector(`[data-user-id="${event.party.userId}"]`)) {
          const canManage     = list.dataset.canManage === 'true';
          const currentUserId = parseInt(list.dataset.currentUserId || '0', 10);
          const p = event.party;
          const nameHtml = p.name
            ? `<span class="party-name">${_e(p.name)}</span><a href="mailto:${_e(p.email)}" class="party-email-link">${_e(p.email)}</a>`
            : `<span class="party-name">${_e(p.email)}</span>`;
          const orgHtml    = p.orgName ? `<span class="party-org">[${_e(p.orgName)}]</span>` : '';
          const removeHtml = canManage && p.userId !== currentUserId
            ? `<button type="button" class="btn-icon remove-party-btn" data-user-id="${p.userId}" title="Remove">×</button>`
            : '';
          list.insertAdjacentHTML('beforeend',
            `<li class="party-item" data-user-id="${p.userId}">
               <div class="party-info">${nameHtml}${orgHtml}</div>
               <span class="badge badge-role">${_e(p.role)}</span>
               ${removeHtml}
             </li>`);
        }

      } else if (f === 'party_removed' && event.userId) {
        document.querySelector(`#party-list [data-user-id="${event.userId}"]`)?.remove();
      }
    }
  }

  // Reload the ticket list by refetching the current URL
  function refreshTicketList() {
    const list = document.getElementById('ticket-list');
    if (!list) return;

    // Show a loading overlay over the list
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;background:rgba(255,255,255,.7);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;z-index:10;border-radius:4px';
    overlay.innerHTML = '<div style="width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#2563eb;border-radius:50%;animation:spin 0.7s linear infinite"></div><span style="font-size:.8rem;color:#6b7280">Loading…</span>';
    const wrapper = list.parentElement;
    const prevPosition = getComputedStyle(wrapper).position;
    if (prevPosition === 'static') wrapper.style.position = 'relative';
    wrapper.appendChild(overlay);

    fetch(window.location.href, { headers: { 'Accept': 'text/html' } })
      .then(r => r.text())
      .then(html => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const newList = doc.getElementById('ticket-list');
        if (newList) { list.replaceWith(newList); localiseTimestamps(newList); }
      })
      .catch(() => { /* network error — ignore */ })
      .finally(() => {
        overlay.remove();
        if (prevPosition === 'static') wrapper.style.position = '';
      });
  }

  // Fetch a specific comment HTML and append it to the comment thread
  function fetchAndAppendComment(ticketId, commentId) {
    // We refetch the whole ticket page and extract the new comment
    fetch(`/tickets/${ticketId}`, { headers: { 'Accept': 'text/html' } })
      .then(r => r.text())
      .then(html => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const newComment = doc.getElementById(`comment-${commentId}`);
        if (!newComment) return;

        const existing = document.getElementById(`comment-${commentId}`);
        if (existing) return; // already showing

        const comments = document.getElementById('comments');
        if (comments) {
          // Insert before the "Activity" heading's next sibling
          const heading = comments.querySelector('.section-title');
          if (heading) {
            heading.after(newComment);
          } else {
            comments.appendChild(newComment);
          }
          newComment.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          localiseTimestamps(newComment);
        }
      })
      .catch(() => { });
  }

  function showBanner(msg) {
    let banner = document.getElementById('update-banner');
    if (banner) return; // already showing
    banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.style.cssText = 'position:fixed;top:56px;left:0;right:0;background:#2563eb;color:#fff;text-align:center;padding:.5rem;font-size:.875rem;cursor:pointer;z-index:200';
    banner.textContent = msg + ' Click to refresh.';
    banner.addEventListener('click', () => window.location.reload());
    document.body.prepend(banner);
  }

  connect();

  // Release the SSE connection slot before the browser opens the next page.
  // Without this, the old connection holds one of HTTP/1.1's 6 per-origin slots,
  // starving the new page's requests and causing 30+ second freezes on mobile.
  window.addEventListener('pagehide', () => {
    if (evtSource) { evtSource.close(); evtSource = null; }
  });

  // iOS Safari restores pages from the back-forward cache (bfcache) via pageshow.
  // The SSE connection was closed on pagehide, so we must reconnect here.
  window.addEventListener('pageshow', e => {
    if (e.persisted && !evtSource) connect();
  });
})();

// ============================================================
// Autocomplete — reusable dropdown component
// ============================================================

/**
 * createAutocomplete(inputEl, options)
 *   fetchUrl(q)    — returns URL string for the given query
 *   formatItem(i)  — returns HTML string for a suggestion row
 *   onSelect(i)    — called when a suggestion is chosen
 *   minChars       — min chars before triggering (default 1)
 *   allowFreeform  — if true, free-typed text is preserved on blur
 */
function createAutocomplete(inputEl, { fetchUrl, formatItem, onSelect, minChars = 1, showOnFocus = false } = {}) {
  const wrap = inputEl.parentElement;
  if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

  const dropdown = document.createElement('ul');
  dropdown.className = 'autocomplete-dropdown';
  dropdown.style.cssText = [
    'display:none', 'position:absolute', 'z-index:1000', 'list-style:none',
    'margin:0', 'padding:0', 'background:#fff', 'border:1px solid #d1d5db',
    'border-radius:4px', 'max-height:240px', 'overflow-y:auto',
    'min-width:100%', 'box-shadow:0 4px 6px rgba(0,0,0,.08)', 'top:100%', 'left:0',
  ].join(';');
  wrap.appendChild(dropdown);

  let activeIdx = -1;
  let currentItems = [];
  let debounceTimer = null;

  function render(items) {
    currentItems = items;
    activeIdx = -1;
    dropdown.innerHTML = '';
    if (!items.length) { dropdown.style.display = 'none'; return; }
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.style.cssText = 'padding:.4rem .75rem;cursor:pointer;font-size:.875rem;white-space:nowrap;';
      li.innerHTML = formatItem(item);
      li.addEventListener('mouseenter', () => setActive(i));
      li.addEventListener('mousedown', e => { e.preventDefault(); choose(item); });
      dropdown.appendChild(li);
    });
    dropdown.style.display = 'block';
  }

  function setActive(i) {
    activeIdx = i;
    Array.from(dropdown.children).forEach((li, idx) => {
      li.style.background = idx === i ? '#eff6ff' : '';
    });
  }

  function choose(item) {
    onSelect(item);
    dropdown.style.display = 'none';
    currentItems = [];
    activeIdx = -1;
  }

  function close() { dropdown.style.display = 'none'; activeIdx = -1; }

  function doFetch(q) {
    fetch(fetchUrl(q), { headers: { Accept: 'application/json' } })
      .then(r => r.ok ? r.json() : [])
      .then(render)
      .catch(close);
  }

  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim();
    if (q.length < minChars) { close(); return; }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => doFetch(q), 150);
  });

  if (showOnFocus) {
    inputEl.addEventListener('focus', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => doFetch(inputEl.value.trim()), 50);
    });
  }

  inputEl.addEventListener('keydown', e => {
    if (!currentItems.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(activeIdx + 1, currentItems.length - 1)); }
    else if (e.key === 'ArrowUp')  { e.preventDefault(); setActive(Math.max(activeIdx - 1, 0)); }
    else if (e.key === 'Enter' && activeIdx >= 0) { e.preventDefault(); choose(currentItems[activeIdx]); }
    else if (e.key === 'Escape') close();
  });

  inputEl.addEventListener('blur', () => setTimeout(close, 150));
}

// ============================================================
// Global keyboard shortcuts
// ============================================================
document.addEventListener('keydown', e => {
  // Ctrl+N (or Cmd+N on Mac) — new ticket, unless focus is in an editable field
  if ((e.ctrlKey || e.metaKey) && e.key === 'n' && !e.shiftKey && !e.altKey) {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.activeElement?.isContentEditable) return;
    e.preventDefault();
    window.location.href = '/tickets/new';
  }
});

// ============================================================
// Navigation progress bar
// Gives immediate visual feedback on mobile when a page navigation
// is triggered — prevents the "frozen / did my tap register?" confusion.
// ============================================================
(function navProgress() {
  const bar = document.createElement('div');
  bar.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'height:3px', 'width:0',
    'background:var(--accent,#2563eb)', 'z-index:99999',
    'pointer-events:none', 'transition:none', 'display:none',
  ].join(';');
  document.documentElement.appendChild(bar);

  function show() {
    bar.style.display = 'block';
    bar.style.transition = 'none';
    bar.style.width = '0';
    bar.offsetWidth; // force reflow so transition starts from 0
    bar.style.transition = 'width 25s cubic-bezier(0.1, 0.05, 0, 1)';
    bar.style.width = '92%';
  }

  // Show on link clicks that would navigate this tab
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#') || href.startsWith('javascript:')) return;
    if (a.target === '_blank') return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    show();
  }, { capture: true });

  // Show on form submits that navigate (forms with action/method; AJAX forms have neither)
  document.addEventListener('submit', e => {
    const form = e.target;
    if (!form.getAttribute('action') && !form.getAttribute('method')) return;
    show();
  }, { capture: true });

  // Hide when bfcache restores a page (pageshow fires on back-nav)
  window.addEventListener('pageshow', () => { bar.style.display = 'none'; });
})();

// ============================================================
// PWA — register service worker
// ============================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* SW not critical */ });
}
