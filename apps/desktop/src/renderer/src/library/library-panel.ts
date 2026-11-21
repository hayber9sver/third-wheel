/**
 * The Parts library panel: browse the bd_warehouse catalogue (modules, groups, parts with thumbnails),
 * search it, and see one part in 3D with what is known about it. Opens from the toolbar's Library button
 * and floats over the left of the 3D view (outside `#viewport`, whose wheel and pointer handling must not
 * see the panel). Parts are put into a request (Request tab): copies, whole or sub-parts, target markers, a
 * note and an instruction; "Create request" saves it as a comment with `parts` (see `request.ts`).
 */
import meshesUrl from './data/meshes.bin?url';
import { BODY, CHEVRON, CROSS, icon } from '../icons.js';
import {
  formatParams,
  formatParts,
  formatSize,
  humanizeClassName,
  moduleLabel,
  searchClasses,
  type Catalogue,
} from './catalogue.js';
import { getCatalogue } from './catalogue-load.js';
import { PartPreviews } from './previews.js';
import { optionLabel, sizesFor } from './catalogue.js';
import { buildRequest, clampCopies, needsMode, newDraftItem, type DraftItem } from './request.js';
import type { PartItemData } from '@third-wheel/core';

export interface LibraryPanelOptions {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  /** The model's markers now (a part can be aimed at them). */
  readonly markers: () => readonly {
    readonly id: string;
    readonly name: string;
    readonly color: string;
  }[];
  /** Saves the request as a comment; returns its number, or undefined when it could not be saved. */
  readonly createRequest: (
    text: string,
    markerIds: readonly string[],
    parts: readonly PartItemData[],
  ) => number | undefined;
}

interface Loaded {
  readonly catalogue: Catalogue;
  readonly previews: PartPreviews;
}

