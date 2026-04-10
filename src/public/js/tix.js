'use strict';

// ============================================================
// Auto-select text on focus — all inputs and textareas
// ============================================================
document.addEventListener('focusin', e => {
  const el = e.target;
  if (el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && /^(text|email|number|url|search|date|time)$/.test(el.type || 'text'))) {
    el.select();
  }
});

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
// Ticket list — manual refresh
// ============================================================

// Reload the ticket list by refetching the current URL and swapping in the new list.
// Called by the Refresh button; also available globally for external callers.
window.refreshTicketList = function refreshTicketList() {
  const list = document.getElementById('ticket-list');
  if (!list) return;

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
};

// ============================================================
// Ticket detail — background poll for new activity
// Polls /api/tickets/:id/poll every 30s while the page is visible.
// Never navigates away — only shows a "new activity" banner if
// the comment count or updated_at changes since page load.
// ============================================================

(function initTicketPolling() {
  const ticketEl = document.getElementById('ticket-detail');
  if (!ticketEl) return;

  const ticketId      = ticketEl.dataset.ticketId;
  const loadedCount   = parseInt(ticketEl.dataset.commentCount  || '0', 10);
  const loadedUpdated = parseInt(ticketEl.dataset.updatedAt     || '0', 10);
  if (!ticketId) return;

  let bannerShown = false;

  function showActivityBanner() {
    if (bannerShown) return;
    bannerShown = true;
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:56px;left:0;right:0;background:#2563eb;color:#fff;text-align:center;padding:.5rem 1rem;font-size:.875rem;cursor:pointer;z-index:200;display:flex;align-items:center;justify-content:center;gap:.75rem';
    banner.innerHTML = '<span>New activity on this ticket.</span><button style="background:rgba(255,255,255,.2);border:none;color:#fff;border-radius:4px;padding:.2rem .6rem;cursor:pointer;font-size:.8rem">Refresh</button>';
    banner.querySelector('button').addEventListener('click', () => window.location.reload());
    banner.addEventListener('click', e => { if (e.target === banner) window.location.reload(); });
    document.body.prepend(banner);
  }

  function poll() {
    // Don't bother if the tab is hidden
    if (document.visibilityState === 'hidden') return;

    fetch(`/api/tickets/${encodeURIComponent(ticketId)}/poll`, {
      headers: { Accept: 'application/json' },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        if (data.comment_count > loadedCount || data.updated_at > loadedUpdated) {
          showActivityBanner();
        }
      })
      .catch(() => { /* ignore network errors */ });
  }

  // Poll every 30 seconds
  const pollInterval = setInterval(poll, 30_000);

  // Stop polling when navigating away
  window.addEventListener('pagehide', () => clearInterval(pollInterval));
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
  // Inside a showModal() dialog everything outside the dialog is inert, so we must
  // append the dropdown inside the dialog itself.
  // Outside a dialog we append to document.body and use position:absolute with
  // document coordinates — this scrolls naturally with the page and needs no
  // viewport corrections, avoiding all mobile browser fixed-positioning quirks.
  const dialog   = inputEl.closest('dialog');
  const inDialog = !!dialog;
  const host     = dialog || document.body;

  const dropdown = document.createElement('ul');
  dropdown.className = 'autocomplete-dropdown';
  dropdown.style.cssText = [
    inDialog ? 'position:fixed' : 'position:absolute',
    'display:none', 'z-index:9999', 'list-style:none',
    'margin:0', 'padding:0', 'background:#fff', 'border:1px solid #d1d5db',
    'border-radius:4px', 'overflow-y:auto',
    'box-shadow:0 4px 6px rgba(0,0,0,.08)',
  ].join(';');
  host.appendChild(dropdown);

  // Suppress blur-close while the user is interacting with the dropdown
  let suppressBlur = false;

  function isOpen()       { return dropdown.style.display !== 'none'; }
  function openDropdown()  { dropdown.style.display = 'block'; }
  function closeDropdown() { dropdown.style.display = 'none'; }

  function positionDropdown() {
    const r        = inputEl.getBoundingClientRect();
    const vheight  = window.innerHeight;
    const spaceBelow = vheight - r.bottom;
    const spaceAbove = r.top;
    const maxH = 240;

    // For position:absolute we work in document coordinates (add scroll offset).
    // For position:fixed inside a dialog we use viewport coordinates directly.
    const scrollY = inDialog ? 0 : (window.scrollY || 0);
    const scrollX = inDialog ? 0 : (window.scrollX || 0);

    if (spaceBelow >= Math.min(maxH, 120) || spaceBelow >= spaceAbove) {
      // Enough room below — anchor top edge to input bottom
      dropdown.style.top       = (r.bottom + scrollY) + 'px';
      dropdown.style.maxHeight = Math.min(maxH, spaceBelow - 6) + 'px';
    } else {
      // Flip above — anchor bottom edge to input top.
      // Set maxHeight first so the browser knows the height cap, then read
      // offsetHeight (actual rendered height, which shrinks as items filter)
      // to pin the bottom edge flush with the input regardless of item count.
      dropdown.style.maxHeight = Math.min(maxH, spaceAbove - 6) + 'px';
      dropdown.style.top       = (r.top + scrollY - dropdown.offsetHeight) + 'px';
    }
    dropdown.style.left  = (r.left + scrollX) + 'px';
    dropdown.style.width = r.width + 'px';
  }

  // position:absolute scrolls with the page — no scroll listener needed.
  // Reposition on resize in case the layout reflows (e.g. orientation change).
  // Inside a dialog (position:fixed) also reposition on scroll.
  const reposition = () => { if (isOpen()) positionDropdown(); };
  window.addEventListener('resize', reposition, { passive: true });
  if (inDialog) {
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
  }

  let activeIdx = -1;
  let currentItems = [];
  let debounceTimer = null;

  // Set suppressBlur when the user presses on the dropdown so the blur handler
  // (which fires before click) doesn't close it before choose() runs.
  // Do NOT call e.preventDefault() here — cancelling pointerdown suppresses click.
  dropdown.addEventListener('pointerdown',   () => { suppressBlur = true; });
  dropdown.addEventListener('pointerup',     () => { suppressBlur = false; });
  dropdown.addEventListener('pointercancel', () => { suppressBlur = false; });

  function render(items) {
    currentItems = items;
    activeIdx = -1;
    dropdown.innerHTML = '';
    if (!items.length) { closeDropdown(); return; }
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.style.cssText = 'padding:.4rem .75rem;cursor:pointer;font-size:.875rem;white-space:nowrap;';
      li.innerHTML = formatItem(item);
      li.addEventListener('mouseenter', () => setActive(i));
      li.addEventListener('click', () => choose(item));
      dropdown.appendChild(li);
    });
    openDropdown();      // open first so offsetHeight is measurable
    positionDropdown();  // then position using actual rendered height
  }

  function setActive(i) {
    activeIdx = i;
    Array.from(dropdown.children).forEach((li, idx) => {
      li.style.background = idx === i ? '#eff6ff' : '';
    });
  }

  function choose(item) {
    onSelect(item);
    closeDropdown();
    currentItems = [];
    activeIdx = -1;
  }

  function close() { closeDropdown(); activeIdx = -1; }

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

  inputEl.addEventListener('blur', () => { if (!suppressBlur) setTimeout(close, 150); });
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
// Button spinner — disable button and show spinner while waiting
// spinButton / restoreButton are global so detail.ejs AJAX handlers can use them.
// ============================================================
window.spinButton = function(btn) {
  if (!btn || btn._spinning) return;
  btn._spinning    = true;
  btn._origHTML    = btn.innerHTML;
  btn._origDisabled = btn.disabled;
  btn.disabled     = true;
  btn.innerHTML    = '<span class="btn-spinner"></span>';
};

