/** Vite / Vitest `?raw` import (file text as a string). Used by tests only; core stays free of Node types. */
declare module '*.md?raw' {
  const text: string;
  export default text;
}

declare module '*.json?raw' {
  const text: string;
  export default text;
}
