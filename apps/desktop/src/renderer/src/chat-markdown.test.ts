import { describe, expect, it } from 'vitest';
import { renderChatMarkdown } from './chat-markdown.js';

describe('renderChatMarkdown', () => {
  it('escapes everything the agent writes; no raw HTML gets through', () => {
    const html = renderChatMarkdown('<img src=x onerror="alert(1)"> & <b>hi</b>');
    expect(html).toBe(
      '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;b&gt;hi&lt;/b&gt;</p>',
    );
  });

  it('bold, italic, code; nothing is formatted inside code', () => {
    expect(renderChatMarkdown('Pin is **Ø4.80**, *was* _4.85_; use `**raw**`')).toBe(
      '<p>Pin is <strong>Ø4.80</strong>, <em>was</em> <em>4.85</em>; use <code>**raw**</code></p>',
    );
  });

  it('keeps snake_case names and lone stars as they are', () => {
    expect(renderChatMarkdown('square_wheel_v2.step, 2 * 3 = 6')).toBe(
      '<p>square_wheel_v2.step, 2 * 3 = 6</p>',
    );
  });

  it('https links only, opened outside the app', () => {
    expect(renderChatMarkdown('[docs](https://example.com/a?b=1&c=2)')).toBe(
      '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noreferrer noopener">docs</a></p>',
    );
    expect(renderChatMarkdown('[x](javascript:alert(1)) [y](http://plain.example)')).toBe(
      '<p>[x](javascript:alert(1)) [y](http://plain.example)</p>',
    );
  });

  it('a quote or marks in a link cannot break out of the href', () => {
    expect(renderChatMarkdown('[x](https://a"onmouseover=b)')).toBe(
      '<p><a href="https://a&quot;onmouseover=b" target="_blank" rel="noreferrer noopener">x</a></p>',
    );
    expect(renderChatMarkdown('[**b** _i_](https://a.example/x_y_z**w**)')).toBe(
      '<p><a href="https://a.example/x_y_z**w**" target="_blank" rel="noreferrer noopener"><strong>b</strong> <em>i</em></a></p>',
    );
  });

  it('paragraphs, line breaks, headings, lists, code blocks', () => {
    const md = [
      '# Done',
      'Changed two things:',
      'see below',
      '',
      '- pin **Ø4.80**',
      '- eye moved',
      '  2 mm left',
      '',
      '1. export',
      '2. load',
      '',
      '```python',
      'a = 1 < 2',
      '```',
    ].join('\n');
    expect(renderChatMarkdown(md)).toBe(
      '<p><strong>Done</strong></p>' +
        '<p>Changed two things:<br>see below</p>' +
        '<ul><li>pin <strong>Ø4.80</strong></li><li>eye moved 2 mm left</li></ul>' +
        '<ol><li>export</li><li>load</li></ol>' +
        '<pre><code>a = 1 &lt; 2</code></pre>',
    );
  });

  it('an unclosed code block runs to the end', () => {
    expect(renderChatMarkdown('```\nx\ny')).toBe('<pre><code>x\ny</code></pre>');
  });
});
