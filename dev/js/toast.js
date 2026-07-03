// =====================================================================
// Toast notifications
//
// Small, non-intrusive popups anchored top-right, just under the topbar.
// Each one auto-dismisses after `duration` ms, or immediately if the user
// clicks its close (✕) button. Meant for things worth a heads-up without
// interrupting whatever the user is doing (unlike the settings modal's
// error/info banners, which sit inline and require attention).
//
// Only ever fed hardcoded, developer-written strings (never raw user or
// model content), so title/body are set via textContent throughout --
// there's no HTML injection surface here, but this also means callers
// can't sneak in markup, which is intentional: keep toasts short and plain.
// =====================================================================

const TOAST_DEFAULT_DURATION_MS = 7000;

// showToast({ type: 'info'|'error', title, body, duration }) -> the toast's
// DOM element (in case a caller ever wants to dismiss it early itself).
function showToast(opts){
  const { type = 'info', title = '', body = '', duration = TOAST_DEFAULT_DURATION_MS } = opts || {};
  const container = document.getElementById('toastContainer');
  if(!container) return null;

  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' toast-error' : '');

  const content = document.createElement('div');
  content.className = 'toast-content';
  if(title){
    const titleEl = document.createElement('div');
    titleEl.className = 'toast-title';
    titleEl.textContent = title;
    content.appendChild(titleEl);
  }
  if(body){
    const bodyEl = document.createElement('div');
    bodyEl.className = 'toast-body';
    bodyEl.textContent = body;
    content.appendChild(bodyEl);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.textContent = '✕';

  el.appendChild(content);
  el.appendChild(closeBtn);
  container.appendChild(el);

  const timer = setTimeout(() => dismissToast(el), duration);
  // Manual close should cancel the pending auto-dismiss, otherwise it'd
  // harmlessly fire a second time against an already-removed element, not
  // dangerous, just needless work.
  closeBtn.onclick = () => { clearTimeout(timer); dismissToast(el); };

  return el;
}

// Fades a toast out, then removes it from the DOM once the transition ends.
function dismissToast(el){
  if(!el || !el.parentElement) return;
  el.classList.add('toast-hide');
  setTimeout(() => el.remove(), 200);
}
