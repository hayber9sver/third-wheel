/** The shipped catalogue, loaded once and shared by the Library panel and the `search_parts` tool. */
import catalogueUrl from './data/catalogue.json?url';
import { parseCatalogue, type Catalogue } from './catalogue.js';

let loading: Promise<Catalogue> | undefined;

/** Fetches and checks `catalogue.json` the first time; a failure is not remembered (the next call tries again). */
export function getCatalogue(): Promise<Catalogue> {
  loading ??= fetch(catalogueUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`${catalogueUrl}: ${String(r.status)}`);
      return r.json() as Promise<unknown>;
    })
    .then(parseCatalogue)
    .catch((err: unknown) => {
      loading = undefined;
      throw err instanceof Error ? err : new Error(String(err));
    });
  return loading;
}