window.restoreButton = function(btn) {
  if (!btn || !btn._spinning) return;
  btn.innerHTML = btn._origHTML;
  btn.disabled  = btn._origDisabled;
  btn._spinning = false;
};

(function initSpinnerListeners() {
  // Track the most-recently clicked button so JS-triggered submits (e.g. pill
  // buttons that call form.submit() directly) can still find their trigger.
  let _lastBtn = null, _lastBtnTs = 0;
  document.addEventListener('click', e => {
    const btn = e.target.closest('button, [type=submit]');
    if (btn) { _lastBtn = btn; _lastBtnTs = Date.now(); }
  }, { capture: true });

  // Spin the triggering button on full-page form submissions.
  // AJAX handlers call e.preventDefault() first, so e.defaultPrevented filters them out.
  document.addEventListener('submit', e => {
    if (e.defaultPrevented) return;
    const recent = Date.now() - _lastBtnTs < 800;
    const btn = e.submitter
             || (recent ? _lastBtn : null)
             || e.target.querySelector('[type=submit]');
    if (btn) window.spinButton(btn);
  });

  // Restore any frozen buttons when the browser restores a page from bfcache
  // (e.g. pressing Back — the page is already rendered with spinners showing).
  window.addEventListener('pageshow', ev => {
    if (!ev.persisted) return;
    document.querySelectorAll('button[disabled]').forEach(btn => {
      if (btn._origHTML !== undefined) window.restoreButton(btn);
    });
  });
})();

// ============================================================
// PWA — register service worker
// ============================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* SW not critical */ });
}