/** Thumbnails drawn per animation frame, so opening a long list does not freeze the window. */
const THUMBS_PER_FRAME = 6;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className !== undefined) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${String(response.status)}`);
  return response;
}

export function initLibraryPanel({
  button,
  panel,
  markers,
  createRequest,
}: LibraryPanelOptions): void {
  let loaded: Loaded | undefined;
  let view: 'browse' | 'request' = 'browse';
  let draft: DraftItem[] = [];
  let instruction = '';
  let trayMessage = '';
  let loading = false;
  let failure: string | undefined;
  let query = '';
  let selected: string | undefined;
  const expanded = new Set<string>();
  const thumbQueue: { holder: HTMLElement; name: string }[] = [];
  let thumbFrame = 0;

  // --- the panel's skeleton, built once -----------------------------------------------------------
  const sub = el('span', 'library-sub');
  const close = el('button', 'btn library-close');
  close.type = 'button';
  close.title = 'Close (Esc)';
  close.setAttribute('aria-label', 'Close the parts library');
  close.append(icon(CROSS));
  const head = el('div', 'library-head');
  head.append(el('h2', 'library-title', 'Parts library'), sub, close);

  const tabs = el('div', 'library-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabBrowse = el('button', 'library-tab', 'Browse');
  const tabRequest = el('button', 'library-tab', 'Request');
  for (const [t, v] of [
    [tabBrowse, 'browse'],
    [tabRequest, 'request'],
  ] as const) {
    t.type = 'button';
    t.setAttribute('role', 'tab');
    t.addEventListener('click', () => {
      setView(v);
    });
  }
  tabs.append(tabBrowse, tabRequest);

  const search = el('input', 'library-search');
  search.type = 'search';
  search.placeholder = 'Search parts (English / 中文)';
  search.setAttribute('aria-label', 'Search parts');

  const list = el('div', 'library-list');
  const previewHost = el('div', 'library-preview');
  const info = el('div', 'library-info');
  const detail = el('section', 'library-detail');
  detail.append(previewHost, info);
  const browse = el('div', 'library-browse');
  browse.append(search, list, detail);
  const tray = el('div', 'library-tray');
  panel.append(head, tabs, browse, tray);

  function setView(next: 'browse' | 'request'): void {
    view = next;
    browse.hidden = next !== 'browse';
    tray.hidden = next !== 'request';
    tabBrowse.setAttribute('aria-selected', String(next === 'browse'));
    tabRequest.setAttribute('aria-selected', String(next === 'request'));
    tabRequest.textContent = draft.length > 0 ? `Request (${String(draft.length)})` : 'Request';
    if (next === 'request') {
      loaded?.previews.hide();
      renderTray();
    } else if (loaded && selected !== undefined) {
      renderDetail();
    }
  }

  // --- thumbnails ---------------------------------------------------------------------------------
  function pumpThumbnails(): void {
    thumbFrame = 0;
    if (!loaded) return;
    for (let i = 0; i < THUMBS_PER_FRAME; i++) {
      const next = thumbQueue.shift();
      if (!next) return;
      const mesh = loaded.catalogue.classes[next.name]?.preview?.mesh;
      if (!mesh || !next.holder.isConnected) continue;
      const url = loaded.previews.thumbnail(next.name, mesh);
      if (!url) continue;
      const img = el('img');
      img.src = url;
      img.alt = '';
      next.holder.replaceChildren(img);
    }
    if (thumbQueue.length > 0) thumbFrame = requestAnimationFrame(pumpThumbnails);
  }

  function queueThumbnail(holder: HTMLElement, name: string): void {
    thumbQueue.push({ holder, name });
    thumbFrame ||= requestAnimationFrame(pumpThumbnails);
  }

  // --- the list -----------------------------------------------------------------------------------
  function row(catalogue: Catalogue, name: string, showModule: boolean): HTMLButtonElement {
    const c = catalogue.classes[name];
    const b = el('button', 'library-row');
    b.type = 'button';
    b.dataset['class'] = name;
    if (name === selected) {
      b.classList.add('selected');
      b.setAttribute('aria-current', 'true');
    }
    const thumb = el('span', 'library-thumb');
    thumb.append(icon(BODY));
    if (c?.preview) queueThumbnail(thumb, name);
    const text = el('span', 'library-row-text');
    const title = el('span', 'library-row-name', humanizeClassName(name));
    if (c?.operation) title.append(el('span', 'library-tag', 'operation'));
    const where = c
      ? showModule
        ? `${moduleLabel(catalogue, c.module)} · ${c.group}`
        : name
      : name;
    text.append(title, el('span', 'library-row-sub', where));
    b.append(thumb, text);
    b.addEventListener('click', () => {
      select(name);
    });
    return b;
  }

  function renderList(): void {
    thumbQueue.length = 0;
    list.replaceChildren();
    if (failure !== undefined) {
      const retry = el('button', 'btn', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        failure = undefined;
        ensureLoaded();
      });
      list.append(
        el('p', 'library-empty', `The parts catalogue could not be loaded: ${failure}`),
        retry,
      );
      return;
    }
    if (!loaded) {
      list.append(el('p', 'library-empty', 'Loading the parts catalogue…'));
      return;
    }
    const { catalogue } = loaded;
    const q = query.trim();
    if (q) {
      const names = searchClasses(catalogue, q);
      if (names.length === 0) list.append(el('p', 'library-empty', `No part matches “${q}”.`));
      for (const name of names) list.append(row(catalogue, name, true));
      return;
    }
    for (const m of catalogue.modules) {
      const open = expanded.has(m.id);
      const count = m.groups.reduce((n, g) => n + g.classes.length, 0);
      const toggle = el('button', 'library-module');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(open));
      const chevron = icon(CHEVRON);
      chevron.classList.add('library-chevron');
      toggle.append(
        chevron,
        el('span', 'library-module-name', m.label),
        el('span', 'library-count', String(count)),
      );
      toggle.addEventListener('click', () => {
        if (!expanded.delete(m.id)) expanded.add(m.id);
        renderList();
      });
      list.append(toggle);
      if (!open) continue;
      for (const g of m.groups) {
        const heading = el('div', 'library-group', g.name);
        if (g.operation) heading.append(el('span', 'library-tag', 'operation'));
        list.append(heading);
        for (const name of g.classes) list.append(row(catalogue, name, false));
      }
    }
  }

  // --- the detail card ----------------------------------------------------------------------------
  function renderDetail(): void {
    info.replaceChildren();
    previewHost.replaceChildren();
    loaded?.previews.hide();
    const c = loaded && selected !== undefined ? loaded.catalogue.classes[selected] : undefined;
    if (!loaded || selected === undefined || !c) {
      info.append(el('p', 'library-hint', 'Pick a part to see it in 3D.'));
      previewHost.hidden = true;
      return;
    }
    previewHost.hidden = !c.preview;
    info.append(el('h3', 'library-detail-title', humanizeClassName(selected)));
    info.append(
      el(
        'p',
        'library-detail-sub',
        `${selected} · ${moduleLabel(loaded.catalogue, c.module)} · ${c.group}`,
      ),
    );
    const facts = el('dl', 'library-facts');
    const fact = (label: string, value: string): void => {
      facts.append(el('dt', undefined, label), el('dd', undefined, value));
    };
    const p = c.preview;
    if (p) {
      fact('Size', formatSize(p.size));
      fact('Built with', formatParams(p.params));
      if (p.solids > 1) fact('Solids', String(p.solids));
      const parts = formatParts(p.parts);
      if (parts) fact('Sub-parts', parts);
      loaded.previews.show(previewHost, selected, p.mesh);
    } else {
      info.append(el('p', 'library-hint', 'No preview: this one cannot be built on its own.'));
    }
    info.append(facts);
    if (c.operation) {
      info.append(
        el(
          'p',
          'library-hint',
          'An operation: it cuts a hole or slot into a model and adds no part of its own.',
        ),
      );
    }
    info.append(
      el(
        'p',
        'library-hint',
        'The picture shows one example, not your choice. Choose the size and options in the Request tab.',
      ),
    );
    if (c.options?.some((o) => o.kind === 'flag')) {
      info.append(
        el(
          'p',
          'library-hint',
          'The picture has no thread (it keeps the preview small). Choose “With thread” in the Request tab for a real one; it makes the part many solids.',
        ),
      );
    }
    const cls = selected;
    const add = el('button', 'btn library-add', 'Add to request');
    add.type = 'button';
    add.addEventListener('click', () => {
      draft.push(newDraftItem(cls));
      trayMessage = '';
      tabRequest.textContent = `Request (${String(draft.length)})`;
      add.textContent = `Added · ${String(draft.filter((d) => d.cls === cls).length)} in request`;
    });
    info.append(add);
  }

  // --- the request tray ---------------------------------------------------------------------------
  function renderTray(): void {
    tray.replaceChildren();
    tabRequest.textContent = draft.length > 0 ? `Request (${String(draft.length)})` : 'Request';
    if (trayMessage) tray.append(el('p', 'library-notice', trayMessage));
    if (draft.length === 0) {
      tray.append(
        el(
          'p',
          'library-empty',
          'No parts yet. Pick a part in Browse and press “Add to request”; it is then sent to the AI as a comment.',
        ),
      );
      return;
    }
    const allMarkers = markers();
    const items = el('div', 'library-items');
    draft.forEach((d, i) => {
      const card = el('div', 'library-item');
      const top = el('div', 'library-item-top');
      top.append(el('span', 'library-item-name', humanizeClassName(d.cls)));
      const remove = el('button', 'btn library-close');
      remove.type = 'button';
      remove.title = 'Remove from the request';
      remove.setAttribute('aria-label', `Remove ${humanizeClassName(d.cls)}`);
      remove.append(icon(CROSS));
      remove.addEventListener('click', () => {
        draft = draft.filter((_, j) => j !== i);
        renderTray();
      });
      top.append(remove);
      card.append(top);

      const cls = loaded?.catalogue.classes[d.cls];
      const previewParams = cls?.preview?.params ?? {};
      for (const o of cls?.options ?? []) {
        const row = el(
          'label',
          'library-field library-option',
          `${o.kind === 'flag' ? 'Thread' : optionLabel(o.name)} `,
        );
        const set = (v: string | number | undefined): void => {
          const cur = draft[i] ?? d;
          const rest = Object.entries(cur.params).filter(([k]) => k !== o.name);
          draft[i] = {
            ...cur,
            params: Object.fromEntries(v === undefined ? rest : [...rest, [o.name, v]]),
          };
        };
        if (o.kind === 'flag') {
          const sel = el('select', 'library-mode');
          sel.append(
            new Option('AI decides', ''),
            new Option(o.on, 'true'),
            new Option(o.off, 'false'),
          );
          const cur = d.params[o.name];
          sel.value = typeof cur === 'boolean' ? String(cur) : '';
          sel.addEventListener('change', () => {
            const cur2 = draft[i] ?? d;
            const rest = Object.entries(cur2.params).filter(([k]) => k !== o.name);
            draft[i] = {
              ...cur2,
              params: Object.fromEntries(
                sel.value === '' ? rest : [...rest, [o.name, sel.value === 'true']],
              ),
            };
          });
          row.append(sel);
        } else if (o.kind === 'number') {
          const n = el('input', 'library-copies');
          n.type = 'number';
          n.step = 'any';
          n.min = '0';
          n.placeholder = `AI decides (e.g. ${String(o.default)})`;
          const cur = d.params[o.name];
          n.value = typeof cur === 'number' ? String(cur) : '';
          n.addEventListener('change', () => {
            const v = Number(n.value);
            set(n.value.trim() !== '' && Number.isFinite(v) && v > 0 ? v : undefined);
          });
          row.append(n, o.unit ? ` ${o.unit}` : '');
        } else {
          const sel = el('select', 'library-mode');
          sel.append(new Option('AI decides', ''));
          const values: readonly (string | number)[] =
            o.kind === 'size' ? sizesFor(o, d.params, previewParams) : o.choices;
          for (const v of values) sel.append(new Option(String(v), String(v)));
          const cur = d.params[o.name];
          sel.value =
            cur !== undefined && values.map(String).includes(String(cur)) ? String(cur) : '';
          sel.addEventListener('change', () => {
            const picked = values.find((v) => String(v) === sel.value);
            set(picked);
            // a different standard has different sizes: re-draw so the size list follows
            if (o.kind === 'choice') renderTray();
          });
          row.append(sel);
        }
        card.append(row);
      }

      let modeEl: HTMLSelectElement | undefined;
      const copies = el('input', 'library-copies');
      copies.type = 'number';
      copies.min = '1';
      copies.max = '999';
      copies.value = String(d.copies);
      copies.setAttribute('aria-label', 'Copies');
      copies.addEventListener('change', () => {
        const n = clampCopies(Number(copies.value));
        copies.value = String(n);
        draft[i] = { ...(draft[i] ?? d), copies: n };
        if (modeEl) modeEl.hidden = !needsMode(n, (draft[i] ?? d).markerIds.length);
      });
      const copiesRow = el('label', 'library-field', 'Copies ');
      copiesRow.append(copies);
      card.append(copiesRow);

      const names = Object.keys(loaded?.catalogue.classes[d.cls]?.preview?.parts ?? {});
      if (names.length > 0) {
        const box = el('fieldset', 'library-field');
        box.append(el('legend', undefined, 'Which part (none ticked = the whole part)'));
        for (const n of names) {
          const cb = el('input');
          cb.type = 'checkbox';
          cb.checked = d.subparts.includes(n);
          cb.addEventListener('change', () => {
            const cur = draft[i] ?? d;
            const next = cb.checked ? [...cur.subparts, n] : cur.subparts.filter((s) => s !== n);
            draft[i] = { ...cur, subparts: next };
          });
          const l = el('label', 'library-check');
          l.append(cb, ` ${n}`);
          box.append(l);
        }
        card.append(box);
      }

      const where = el('fieldset', 'library-field');
      where.append(el('legend', undefined, 'Put it at (markers)'));
      if (allMarkers.length === 0) {
        where.append(
          el('span', 'library-hint', 'No markers yet: describe the place in the instruction.'),
        );
      }
      for (const m of allMarkers) {
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = d.markerIds.includes(m.id);
        cb.addEventListener('change', () => {
          const cur = draft[i] ?? d;
          const next = cb.checked
            ? [...cur.markerIds, m.id]
            : cur.markerIds.filter((s) => s !== m.id);
          draft[i] = { ...cur, markerIds: next };
          renderTray();
        });
        const dot = el('span', 'library-dot');
        dot.style.background = m.color;
        const l = el('label', 'library-check');
        l.append(cb, dot, ` ${m.name}`);
        where.append(l);
      }
      card.append(where);
      if (d.markerIds.length > 0) {
        const mode = el('select', 'library-mode');
        mode.setAttribute('aria-label', 'How the copies are placed');
        mode.append(
          new Option('One set at each marker', 'each'),
          new Option('Spread over the marked area', 'pattern'),
        );
        mode.value = d.mode;
        mode.hidden = !needsMode(d.copies, d.markerIds.length);
        modeEl = mode;
        mode.addEventListener('change', () => {
          draft[i] = { ...(draft[i] ?? d), mode: mode.value === 'pattern' ? 'pattern' : 'each' };
        });
        card.append(mode);
      }

      const note = el('input', 'library-note');
      note.type = 'text';
      note.placeholder = 'Special requirements only, e.g. “countersunk flush”, “cut 2 mm shorter”';
      note.value = d.note;
      note.setAttribute('aria-label', 'Note for this part');
      note.addEventListener('input', () => {
        draft[i] = { ...(draft[i] ?? d), note: note.value };
      });
      card.append(note);
      items.append(card);
    });
    tray.append(items);

    const text = el('textarea', 'library-instruction');
    text.rows = 3;
    text.placeholder = 'Tell the AI what to do (optional): “fasten the two parts together…”';
    text.value = instruction;
    text.setAttribute('aria-label', 'Instruction for the AI');
    text.addEventListener('input', () => {
      instruction = text.value;
    });
    const create = el('button', 'btn library-create', 'Create request');
    create.type = 'button';
    create.title = 'Saves it as a comment; press “Send to AI” to hand it over';
    create.addEventListener('click', () => {
      const lib = loaded?.catalogue;
      const live = new Set(markers().map((m) => m.id));
      const built = lib
        ? buildRequest(
            draft,
            instruction,
            { name: lib.library, version: lib.libraryVersion },
            (id) => live.has(id),
          )
        : undefined;
      if (!built) return;
      const num = createRequest(built.text, built.markerIds, built.parts);
      if (num === undefined) {
        trayMessage = 'The request could not be saved.';
      } else {
        trayMessage = `Saved as comment #${String(num)}. Press “Send to AI” when you are ready.`;
        draft = [];
        instruction = '';
      }
      renderTray();
    });
    tray.append(text, create);
  }

  function select(name: string): void {
    selected = name;
    for (const r of list.querySelectorAll<HTMLElement>('.library-row')) {
      const on = r.dataset['class'] === name;
      r.classList.toggle('selected', on);
      if (on) r.setAttribute('aria-current', 'true');
      else r.removeAttribute('aria-current');
    }
    renderDetail();
  }

  function renderHeader(): void {
    sub.textContent = loaded
      ? `${loaded.catalogue.library} ${loaded.catalogue.libraryVersion} · ${String(Object.keys(loaded.catalogue.classes).length)} parts`
      : '';
  }

  // --- loading ------------------------------------------------------------------------------------
  function ensureLoaded(): void {
    if (loaded || loading) return;
    loading = true;
    renderList();
    void (async () => {
      try {
        const catalogue = await getCatalogue();
        const previews = new PartPreviews(await (await fetchOk(meshesUrl)).arrayBuffer());
        const first = catalogue.modules[0];
        if (first) expanded.add(first.id);
        loaded = { catalogue, previews };
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      } finally {
        loading = false;
      }
      renderHeader();
      renderList();
      renderDetail();
    })();
  }

  // --- opening and closing ------------------------------------------------------------------------
  function setOpen(open: boolean): void {
    panel.hidden = !open;
    button.setAttribute('aria-pressed', String(open));
    if (open) {
      ensureLoaded();
      setView(view);
      if (view === 'browse') search.focus();
    } else {
      loaded?.previews.hide();
    }
  }

  button.addEventListener('click', () => {
    setOpen(panel.hidden !== false); // `hidden` can also be "until-found": any hidden state opens it
  });
  close.addEventListener('click', () => {
    setOpen(false);
    button.focus();
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      button.focus();
    }
  });
  search.addEventListener('input', () => {
    query = search.value;
    renderList();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      list.querySelector<HTMLElement>('.library-row')?.focus();
      e.preventDefault();
    }
  });

  // The pictures bake the theme's colours in: rebuild them when the theme changes.
  new MutationObserver(() => {
    if (!loaded) return;
    loaded.previews.themeChanged();
    renderList();
    renderDetail();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  renderHeader();
  renderDetail();
  setView('browse');
}
