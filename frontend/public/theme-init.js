// Applies the saved theme before the first paint so dark mode never flashes white.
// Kept as a file (not inline) because the CSP allows scripts from 'self' only.
;(function () {
  var stored = null
  try {
    stored = localStorage.getItem('shri-theme')
  } catch (e) {
    stored = null
  }
  var dark = stored === 'dark' || (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) document.documentElement.classList.add('dark')
})()