// ============================================================
// Attachment UI — staged file list + optional camera support
// ============================================================

function _escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let _cameraList = null;

function _normCameraLabel(raw, index, total) {
  if (!raw || !raw.trim()) return total === 1 ? 'Camera' : `Camera ${index + 1}`;

  // Android Chrome labels cameras like "camera2 0, facing back" or "camera2 1, facing front".
  // Extract the camera index and facing direction so every entry gets a unique label.
  const facingMatch = raw.match(/facing\s+(back|front|environment|user|external)/i);
  const numMatch    = raw.match(/\b(\d+)\b/);
  if (facingMatch) {
    const dir   = facingMatch[1].toLowerCase();
    const face  = (dir === 'front' || dir === 'user') ? 'Front' : 'Back';
    const num   = numMatch ? numMatch[1] : String(index);
    return `${face} Camera ${num}`;
  }

  // For non-Android labels (desktop, iOS) use the raw string — it's already descriptive
  return raw.trim();
}

async function _detectCameras() {
  if (_cameraList !== null) return _cameraList;
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return (_cameraList = []);
    const all  = await navigator.mediaDevices.enumerateDevices();
    const cams = all.filter(d => d.kind === 'videoinput');
    if (!cams.length) return (_cameraList = []);

    const hasRealIds = cams.some(d => d.deviceId && d.deviceId !== 'default');

    if (hasRealIds) {
      // Permission already granted — use specific deviceId constraints
      _cameraList = cams.map((d, i) => ({
        label:      _normCameraLabel(d.label, i, cams.length),
        constraint: { video: { deviceId: { exact: d.deviceId } } },
      }));
    } else {
      // No permission yet — deviceIds are all "" so use facingMode constraints.
      // This correctly opens back vs front camera on Android/iOS.
      if (cams.length === 1) {
        _cameraList = [{ label: 'Camera', constraint: { video: true } }];
      } else {
        // Most devices: index 0 = back, index 1 = front
        _cameraList = [
          { label: 'Back Camera',  constraint: { video: { facingMode: 'environment' } } },
          { label: 'Front Camera', constraint: { video: { facingMode: 'user' } } },
        ];
        // Extra cameras (ultrawide, telephoto, depth) — can't distinguish without IDs
        for (let i = 2; i < cams.length; i++) {
          _cameraList.push({ label: `Camera ${i + 1}`, constraint: { video: true } });
        }
      }
    }
  } catch (_) {
    _cameraList = [];
  }
  // Invalidate cache when permissions change so real deviceIds/labels load on next open
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { _cameraList = null; }, { once: true });
  return _cameraList;
}

function _buildCameraModal() {
  if (document.getElementById('camera-modal')) return;
  const el = document.createElement('div');
  el.id = 'camera-modal';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="camera-overlay" id="camera-overlay">
      <div class="camera-inner">
        <div class="camera-hdr">
          <span id="camera-modal-label">Take Photo</span>
          <button type="button" id="camera-modal-close" class="btn-icon" title="Close">×</button>
        </div>
        <video id="camera-video" autoplay playsinline muted></video>
        <canvas id="camera-canvas" style="display:none"></canvas>
        <div class="camera-ftr">
          <button type="button" id="camera-shutter" class="btn btn-primary">Capture</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.getElementById('camera-modal-close').addEventListener('click', _closeCameraModal);
  document.getElementById('camera-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) _closeCameraModal();
  });
}

let _cameraStream  = null;
let _cameraCaptureCb = null;

function _openCameraModal(constraint, label, onCapture) {
  _buildCameraModal();
  _cameraCaptureCb = onCapture;
  document.getElementById('camera-modal-label').textContent = label || 'Take Photo';
  document.getElementById('camera-modal').style.display = 'block';

  navigator.mediaDevices.getUserMedia(constraint)
    .then(stream => {
      _cameraStream = stream;
      document.getElementById('camera-video').srcObject = stream;
    })
    .catch(err => {
      alert('Camera unavailable: ' + err.message);
      _closeCameraModal();
    });

  // Replace shutter button to remove any previous listener
  const oldBtn = document.getElementById('camera-shutter');
  const newBtn = oldBtn.cloneNode(true);
  oldBtn.replaceWith(newBtn);
  newBtn.addEventListener('click', () => {
    const video  = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      _closeCameraModal();
      if (_cameraCaptureCb && blob) _cameraCaptureCb(blob);
    }, 'image/jpeg', 0.85);
  });
}

function _closeCameraModal() {
  if (_cameraStream) { _cameraStream.getTracks().forEach(t => t.stop()); _cameraStream = null; }
  const modal = document.getElementById('camera-modal');
  if (modal) modal.style.display = 'none';
  const video = document.getElementById('camera-video');
  if (video) video.srcObject = null;
}

