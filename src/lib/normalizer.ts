/**
 * Normalizer: turns draft input (markdown or HTML) into
 *  - sanitized HTML for storage/display, and
 *  - normalized plain text used for ALL offset math, with a span map that
 *    translates plain-text offsets back into sanitized-HTML offsets so the
 *    workbench can highlight findings in place.
 *
 * Determinism is the point: same input, same output, always. No model calls.
 */

import { createHash } from 'node:crypto';

export interface SpanMapEntry {
  /** offset in plain text */
  plain: number;
  /** offset in sanitized html */
  html: number;
}

export interface Normalized {
  html: string;
  plain: string;
  spanMap: SpanMapEntry[];
  sha256: string;
}

/** Collapse whitespace, strip tags, decode the entities we produce. */
const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Allowlist sanitizer for the subset of HTML the editor accepts:
 * paragraphs, headings, lists, inline emphasis, links, code. Everything
 * else is unwrapped (children kept) or dropped. Script/style/content-less
 * elements vanish entirely. Attributes: href + rel on <a> only.
 */
export function sanitizeHtml(input: string): string {
  let s = input;

  // drop dangerous blocks whole
  s = s.replace(/<(script|style|iframe|object|embed|noscript|svg|math)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\/?(script|style|iframe|object|embed|noscript|svg|math)[^>]*>/gi, '');

  // strip event handlers (quoted and unquoted forms)
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // images: rebuild with ONLY clean src (http/https/relative) + escaped alt;
  // drop src-less or js-scheme imgs entirely. The attrs pattern tolerates >
  // inside quoted values so an alt like '">...' cannot split the tag.
  s = s.replace(/<img\b((?:"[^"]*"|'[^']*'|[^>])*?)>/gi, (_m, attrs: string) => {
    const srcRaw = /src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const src = (srcRaw?.[2] ?? srcRaw?.[3] ?? srcRaw?.[4] ?? '').trim();
    if (!src || /^(javascript|data|vbscript):/i.test(src)) return '';
    const altRaw = /alt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const hasAlt = altRaw !== null;
    const alt = (altRaw?.[2] ?? altRaw?.[3] ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<img src="${src.replace(/"/g, '&quot;')}"${hasAlt ? ` alt="${alt}"` : ''}>`;
  });

  // anchors: rebuild with ONLY http(s) href + rel + escaped aria-label
  s = s.replace(/<a\b((?:"[^"]*"|'[^']*'|[^>])*?)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const hrefRaw = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const href = (hrefRaw?.[2] ?? hrefRaw?.[3] ?? hrefRaw?.[4] ?? '').trim();
    if (!/^https?:\/\//i.test(href)) return inner; // drop the wrapper, keep content
    const labelRaw = /aria-label\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const label = (labelRaw?.[2] ?? labelRaw?.[3] ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<a href="${href.replace(/"/g, '&quot;')}" rel="noopener noreferrer nofollow"${label ? ` aria-label="${label}"` : ''}>${inner}</a>`;
  });

  // style attributes: keep ONLY inert typography declarations (the a11y lane
  // reads these); values are filtered to a safe charset, url()/braces removed
  s = s.replace(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (_m, _q, dq: string | undefined, sq: string | undefined) => {
    const raw = dq ?? sq ?? '';
    const kept: string[] = [];
    for (const m of raw.matchAll(/(color|background-color|font-size|font-weight)\s*:\s*([^;]+)/gi)) {
      const val = m[2].replace(/url\([^)]*\)/gi, '').replace(/[{};<>]/g, '').trim();
      if (/^[\w#.,()%\s-]+$/.test(val) && val.length <= 60) kept.push(`${m[1]}:${val}`);
    }
    return kept.length ? `style="${kept.join(';')}"` : '';
  });

  // every other tag: attributes removed EXCEPT the (already inert) style
  // declaration the a11y lane reads; a and img were rebuilt above
  s = s.replace(/<(?!a\b|img\b)([a-z0-9]+)\s+[^>]*>/gi, (m, tag: string) => {
    const st = /style\s*=\s*("[^"]*"|'[^']*')/i.exec(m)?.[0];
    return st ? `<${tag.toLowerCase()} ${st}>` : `<${tag.toLowerCase()}>`;
  });
  s = s.replace(/javascript:/gi, '');
  // final catch-all: any event handler that survived attribute rebuilding
  // (e.g. exposed by an early-terminated tag match) is stripped again
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // unwrap anything not in the allowlist
  const allowed = new Set([
    'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'u',
    'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'hr', 'img',
  ]);
  s = s.replace(/<\/?([a-z0-9]+)(\s|>)/gi, (m, tag: string, tail: string) => {
    if (allowed.has(tag.toLowerCase())) return m;
    return tail === '>' ? '' : ' ';
  });

  return s.trim();
}

