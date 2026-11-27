(function () {
  const storageKey = 'dub-theme';
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  function currentTheme() {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') return saved;
    return media.matches ? 'dark' : 'light';
  }

  function applyTheme(theme, persist) {
    root.setAttribute('data-theme', theme);
    if (persist) localStorage.setItem(storageKey, theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
      btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
      btn.setAttribute('aria-pressed', String(theme === 'dark'));
    }
  }

  const saved = localStorage.getItem(storageKey);
  if (saved === 'light' || saved === 'dark') {
    root.setAttribute('data-theme', saved);
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(currentTheme(), false);
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', () => {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        applyTheme(next, true);
      });
    }
  });
})();
