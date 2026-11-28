/**
 * A small Markdown subset for the agent's chat answers, written as safe HTML: every bit of the
 * agent's text is escaped first; only our own tags are added. No library (no `marked` /
 * DOMPurify). Supported: paragraphs and line breaks, `#` headings (shown as a bold line),
 * `-` / `*` / `1.` lists, fenced code blocks, `` `code` ``, `**bold**`, `*italic*` / `_italic_`,
 * `[text](https://…)` links (https only; the window opens them in the OS browser).
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Inline marks on one escaped-later line of text. */
export function renderInline(text: string): string {
  // Code spans first: nothing inside them is formatted.
  const parts = text.split(/(`[^`\n]+`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      return formatMarks(part);
    })
    .join('');
}

function formatMarks(text: string): string {
  // Links before escaping so the URL can be checked; the rest is escaped piece by piece.
  const out: string[] = [];
  const linkRe = /\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(linkRe)) {
    out.push(emphasis(escapeHtml(text.slice(last, m.index))));
    const label = emphasis(escapeHtml(m[1] ?? ''));
    out.push(
      `<a href="${escapeHtml(m[2] ?? '')}" target="_blank" rel="noreferrer noopener">${label}</a>`,
    );
    last = m.index + m[0].length;
  }
  out.push(emphasis(escapeHtml(text.slice(last))));
  return out.join('');
}

/** Bold / italic on already escaped text (the marks `*` and `_` are not escaped). */
function emphasis(html: string): string {
  return html
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
}

type Block =
  | { readonly kind: 'p'; readonly lines: string[] }
  | { readonly kind: 'h'; readonly text: string }
  | { readonly kind: 'ul' | 'ol'; readonly items: string[] }
  | { readonly kind: 'code'; readonly lines: string[] };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith(fence[1] ?? '```'))
        code.push(lines[i++] ?? '');
      i++; // closing fence (or end of text)
      blocks.push({ kind: 'code', lines: code });
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'h', text: heading[1] ?? '' });
      i++;
      continue;
    }
    const listKind = BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : undefined;
    if (listKind) {
      const re = listKind === 'ul' ? BULLET : NUMBERED;
      const items: string[] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i] ?? '');
        if (m) items.push(m[1] ?? '');
        else if ((lines[i] ?? '').trim() !== '' && /^\s{2,}/.test(lines[i] ?? '') && items.length)
          items[items.length - 1] = `${items.at(-1) ?? ''} ${(lines[i] ?? '').trim()}`; // wrapped item line
        else break;
        i++;
      }
      blocks.push({ kind: listKind, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (l.trim() === '' || FENCE.test(l) || HEADING.test(l) || BULLET.test(l) || NUMBERED.test(l))
        break;
      para.push(l);
      i++;
    }
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

/** The agent's Markdown → safe HTML for a chat bubble. */
export function renderChatMarkdown(text: string): string {
  return parseBlocks(text)
    .map((b) => {
      switch (b.kind) {
        case 'p':
          return `<p>${b.lines.map((l) => renderInline(l.trim())).join('<br>')}</p>`;
        case 'h':
          return `<p><strong>${renderInline(b.text)}</strong></p>`;
        case 'code':
          return `<pre><code>${escapeHtml(b.lines.join('\n'))}</code></pre>`;
        default:
          return `<${b.kind}>${b.items.map((it) => `<li>${renderInline(it)}</li>`).join('')}</${b.kind}>`;
      }
    })
    .join('');
}