/** Markdown-lite -> HTML for plain-markdown drafts (headings, lists, emphasis, links). */
export function markdownToHtml(md: string): string {
  const esc = (t: string) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t: string) =>
    esc(t)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        '<a href="$2" rel="noopener noreferrer nofollow">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); list = want; out.push(`<${want}>`); }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

/**
 * Build normalized plain text + span map from sanitized HTML.
 * Plain text rules: block boundaries become single \n; inline tags vanish;
 * entities decode; whitespace collapses. Every kept character records its
 * html offset so highlights can be projected back.
 */
export function normalize(html: string): { plain: string; spanMap: SpanMapEntry[] } {
  const blockish = /<\/?(p|div|h[1-6]|li|ul|ol|blockquote|pre|br|hr|tr|td|th|table)[^>]*>/i;
  const plain: string[] = [];
  const spanMap: SpanMapEntry[] = [];
  let i = 0;
  const n = html.length;

  const push = (ch: string, htmlOffset: number) => {
    plain.push(ch);
    spanMap.push({ plain: plain.length - 1, html: htmlOffset });
  };

  while (i < n) {
    const ch = html[i];
    if (ch === '<') {
      const close = html.indexOf('>', i);
      if (close === -1) break;
      const tag = html.slice(i, close + 1);
      if (blockish.test(tag) && plain.length > 0 && plain[plain.length - 1] !== '\n') push('\n', i);
      i = close + 1;
      continue;
    }
    if (ch === '&') {
      const rel = html.slice(i, i + 10).indexOf(';');
      if (rel !== -1) {
        const ent = html.slice(i, i + rel + 1);
        const decoded = ENTITIES[ent.toLowerCase()];
        if (decoded !== undefined) {
          for (const c of decoded) push(c, i);
          i = i + rel + 1;
          continue;
        }
      }
      push('&', i);
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      // collapse runs of whitespace to one space; newline only from tags
      if (plain.length > 0 && plain[plain.length - 1] !== ' ' && plain[plain.length - 1] !== '\n') {
        push(' ', i);
      }
      i++;
      continue;
    }
    push(ch, i);
    i++;
  }

  return { plain: plain.join('').trim(), spanMap };
}

export function normalizeDraft(input: string, format: 'html' | 'markdown' = 'markdown'): Normalized {
  const html = format === 'html' ? sanitizeHtml(input) : sanitizeHtml(markdownToHtml(input));
  const { plain, spanMap } = normalize(html);
  return { html, plain, spanMap, sha256: sha256(plain) };
}

/** Project a plain-text [start,end) range to sanitized-html offsets via the span map. */
export function toHtmlRange(spanMap: SpanMapEntry[], start: number, end: number): [number, number] | null {
  if (spanMap.length === 0) return null;
  let lo: SpanMapEntry | null = null;
  let hi: SpanMapEntry | null = null;
  for (const e of spanMap) {
    if (e.plain >= start && lo === null) lo = e;
    if (e.plain < end) hi = e;
  }
  if (!lo || !hi) return null;
  return [lo.html, hi.html + 1];
}
