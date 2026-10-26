/*
 * Theme before first paint: a flash of the wrong paper is a layout lie.
 *
 * Loaded as a blocking same-origin script, not inline: the application's CSP has no
 * `unsafe-inline` (ARCHITECTURE.md §12.8, §15.3), and a theme flash is not a good enough
 * reason to open the one hole a strict CSP exists to close.
 */
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('book.theme');
  } catch (error) {
    theme = null;
  }
  if (theme !== 'day' && theme !== 'night') {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day';
  }
  document.documentElement.setAttribute('data-theme', theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'night' ? '#0B0C0D' : '#CFD3D2');
})();
