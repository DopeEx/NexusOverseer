// User Guide tab: renders the shared guide (guide-content.js) once.

let rendered = false;

export function initGuideTab() {
  if (rendered || !globalThis.NX_renderGuide) return;
  globalThis.NX_renderGuide(document.getElementById('guide-content'));
  rendered = true;
}
