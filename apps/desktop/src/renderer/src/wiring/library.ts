/**
 * Parts library: the toolbar's Library button and its panel (catalogue of ready-made parts, part
 * requests saved as comments). The panel lives outside #viewport, see library/library-panel.ts.
 */
import { initLibraryPanel } from '../library/library-panel.js';
import { byId, comments, markers } from '../main.js';

initLibraryPanel({
  button: byId('library-btn') as HTMLButtonElement,
  panel: byId('library-panel'),
  markers: () => markers.list().map((m) => ({ id: m.id, name: m.name, color: m.color })),
  createRequest: (text, markerIds, parts) => {
    const c = comments.add(text, markerIds, 'human', [], parts);
    return c ? comments.numberOf(c.id) : undefined;
  },
});
