import { describe, expect, it } from 'vitest';
import { normalizeDraft, normalize, toHtmlRange, sanitizeHtml, sha256 } from '../src/lib/normalizer';

describe('sanitizeHtml', () => {
  it('drops scripts and event handlers', () => {
    const out = sanitizeHtml('<p onclick="evil()">hi<script>alert(1)</script></p>');
    expect(out).not.toMatch(/script|onclick/i);
    expect(out).toContain('hi');
  });
  it('strips javascript: urls', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/javascript:/i);
  });
  it('keeps img src and alt through sanitization (reviewer D1)', () => {
    const out = sanitizeHtml('<img src="logo.png" alt="Meridian Flow logo">');
    expect(out).toBe('<img src="logo.png" alt="Meridian Flow logo">');
  });
  it('neuters every event-handler form (reviewer D3)', () => {
    expect(sanitizeHtml('<a href=x onerror=alert(1)>click</a>')).not.toMatch(/onerror/i);
    expect(sanitizeHtml("<a href='https://ok.example' onmouseover=alert(1)>hover</a>")).not.toMatch(/onmouseover/i);
    expect(sanitizeHtml('<img src="x.png" onerror=alert(1)>')).not.toMatch(/onerror/i);
    expect(sanitizeHtml('<p onclick=\'alert(1)\'>x</p>')).not.toMatch(/onclick/i);
  });
  it('drops non-http(s) link wrappers but keeps their text (reviewer D3)', () => {
    expect(sanitizeHtml('<a href="data:text/html;base64,AAAA">x</a>')).not.toMatch(/data:/i);
    expect(sanitizeHtml('<a href="data:text/html,AAAA">keep me</a>')).toBe('keep me');
    expect(sanitizeHtml('<a href="vbscript:x">v</a>')).not.toMatch(/vbscript/i);
  });
  it('escapes quotes and angle brackets in rebuilt attributes (reviewer D3)', () => {
    const out = sanitizeHtml('<img src="x.png" alt=\'"><a href=x onerror=alert(1)>c</a>\'>');
    expect(out).not.toMatch(/<a href=x/i);
    expect(out).toContain('&quot;');
  });
  it('preserves inert typography styles for the a11y lane, strips everything else (reviewer D2)', () => {
    const out = sanitizeHtml('<p style="color:#ccc;background-color:#fff;font-size:14pt" id="x" class="y">t</p>');
    expect(out).toContain('style="color:#ccc;background-color:#fff;font-size:14pt"');
    expect(out).not.toMatch(/id=|class=/);
  });
  it('strips url() and braces from style values', () => {
    const out = sanitizeHtml('<p style="background-color:url(evil);color:red{}">x</p>');
    expect(out).not.toMatch(/url\(/i);
    expect(out).not.toMatch(/\{/);
  });
  it('keeps h5/h6 so heading-order skips are visible (reviewer D4)', () => {
    const out = sanitizeHtml('<h2>A</h2><h5>B</h5>');
    expect(out).toContain('<h5>');
  });
  it('unwraps disallowed tags but keeps text', () => {
    const out = sanitizeHtml('<table><tr><td>cell</td></tr></table>');
    expect(out).toContain('cell');
    expect(out).not.toContain('table');
  });
});

describe('normalizeDraft', () => {
  it('same text -> same hash', () => {
    expect(normalizeDraft('Hello world.', 'markdown').sha256).toBe(normalizeDraft('Hello world.', 'markdown').sha256);
  });
  it('trailing whitespace does not change the hash', () => {
    expect(normalizeDraft('Hello world. ', 'markdown').sha256).toBe(normalizeDraft('Hello world.', 'markdown').sha256);
  });
  it('any content edit changes the hash', () => {
    expect(normalizeDraft('Hello world.', 'markdown').sha256).not.toBe(normalizeDraft('Hello world?', 'markdown').sha256);
  });
  it('markdown and html with the same visible text agree', () => {
    const md = normalizeDraft('# Heading\n\nBody line.', 'markdown');
    const html = normalizeDraft('<h1>Heading</h1><p>Body line.</p>', 'html');
    expect(md.sha256).toBe(html.sha256);
  });
  it('entities decode before hashing', () => {
    expect(normalizeDraft('A &amp; B', 'html').sha256).toBe(normalizeDraft('A & B', 'html').sha256);
  });
  it('block boundaries become newlines in plain text', () => {
    const n = normalizeDraft('<p>one</p><p>two</p>', 'html');
    expect(n.plain).toBe('one\ntwo');
  });
});

describe('span map projection', () => {
  it('maps plain offsets back into the html', () => {
    const html = '<p>Hello <strong>brave</strong> world</p>';
    const { plain, spanMap } = normalize(html);
    expect(plain).toBe('Hello brave world');
    const start = plain.indexOf('brave');
    const [a, b] = toHtmlRange(spanMap, start, start + 5) ?? [];
    expect(html.slice(a, b)).toBe('brave');
  });
});

describe('sha256', () => {
  it('is deterministic and hex', () => {
    expect(sha256('x')).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256('x')).toBe(sha256('x'));
  });
});
