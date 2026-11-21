/**
 * Answers the `search_parts` tool from the shipped catalogue (the same data and the same search words as the
 * Library panel), so an AI recommends real classes and sizes the library can build. Pure.
 */
import type {
  PartOptionInfo,
  SearchPartHit,
  SearchPartsParams,
  SearchPartsResult,
} from '@third-wheel/core';
import {
  allClassNames,
  humanizeClassName,
  moduleLabel,
  searchText,
  type Catalogue,
  type CatalogueOption,
} from './catalogue.js';

const DEFAULT_LIMIT = 10;
/** A list longer than this is summarised in a search result (the full list comes with `cls`). */
const SHORT_LIST = 12;
const EXAMPLES = 5;

/** The option, in the form the AI reads. `full`: whole lists; else long ones become a count and a few examples. */
export function describeOption(o: CatalogueOption, full: boolean): PartOptionInfo {
  switch (o.kind) {
    case 'flag':
      return { name: o.name, kind: 'flag', on: o.on, off: o.off };
    case 'number':
      return { name: o.name, kind: 'number', default: o.default, unit: o.unit };
    case 'choice':
      return full || o.choices.length <= SHORT_LIST
        ? { name: o.name, kind: 'choice', choices: [...o.choices] }
        : {
            name: o.name,
            kind: 'choice',
            count: o.choices.length,
            examples: o.choices.slice(0, EXAMPLES),
          };
    case 'size': {
      const bySize = Array.isArray(o.sizes)
        ? undefined
        : (o.sizes as Readonly<Record<string, readonly string[]>>);
      const flat: readonly string[] = bySize
        ? (Object.values(bySize)[0] ?? [])
        : (o.sizes as readonly string[]);
      const base = {
        name: o.name,
        kind: 'size' as const,
        ...(o.typeParam ? { typeParam: o.typeParam } : {}),
      };
      if (full) return { ...base, sizes: bySize ? { ...bySize } : [...flat] };
      const count = bySize
        ? Object.values(bySize).reduce((n, v) => Math.max(n, v.length), 0)
        : flat.length;
      return { ...base, count, examples: flat.slice(0, EXAMPLES) };
    }
  }
}

function hit(catalogue: Catalogue, name: string, full: boolean, matched?: number): SearchPartHit {
  const c = catalogue.classes[name];
  if (!c) throw new Error(`Unknown class ${name}`);
  const p = c.preview;
  return {
    cls: name,
    label: humanizeClassName(name),
    module: moduleLabel(catalogue, c.module),
    group: c.group,
    operation: c.operation,
    ...(matched === undefined ? {} : { matched }),
    ...(p ? { exampleSize: p.size, solids: p.solids } : {}),
    ...(p && Object.keys(p.parts).length > 0 ? { subparts: p.parts } : {}),
    ...(p ? { builtWith: p.params } : {}),
    options: (c.options ?? []).map((o) => describeOption(o, full)),
  };
}

/** Classes ranked by how many of the query's words they match (a part matching most words first). */
export function rankClasses(
  catalogue: Catalogue,
  query: string,
): { name: string; matched: number }[] {
  const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
  return allClassNames(catalogue)
    .map((name, order) => {
      const text = searchText(catalogue, name);
      return { name, order, matched: words.filter((w) => text.includes(w)).length };
    })
    .filter((r) => r.matched > 0)
    .sort((a, b) => b.matched - a.matched || a.order - b.order)
    .map(({ name, matched }) => ({ name, matched }));
}

export function searchParts(catalogue: Catalogue, params: SearchPartsParams): SearchPartsResult {
  const base = { library: catalogue.library, version: catalogue.libraryVersion };
  if (params.cls !== undefined) {
    const wanted = params.cls.toLowerCase();
    const name = allClassNames(catalogue).find((n) => n.toLowerCase() === wanted);
    if (!name) {
      const near = rankClasses(catalogue, params.cls)
        .slice(0, 5)
        .map((r) => r.name);
      const similar = near.length > 0 ? `; similar: ${near.join(', ')}` : '';
      throw new Error(
        `No class "${params.cls}" in the catalogue${similar}. Use search_parts with a query to find class names.`,
      );
    }
    return { ...base, total: 1, hits: [hit(catalogue, name, true)] };
  }
  const query = params.query ?? '';
  const ranked = rankClasses(catalogue, query);
  const best = ranked[0]?.matched ?? 0;
  const limit = params.limit ?? DEFAULT_LIMIT;
  const words = new Set(query.toLowerCase().split(/\s+/).filter(Boolean)).size;
  const note =
    ranked.length === 0
      ? 'Nothing matched. Try fewer or simpler words (English or Chinese), a part kind such as screw, nut, bearing, gear, seal, or a class name.'
      : best < words
        ? `No part matches all ${String(words)} words; the hits match the most words (see matched).`
        : undefined;
  return {
    ...base,
    total: ranked.length,
    hits: ranked.slice(0, limit).map((r) => hit(catalogue, r.name, false, r.matched)),
    ...(note ? { note } : {}),
  };
}
