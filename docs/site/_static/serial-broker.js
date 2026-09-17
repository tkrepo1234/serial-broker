/*
 * Two arrows on the navigation: one up, one down, each shown only while there is more that way.
 *
 * The sidebar scrolls on its own, and its scrollbar is easy to miss: on a long page - the
 * application API lists every method - the reader ends up somewhere in the list with no sign of
 * what is above or below. An arrow says there is more in its direction, and a click moves the list
 * two thirds of what is visible - far enough to get somewhere, short enough that the entries that
 * were at the edge are still on screen, so the reader keeps their place.
 *
 * What a reader expects of such arrows, and what this therefore takes care of:
 *
 * - An arrow that is there can be used, and one that cannot be used is not there: at the top there
 *   is no up arrow, at the bottom no down arrow, and a list that fits has neither. The position is
 *   compared with a tolerance, because a zoomed page scrolls to fractions of a pixel and would
 *   otherwise stop half a pixel short of "the end" for ever.
 * - Clicking three times quickly moves three steps. A smooth scroll is still on its way when the
 *   second click comes, so steps are counted from where the list is going, not from where it is.
 * - An arrow that disappears under the keyboard user's finger does not drop the focus on the floor:
 *   it goes to the list. Not to the other arrow - someone pressing Enter until the top is reached
 *   would press it once more and be taken back down.
 * - The list changes height without scrolling - a window resized, a chapter's entries unfolding -
 *   so the arrows listen to that as well.
 * - A reader who asked for less motion gets none: the move is the point, not the animation.
 *
 * The theme's own markup is left alone: this adds two elements, and does nothing at all if the
 * theme ever renames what it looks for.
 */
(() => {
  'use strict';

  /** Closer to an end than this counts as being there; see the note on zoom above. */
  const AT_THE_END_PX = 2;
  /** How much of the visible list one click moves. */
  const STEP = 2 / 3;

  function install() {
    // `.wy-side-scroll` is the element that scrolls; `.wy-nav-side` is the fixed frame around it,
    // which is what the arrows are positioned against so they stay put while the list moves.
    const scroller = document.querySelector('.wy-side-scroll');
    const frame = document.querySelector('.wy-nav-side');
    if (scroller === null || frame === null) {
      return;
    }
    const search = frame.querySelector('.wy-side-nav-search');

    /** Where the list is going: the end of a smooth scroll still under way, or where it is. */
    let target = scroller.scrollTop;
    let settling;

    const arrow = (direction) => {
      const button = document.createElement('button');
      const label = `Scroll the navigation ${direction}`;
      button.type = 'button';
      button.className = `serial-broker-scroll serial-broker-scroll-${direction}`;
      button.setAttribute('aria-label', label);
      button.title = label;
      button.hidden = true;
      // Drawn rather than written: a character would follow the font and be read out by a screen
      // reader as punctuation. `aria-hidden` leaves the label above as the only thing announced.
      button.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M12 5.5 5 13h4.2v5.5h5.6V13H19z" /></svg>';
      button.addEventListener('click', () => {
        // The search box stays at the top of the list and covers that much of it.
        const visible = scroller.clientHeight - (search?.offsetHeight ?? 0);
        const step = Math.max(40, Math.round(visible * STEP));
        const last = scroller.scrollHeight - scroller.clientHeight;
        target = Math.min(last, Math.max(0, target + (direction === 'up' ? -step : step)));
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        scroller.scrollTo({ top: target, behavior: reduced ? 'auto' : 'smooth' });
      });
      frame.append(button);
      return button;
    };
    const up = arrow('up');
    const down = arrow('down');

    const update = () => {
      const last = scroller.scrollHeight - scroller.clientHeight;
      const show = {
        up: scroller.scrollTop > AT_THE_END_PX,
        down: scroller.scrollTop < last - AT_THE_END_PX,
      };
      for (const [button, shown] of [
        [up, show.up],
        [down, show.down],
      ]) {
        if (!shown && document.activeElement === button) {
          // The arrow did its job and goes; whoever pressed it with a key stays in the navigation.
          scroller.setAttribute('tabindex', '-1');
          scroller.focus({ preventScroll: true });
        }
        button.hidden = !shown;
      }
    };

    // While a smooth scroll runs, `target` is where it ends. Once the list has been still for a
    // moment - or the reader scrolled it themselves - the list's own position is the truth again.
    scroller.addEventListener(
      'scroll',
      () => {
        update();
        clearTimeout(settling);
        settling = setTimeout(() => {
          target = scroller.scrollTop;
          update();
        }, 150);
      },
      { passive: true },
    );
    for (const event of ['wheel', 'touchmove', 'keydown']) {
      scroller.addEventListener(event, () => (target = scroller.scrollTop), { passive: true });
    }

    // The search box is taller when the title wraps, and taller again on a narrow window; the up
    // arrow sits under it, so how far under is measured, not assumed.
    const placeBelowSearch = () => {
      if (search !== null) {
        frame.style.setProperty('--serial-broker-search-height', `${search.offsetHeight}px`);
      }
    };
    const resized = () => {
      placeBelowSearch();
      target = scroller.scrollTop;
      update();
    };
    window.addEventListener('resize', resized, { passive: true });
    // The list grows and shrinks as chapters unfold, which scrolls nothing and moves both ends.
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(resized);
      observer.observe(scroller);
      for (const child of scroller.children) {
        observer.observe(child);
      }
    }
    placeBelowSearch();
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
    // says where the reader is - it just does not move the list to say it.
    window.addEventListener('load', () => {
      const jquery = window.jQuery;
      if (typeof jquery === 'function') {
        jquery(window).off('scroll').off('hashchange');
      }
      // After the theme has placed the list.
      showTheChapterHeading();
      target = scroller.scrollTop;
      update();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();