/**
 * initAttachmentUI({ stageId, inputId, btnWrapperId, prefix })
 *   stageId      — id of the <div> that will show staged file rows
 *   inputId      — id of the hidden <input type="file" name="attachments" multiple>
 *   btnWrapperId — id of the <div> where the Attach button will be injected
 *   prefix       — unique string to namespace ids within this page
 */
function initAttachmentUI({ stageId, inputId, btnWrapperId, prefix }) {
  const stageEl = document.getElementById(stageId);
  const inputEl = document.getElementById(inputId);
  const btnWrap = document.getElementById(btnWrapperId);
  if (!stageEl || !inputEl || !btnWrap) return;

  let stagedFiles = []; // array of File objects
  let photoCount  = 0;

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function syncInput() {
    const dt = new DataTransfer();
    stagedFiles.forEach(f => dt.items.add(f));
    inputEl.files = dt.files;
  }

  function render() {
    stageEl.innerHTML = '';
    if (!stagedFiles.length) { stageEl.style.display = 'none'; return; }
    stageEl.style.display = '';
    stagedFiles.forEach((f, idx) => {
      const row = document.createElement('div');
      row.className = 'attach-file-row';
      row.innerHTML = `<span class="attach-file-name">${_escHtml(f.name)}</span>`
        + `<span class="attach-file-size">${fmtBytes(f.size)}</span>`
        + `<button type="button" class="btn-icon" title="Remove">×</button>`;
      row.querySelector('button').addEventListener('click', () => {
        stagedFiles.splice(idx, 1);
        syncInput();
        render();
      });
      stageEl.appendChild(row);
    });
  }

  function addFiles(list) {
    Array.from(list).forEach(f => stagedFiles.push(f));
    syncInput();
    render();
  }

  function addPhoto(blob) {
    photoCount++;
    addFiles([new File([blob], `photo ${photoCount}.jpg`, { type: 'image/jpeg' })]);
  }

  // Hidden file picker (separate from the DataTransfer-managed input)
  const picker = document.createElement('input');
  picker.type = 'file'; picker.multiple = true; picker.style.display = 'none';
  picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });
  document.body.appendChild(picker);

  stageEl.style.display = 'none';

  // Build button UI after camera detection
  _detectCameras().then(cameras => {
    if (!cameras.length) {
      // No cameras — plain Browse button
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn btn-secondary btn-sm';
      btn.textContent = 'Browse…';
      btn.addEventListener('click', () => picker.click());
      btnWrap.appendChild(btn);
    } else {
      // Cameras available — Attach ▾ dropdown
      const wrap   = document.createElement('div');
      wrap.className = 'attach-btn-wrap';

      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'btn btn-secondary btn-sm attach-toggle';
      toggle.innerHTML = 'Attach &#9662;';

      const menu = document.createElement('div');
      menu.className = 'attach-menu';

      const browseItem = document.createElement('button');
      browseItem.type = 'button'; browseItem.className = 'attach-menu-item';
      browseItem.textContent = 'Upload file…';
      browseItem.addEventListener('click', () => { menu.classList.remove('open'); picker.click(); });
      menu.appendChild(browseItem);

      // Camera items are built lazily on first dropdown open so we can probe
      // for camera permission first — this gives us real deviceIds and labels
      // for all cameras, including extras beyond just front/back.
      let camItemsReady = false;

      async function ensureCamItems() {
        if (camItemsReady) return;
        camItemsReady = true; // set early to prevent double-build on fast clicks
        try {
          // Brief permission probe — request then immediately stop the stream
          const s = await navigator.mediaDevices.getUserMedia({ video: true });
          s.getTracks().forEach(t => t.stop());
          _cameraList = null; // force re-enumerate now that permission is granted
        } catch (_) { /* permission denied — fall back to facingMode entries */ }
        const freshCams = await _detectCameras();
        freshCams.forEach(cam => {
          const item = document.createElement('button');
          item.type = 'button'; item.className = 'attach-menu-item';
          item.textContent = '\uD83D\uDCF7 ' + cam.label;
          item.addEventListener('click', () => {
            menu.classList.remove('open');
            _openCameraModal(cam.constraint, cam.label, blob => addPhoto(blob));
          });
          menu.appendChild(item);
        });
      }

      toggle.addEventListener('click', async e => {
        e.stopPropagation();
        if (!camItemsReady) await ensureCamItems();
        menu.classList.toggle('open');
      });
      document.addEventListener('click', () => menu.classList.remove('open'));

      wrap.appendChild(toggle);
      wrap.appendChild(menu);
      btnWrap.appendChild(wrap);
    }
  });
}
