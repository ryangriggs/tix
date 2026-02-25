'use strict';

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
      // Status/priority changed — reload the page to reflect sidebar changes
      // (lightweight: only reload if the user isn't mid-typing)
      const editor = document.getElementById('comment-editor');
      if (!editor || editor.textContent.trim() === '') {
        window.location.reload();
      } else {
        showBanner('This ticket was updated. Refresh to see the latest.');
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
        if (newList) list.replaceWith(newList);
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
// PWA — register service worker
// ============================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* SW not critical */ });
}
