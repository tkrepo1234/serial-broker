/*
 * An arrow at the top of the navigation, shown once the navigation has been scrolled.
 *
 * The sidebar scrolls on its own, and its scrollbar is easy to miss: on a long page - the
 * application API lists every method - the reader ends up far down the list with no sign that
 * anything is above, and no obvious way back. The arrow appears as soon as the navigation is
 * scrolled at all, says where the reader is, and takes them back to the top when clicked.
 *
 * The theme's own markup is left alone: this adds one element and one listener, and does nothing
 * at all if the theme ever renames what it looks for.
 */
(() => {
  'use strict';

  /** Below this the arrow would only cover the first entry it is meant to help reach. */
  const SHOW_AFTER_PX = 24;

  function install() {
    // `.wy-side-scroll` is the element that scrolls; `.wy-nav-side` is the fixed frame around it,
    // which is what the arrow is positioned against so it stays put while the list moves.
    const scroller = document.querySelector('.wy-side-scroll');
    const frame = document.querySelector('.wy-nav-side');
    if (scroller === null || frame === null) {
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'serial-broker-to-top';
    button.setAttribute('aria-label', 'Back to the top of the navigation');
    button.title = 'Back to the top of the navigation';
    button.hidden = true;
    // Drawn rather than written: a character would follow the font and be read out by a screen
    // reader as punctuation. `aria-hidden` leaves the label above as the only thing announced.
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M12 5.5 5 13h4.2v5.5h5.6V13H19z" /></svg>';

    button.addEventListener('click', () => {
      // A reader who asked for less motion gets none: the jump is the point, not the animation.
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scroller.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    });

    frame.append(button);

    let shown = false;
    const update = () => {
      const should = scroller.scrollTop > SHOW_AFTER_PX;
      if (should !== shown) {
        shown = should;
        button.hidden = !should;
      }
    };

    // `passive`: this never cancels the scroll it is told about.
    scroller.addEventListener('scroll', update, { passive: true });
    update();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
