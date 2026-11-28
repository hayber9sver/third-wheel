/** Small inline SVG icons for panel rows (Feather-style 24×24 stroke outlines). */

const SVG_NS = 'http://www.w3.org/2000/svg';

export const EYE =
  'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z';
export const EYE_OFF =
  'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94 M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19 M14.12 14.12a3 3 0 1 1-4.24-4.24 M1 1l22 22';
/** Crosshair ("zoom to"). */
export const TARGET = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 1v5 M12 18v5 M1 12h5 M18 12h5';
/** Disclosure chevron (points right; rotated by CSS when open). */
export const CHEVRON = 'M9 6l6 6-6 6';
/** Close / delete cross. */
export const CROSS = 'M6 6l12 12 M18 6L6 18';
/** Folder (user folders in the body list). */
export const FOLDER = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';

export function icon(d = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  if (d) path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

// Toolbar: shown next to the label, alone when the window is narrow (tooltip names it).
/** Select tool: pointer arrow. */
export const POINTER = 'M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z M13 13l6 6';
/** Brush tool. */
export const BRUSH =
  'M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08 M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z';
/** Smart fill tool: paint bucket. */
export const BUCKET =
  'M19 11l-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11z M5 2l5 5 M2 13h15 M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4z';
/** Pick filters: a corner point, a line with ends, a flat face, a box. */
export const VERTEX =
  'M4 20l6.2-6.2 M20 20l-6.2-6.2 M12 3v6.5 M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z';
export const EDGE = 'M5 19L19 5 M3 17l4 4 M17 3l4 4';
export const FACE = 'M3 17L8 6h13l-5 11z';
export const BODY = 'M12 2l9 5v10l-9 5-9-5V7z M3 7l9 5 9-5 M12 12v10';
