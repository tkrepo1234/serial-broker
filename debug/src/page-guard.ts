/**
 * Checks that keep the debugging surface from being turned against the operator.
 *
 * The page can send bytes to devices and revoke device permissions (ADR-0019). A page of another
 * origin that frames it could lay its own content over the page's buttons and have the operator
 * click them. Whether the page may be framed at all is best decided by a `frame-ancestors` header
 * from the server that serves it, which a static page cannot set; this is the part the page can
 * decide for itself.
 */

/**
 * The controls that set a configuration up, hidden together where the page cannot run one
 * (ADR-0034).
 *
 * The `?` beside _Choose a device…_ belongs to that action and goes with it: a help text about an
 * action the page has just removed explains nothing and invites a click on nothing.
 */
export const SETUP_ACTION_IDS = ['newButton', 'chooseButton', 'chooseHelp'] as const;

/** The part of `window` the framing check reads. */
export interface FramedView {
  readonly self: unknown;
  readonly top: unknown;
  readonly location: { readonly origin: string };
}

/**
 * `true` when the page runs inside a frame whose top-level page is of another origin.
 *
 * Framing by a page of the same origin is allowed: an operator may embed the page in an
 * administration page of their own. Reading the location of a top-level page of another origin
 * throws, which is what tells the two apart.
 */
export function isFramedByAnotherOrigin(view: FramedView): boolean {
  if (view.top === view.self || view.top === null || view.top === undefined) {
    return false;
  }
  try {
    const top = view.top as { readonly location: { readonly origin: string } };
    return top.location.origin !== view.location.origin;
  } catch {
    return true;
  }
}
