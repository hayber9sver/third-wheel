/**
 * Right-click menu, like the OS / CAD context menus: items, separators, greyed-out items
 * with a hint, and one level of submenus (open on hover, click or →). Closes on a choice, Esc,
 * a press outside, scrolling, or the window losing focus.
 */

export interface MenuItem {
  readonly label: string;
  /** Colour dot before the label (markers). */
  readonly swatch?: string;
  /** Tick after the label (e.g. the marker Brush paints with). */
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** Grey text after the label (a shortcut, a date). */
  readonly detail?: string;
  /** Tooltip, e.g. why the item is greyed out. */
  readonly title?: string;
  readonly submenu?: readonly MenuEntry[];
  readonly onSelect?: () => void;
  /** For tests: `data-action` on the button. */
  readonly action?: string;
}

export type MenuEntry = MenuItem | 'separator';

export class ContextMenu {
  private readonly root = document.createElement('div');
  private sub: HTMLElement | undefined;
  private subOwner: HTMLButtonElement | undefined;
  /** Toolbar button the menu drops down from: pressing it again closes the menu. */
  private owner: HTMLElement | undefined;
  private closedBy: { owner: HTMLElement; at: number } | undefined;

  constructor(private readonly host: HTMLElement = document.body) {
    this.root.className = 'context-menu';
    this.root.hidden = true;
    host.append(this.root);
    document.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.isOpen) return;
        const t = e.target as Node;
        if (this.root.contains(t) || this.sub?.contains(t)) return;
        if (this.owner?.contains(t)) this.closedBy = { owner: this.owner, at: performance.now() };
        this.close();
      },
      { capture: true },
    );
    window.addEventListener('blur', () => {
      this.close();
    });
    window.addEventListener(
      'wheel',
      () => {
        this.close();
      },
      { passive: true },
    );
    window.addEventListener('keydown', this.onKey, { capture: true });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /**
   * True when a press on dropdown button `owner` just closed its menu: its click must not reopen
   * it (so the button toggles).
   */
  justClosedBy(owner: HTMLElement): boolean {
    const c = this.closedBy;
    this.closedBy = undefined;
    return c !== undefined && c.owner === owner && performance.now() - c.at < 1000;
  }

  /** Opens at page position `at` (kept inside the window); `owner` = dropdown button, if any. */
  open(entries: readonly MenuEntry[], at: { x: number; y: number }, owner?: HTMLElement): void {
    this.close();
    this.owner = owner;
    owner?.setAttribute('aria-expanded', 'true');
    this.fill(this.root, entries, false);
    this.root.hidden = false;
    this.place(this.root, at.x, at.y);
    this.firstEnabled(this.root)?.focus();
  }

  close(): void {
    this.closeSub();
    this.owner?.setAttribute('aria-expanded', 'false');
    this.owner = undefined;
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private fill(menu: HTMLElement, entries: readonly MenuEntry[], isSub: boolean): void {
    menu.setAttribute('role', 'menu');
    for (const entry of entries) {
      if (entry === 'separator') {
        const hr = document.createElement('div');
        hr.className = 'context-menu-sep';
        hr.setAttribute('role', 'separator');
        menu.append(hr);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'context-menu-item';
      b.setAttribute('role', 'menuitem');
      b.disabled = entry.disabled ?? false;
      if (entry.title) b.title = entry.title;
      if (entry.action) b.dataset['action'] = entry.action;
      if (entry.swatch) {
        const dot = document.createElement('span');
        dot.className = 'context-menu-swatch';
        dot.style.setProperty('--swatch', entry.swatch);
        b.append(dot);
      }
      const label = document.createElement('span');
      label.className = 'context-menu-label';
      label.textContent = entry.label;
      b.append(label);
      if (entry.detail) {
        const detail = document.createElement('span');
        detail.className = 'context-menu-detail';
        detail.textContent = entry.detail;
        b.append(detail);
      }
      if (entry.checked !== undefined) {
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(entry.checked));
        const tick = document.createElement('span');
        tick.className = 'context-menu-arrow';
        tick.textContent = entry.checked ? '✓' : '';
        b.append(tick);
      }
      if (entry.submenu) {
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-expanded', 'false');
        const arrow = document.createElement('span');
        arrow.className = 'context-menu-arrow';
        arrow.textContent = '▸';
        b.append(arrow);
      }
      const sub = entry.submenu;
      b.addEventListener('pointerenter', () => {
        if (isSub || b.disabled) return;
        if (sub) this.openSub(b, sub, false);
        else this.closeSub();
      });
      b.addEventListener('click', () => {
        if (b.disabled) return;
        if (sub) {
          this.openSub(b, sub, true);
          return;
        }
        this.close();
        entry.onSelect?.();
      });
      menu.append(b);
    }
  }

  private openSub(owner: HTMLButtonElement, entries: readonly MenuEntry[], focus: boolean): void {
    if (this.subOwner === owner) {
      if (focus && this.sub) this.firstEnabled(this.sub)?.focus();
      return;
    }
    this.closeSub();
    const sub = document.createElement('div');
    sub.className = 'context-menu';
    this.fill(sub, entries, true);
    this.host.append(sub);
    const r = owner.getBoundingClientRect();
    this.place(sub, r.right - 2, r.top - 4, r.left + 2);
    owner.setAttribute('aria-expanded', 'true');
    this.sub = sub;
    this.subOwner = owner;
    if (focus) this.firstEnabled(sub)?.focus();
  }

  private closeSub(): void {
    this.subOwner?.setAttribute('aria-expanded', 'false');
    this.sub?.remove();
    this.sub = undefined;
    this.subOwner = undefined;
  }

  /** Keeps a menu inside the window; a submenu flips to the left of `flipX` when needed. */
  private place(menu: HTMLElement, x: number, y: number, flipX?: number): void {
    menu.style.left = `${String(x)}px`;
    menu.style.top = `${String(y)}px`;
    const r = menu.getBoundingClientRect();
    const maxX = window.innerWidth - 4;
    const maxY = window.innerHeight - 4;
    let left = x;
    if (r.right > maxX) left = flipX !== undefined ? flipX - r.width : maxX - r.width;
    const top = r.bottom > maxY ? Math.max(4, maxY - r.height) : y;
    menu.style.left = `${String(Math.max(4, left))}px`;
    menu.style.top = `${String(top)}px`;
  }

  private firstEnabled(menu: HTMLElement): HTMLButtonElement | undefined {
    return [...menu.querySelectorAll<HTMLButtonElement>('.context-menu-item')].find(
      (b) => !b.disabled,
    );
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;
    const focused = document.activeElement as HTMLElement | null;
    const inSub = this.sub?.contains(focused) ?? false;
    const menu = inSub && this.sub ? this.sub : this.root;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.context-menu-item')].filter(
      (b) => !b.disabled,
    );
    const index = items.indexOf(focused as HTMLButtonElement);
    let handled = true;
    if (e.key === 'Escape') {
      if (inSub) {
        const owner = this.subOwner;
        this.closeSub();
        owner?.focus();
      } else this.close();
    } else if (e.key === 'ArrowDown') {
      items[(index + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'ArrowRight' && !inSub && focused?.getAttribute('aria-haspopup')) {
      focused.click();
    } else if (e.key === 'ArrowLeft' && inSub) {
      const owner = this.subOwner;
      this.closeSub();
      owner?.focus();
    } else if (e.key === 'Tab') {
      this.close();
      handled = false;
    } else {
      // Enter / Space click the focused item. Letters / digits (tool keys, views) close the menu
      // and do their usual thing; other keys pass through.
      handled = false;
      if (/^[a-z0-9]$/i.test(e.key)) this.close();
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation(); // Esc must not also clear the selection
    }
  };
}
