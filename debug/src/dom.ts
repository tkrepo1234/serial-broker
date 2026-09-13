/**
 * The little DOM plumbing the debugging surface needs, so its panels read as what they show.
 */

/** Options for {@link element}. */
export interface ElementOptions {
  readonly className?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * Finds an element the page is required to have.
 *
 * The markup is fixed and ships next to this code, so a missing element is a build mistake to
 * fail loudly on, not a case to handle.
 *
 * @throws An `Error` naming the missing id.
 */
export function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`The debugging surface is missing #${id}`);
  }
  return found;
}

/** Creates an element with text, attributes and children in one expression. */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (options.className !== undefined) {
    created.className = options.className;
  }
  if (options.text !== undefined) {
    created.textContent = options.text;
  }
  if (options.title !== undefined) {
    created.title = options.title;
  }
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    created.setAttribute(name, value);
  }
  created.append(...children);
  return created;
}

/** Creates a table row from cell contents. */
export function row(cells: readonly (Node | string)[], className?: string): HTMLTableRowElement {
  return element(
    'tr',
    className === undefined ? {} : { className },
    cells.map((cell) => element('td', {}, [cell])),
  );
}

/** Creates a small coloured label. */
export function badge(text: string, tone: string): HTMLSpanElement {
  return element('span', { className: `badge ${tone}`, text });
}

/** Creates a `<details>` block with a summary and preformatted content. */
export function details(summary: string, content: string): HTMLDetailsElement {
  return element('details', {}, [
    element('summary', { text: summary }),
    element('pre', { text: content }),
  ]);
}
