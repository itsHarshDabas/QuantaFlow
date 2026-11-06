// Sets the theme before first paint so the page never flashes the wrong colors.
// Kept as a file, not an inline script, so a strict Content-Security-Policy still allows it.
(() => {
  let stored = null;
  try {
    stored = localStorage.getItem("qf.theme");
  } catch {
    // Storage can be blocked. Follow the system setting instead.
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const dark = stored === "dark" || (stored !== "light" && prefersDark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
