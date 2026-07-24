// ============================================================================
//  devtools — the devtools_page entry: registers the "Fuaran" panel.
//
//  Registration is unconditional (a DevTools panel cannot be added lazily
//  after DevTools opens); the panel itself detects whether the inspected page
//  runs a Fuaran app in debug mode and renders its empty state otherwise.
// ============================================================================

chrome.devtools.panels.create('Fuaran', '', 'panel.html');
