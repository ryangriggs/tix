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

    fetch(window.location.href, { headers: { 'Accept': 'text/html' } })
      .then(r => r.text())
      .then(html => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const newList = doc.getElementById('ticket-list');
        if (newList) list.replaceWith(newList);
      })
      .catch(() => { /* network error — ignore */ });
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
// PWA — register service worker
// ============================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* SW not critical */ });
}
