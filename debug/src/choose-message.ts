/**
 * The notice under the page header, about the last click on _Choose a device…_.
 *
 * It says what came of that click - above all that the picker was dismissed and nothing was set up.
 * That is true of a moment, not of the page: as soon as the operator does something else, the
 * notice would go on making a claim about an action that is over. So every action the page offers
 * clears it first, and nothing else has to remember to.
 */

/**
 * The minimum of an element this notice writes to, so its rule can be tested without a DOM.
 *
 * `hidden` is as the platform declares it on `HTMLElement`: a boolean, or the string form the
 * `hidden="until-found"` attribute takes. Only the boolean is ever written here.
 */
export interface NoticeElement {
  textContent: string | null;
  className: string;
  hidden: boolean | string;
}

/** The kinds of notice: a failure, or an outcome that is simply not what was hoped for. */
export type NoticeKind = 'error' | 'notice';

/** The header's notice, and the one rule about when it goes away. */
export class ChooseMessage {
  readonly #element: NoticeElement;

  constructor(element: NoticeElement) {
    this.#element = element;
  }

  /** Shows a message. An empty text takes the notice down, as {@link ChooseMessage.clear} does. */
  show(text: string, kind: NoticeKind = 'notice'): void {
    this.#element.textContent = text;
    this.#element.className = `message ${kind}`;
    this.#element.hidden = text === '';
  }

  /**
   * Takes the notice down, because another action has started.
   *
   * Called at the start of every action rather than when one succeeds: a notice about a finished
   * click must not survive into the next one, whether that one works or fails - a failure shows
   * itself, in the card it belongs to.
   */
  clear(): void {
    this.show('');
  }
}
