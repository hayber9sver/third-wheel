/**
 * Collapsible panel sections: the section's h2 becomes a toggle button; a collapsed
 * section shows only its heading. Which sections are collapsed is remembered per id.
 */
export const COLLAPSED_STORAGE_KEY = 'third-wheel.collapsed-sections';

/** Stored text → set of collapsed section ids (anything malformed → none). */
export function parseCollapsed(text: unknown): Set<string> {
  if (typeof text !== 'string') return new Set();
  try {
    const value: unknown = JSON.parse(text);
    return new Set(
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

export function serializeCollapsed(ids: ReadonlySet<string>): string {
  return JSON.stringify([...ids].sort());
}

/**
 * Turns `section`'s h2 into a toggle. `onToggle` gets the new state (true = collapsed).
 * Works with headings that other code later moves into a heading row (body list).
 */
export function makeCollapsible(
  section: HTMLElement,
  collapsed: boolean,
  onToggle: (collapsed: boolean) => void,
): void {
  const heading = section.querySelector('h2');
  if (!heading) throw new Error('collapsible section needs an h2');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'section-toggle';
  const chevron = document.createElement('span');
  chevron.className = 'section-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  button.append(chevron, ...heading.childNodes);
  heading.replaceChildren(button);
  const apply = (value: boolean): void => {
    section.classList.toggle('collapsed', value);
    button.setAttribute('aria-expanded', String(!value));
    button.title = value ? 'Show section' : 'Hide section';
  };
  apply(collapsed);
  button.addEventListener('click', () => {
    const next = !section.classList.contains('collapsed');
    apply(next);
    onToggle(next);
  });
}
