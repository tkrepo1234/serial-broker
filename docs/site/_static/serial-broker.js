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
      // A smooth scroll ends after the last scroll event this listens to, so the arrow is asked
      // once more when the scrolling is over. `scrollend` is not in every browser this page is
      // read in, hence the timeout as well; both only ever hide it.
      scroller.addEventListener('scrollend', update, { once: true });
      setTimeout(update, 700);
    });

    frame.append(button);

    // The search box stays at the top of the list (see the stylesheet), and the arrow sits under
    // it. How far under is measured, not assumed: the box is taller when the title wraps, and
    // taller again on a narrow window.
    const search = frame.querySelector('.wy-side-nav-search');
    const placeBelowSearch = () => {
      if (search !== null) {
        frame.style.setProperty('--serial-broker-search-height', `${search.offsetHeight}px`);
      }
    };
    placeBelowSearch();
    window.addEventListener('resize', placeBelowSearch, { passive: true });

    // The theme scrolls this list to the entry for the page being read, which is not the reader
    // scrolling: on a page deep in the reference the list starts far down, and an arrow on
    // arrival would answer a question nobody asked. So the arrow waits for the reader's own
    // first scroll - a wheel, a drag, a key - and from then on simply follows the position.
    let readerHasScrolled = false;
    const update = () => {
      button.hidden = !readerHasScrolled || scroller.scrollTop <= SHOW_AFTER_PX;
    };
    const readerScrolled = () => {
      readerHasScrolled = true;
      update();
    };

    // `passive`: none of these cancel the scrolling they are told about.
    for (const event of ['wheel', 'touchmove', 'keydown']) {
      scroller.addEventListener(event, readerScrolled, { passive: true });
    }
    scroller.addEventListener('scroll', update, { passive: true });
    update();

    /**
     * Brings the chapter heading above the current entry fully into view.
     *
     * The theme opens a page with the list scrolled to the entry being read, which is right - it
     * says where the reader is. But it scrolls that entry to the top, so the chapter heading above
     * it ends up cut in half behind the search box, and the list reads as though it had slipped a
     * few lines. Pulling back to the heading costs nothing: the entry stays in view, and the
     * reader can see which chapter they are in.
     */
    const showTheChapterHeading = () => {
      const current = scroller.querySelector('.wy-menu-vertical li.current');
      const caption = current?.closest('ul')?.previousElementSibling;
      if (caption === null || caption === undefined || !caption.classList.contains('caption')) {
        return;
      }
      const searchBottom = search?.getBoundingClientRect().bottom ?? 0;
      const gap = caption.getBoundingClientRect().top - searchBottom;
      // Only ever pulls back, and only when the heading is above the search box or tight under it.
      if (gap < 8) {
        scroller.scrollTop += gap - 8;
      }
    };

    // The theme moves this list twice over. Its window scroll handler adds however far the content
    // moved to the navigation's own position, so reading down a page drags the navigation with it;
    // and its hashchange handler scrolls whichever entry matches the anchor into view, so following
    // a link into the middle of a page takes the navigation somewhere the reader never asked to go.
    // The navigation is a map, not a second view of the page: it should stay where it was put.
    // Both are dropped. What survives is the highlighting done while the page loads, which is what
    // says where the reader is - it just no longer moves the list to say it.
    window.addEventListener('load', () => {
      const jquery = window.jQuery;
      if (typeof jquery === 'function') {
        jquery(window).off('scroll').off('hashchange');
      }
      // After the theme has placed the list, and only if the reader has not taken over already.
      if (!readerHasScrolled) {
        showTheChapterHeading();
        update();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
