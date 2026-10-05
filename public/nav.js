// Phone menu (below 900px): the same <nav> as the laptop bar, slid in from the right under the top bar.
// The laptop bar is untouched; this only toggles .menu-open, aria-expanded, inert and focus. Plain browser script.
(() => {
  const phone = matchMedia('(max-width: 899px)');
  const root = document.documentElement, btn = document.querySelector('.burger'), nav = document.getElementById('nav'), scrim = document.querySelector('.scrim');
  if (!btn || !nav) return;
  const links = [...nav.querySelectorAll('a')];
  links.forEach((a, i) => a.style.setProperty('--i', i)); // stagger order for the slide-in
  const isOpen = () => root.classList.contains('menu-open');
  let later = 0;
  // Closed on a phone = inert, set once the slide-out has finished so it stays visible while it animates.
  const settle = () => { clearTimeout(later); nav.inert = phone.matches && !isOpen(); };

  function open() {
    if (isOpen() || !phone.matches) return;
    clearTimeout(later);
    nav.inert = false;
    root.classList.add('menu-open');
    btn.setAttribute('aria-expanded', 'true');
    (nav.querySelector('[aria-current="page"]') ?? links[0]).focus({ preventScroll: true });
  }
  function close(returnFocus = true) {
    if (!isOpen()) return;
    root.classList.remove('menu-open');
    btn.setAttribute('aria-expanded', 'false');
    if (returnFocus && phone.matches) btn.focus({ preventScroll: true });
    later = setTimeout(settle, 450); // fallback when there is no transition (reduced motion)
  }

  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  scrim?.addEventListener('click', () => close());
  nav.addEventListener('click', e => { if (e.target.closest('a')) close(); });
  nav.addEventListener('transitionend', e => { if (e.target === nav && e.propertyName === 'transform' && !isOpen()) settle(); });
  addEventListener('hashchange', () => close(false)); // the router moves focus to the new page
  document.addEventListener('keydown', e => {
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // focus stays on the menu button and the links while the menu is open
    const items = [btn, ...links], i = items.indexOf(document.activeElement);
    e.preventDefault();
    items[i < 0 ? 1 : (i + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
  });
  phone.addEventListener('change', () => { if (!phone.matches) close(false); settle(); });
  settle();
})();
