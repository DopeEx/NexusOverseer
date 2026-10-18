// User Guide: a body-level overlay (opened from the "User Guide" sidebar link
// added by sidebar-inject.js) documenting the addon's features. Content and
// markup come from guide-content.js, styling from theme.css (both injected
// alongside this script), so it matches the dashboard's User Guide tab. Lives
// in <body> so React re-renders can't wipe it. No API calls.
//
// IIFE + re-run guard: Firefox can inject a content script twice into the same
// isolated world (extension reload into an open tab); top-level `const`s would
// then throw "redeclaration of const" and abort the whole script.
if (!window.__nxGuideView) {
window.__nxGuideView = true;
(function () {
const ext = (typeof browser !== 'undefined' ? browser : chrome);
const DASH_URL = ext.runtime.getURL('dashboard.html');

let overlay = null;
let onKey = null;
function closeGuide() {
  if (overlay) { overlay.remove(); overlay = null; }
  if (onKey) { document.removeEventListener('keydown', onKey); onKey = null; }
}

function openGuide() {
  if (overlay) { closeGuide(); return; }   // toggle
  overlay = document.createElement('div');
  overlay.className = 'nx-theme nx-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeGuide(); });

  const page = document.createElement('div');
  page.className = 'nx-overlay-page';
  const head = document.createElement('header');
  head.className = 'nx-overlay-head';
  head.innerHTML = '<div><h1>Nexus <span>Overseer</span>: User Guide</h1>' +
    '<p>How the addon works, feature by feature</p></div>';
  const link = document.createElement('a');
  link.className = 'nx-overlay-link';
  link.href = DASH_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Open dashboard';
  head.appendChild(link);
  page.appendChild(head);
  globalThis.NX_renderGuide?.(page);
  overlay.appendChild(page);

  const close = document.createElement('button');
  close.className = 'nx-overlay-close';
  close.type = 'button';
  close.textContent = '✕';
  close.title = 'Close (Esc)';
  close.addEventListener('click', closeGuide);
  overlay.appendChild(close);
  document.body.appendChild(overlay);
  onKey = e => { if (e.key === 'Escape') closeGuide(); };
  document.addEventListener('keydown', onKey);
}

document.addEventListener('click', e => {
  if (e.target.closest('[data-nexus-guide]')) { e.preventDefault(); openGuide(); }
});
})();
}
