/**
 * Deterministic accessibility checks on sanitized draft HTML (Round 3
 * improvement 2). Pure functions over the SAME sanitized HTML the review
 * stores — no headless browser, no model. Complements the contrast-ratio
 * arithmetic in rules/engine.ts.
 *
 * Scope (deterministic, honest): inline colour contrast (WCAG AA thresholds,
 * including the large-text 3.0 rule), images missing alt text, skipped
 * heading levels, and links with no discernible text. NOT covered and never
 * claimed: focus order, ARIA semantics, keyboard traps, screen-reader
 * behaviour. Those need a real browser audit and are listed as out of scope
 * wherever results are shown.
 */

import { contrastRatio } from './engine';

export interface AccessibilityFinding {
  rule: 'a11y:contrast' | 'a11y:img-alt' | 'a11y:heading-order' | 'a11y:empty-link';
  severity: 'error' | 'warn';
  /** short excerpt identifying the element (not a plain-text offset) */
  excerpt: string;
  explanation: string;
}

interface StyleDecl {
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  fontWeight?: string;
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  navy: [0, 0, 128], teal: [0, 128, 128], maroon: [128, 0, 0], olive: [128, 128, 0],
  purple: [128, 0, 128], yellow: [255, 255, 0], lime: [0, 255, 0], aqua: [0, 255, 255],
  cyan: [0, 255, 255], fuchsia: [255, 0, 255], magenta: [255, 0, 255], orange: [255, 165, 0],
};

function parseColor(v: string): [number, number, number] | null {
  const s = v.trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  const hex6 = /^#([0-9a-f]{6})$/.exec(s);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hex3 = /^#([0-9a-f]{3})$/.exec(s);
  if (hex3) {
    const [r, g, b] = hex3[1].split('').map((c) => parseInt(c + c, 16));
    return [r, g, b];
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)/.exec(s);
  if (rgb) {
    // alpha < 1 makes the effective color non-deterministic: skip, never guess
    if (rgb[4] !== undefined && parseFloat(rgb[4]) < 1) return null;
    return [+rgb[1], +rgb[2], +rgb[3]];
  }
  return null; // gradients, transparent, system colors: out of deterministic scope
}

function parseStyle(attr: string): StyleDecl {
  const out: StyleDecl = {};
  for (const m of attr.matchAll(/([a-z-]+)\s*:\s*([^;"]+)/gi)) {
    const prop = m[1].trim().toLowerCase();
    const val = m[2].trim();
    if (prop === 'color') out.color = val;
    else if (prop === 'background-color') out.backgroundColor = val;
    else if (prop === 'font-size') out.fontSize = val;
    else if (prop === 'font-weight') out.fontWeight = val;
  }
  return out;
}

function isLargeText(decl: StyleDecl): boolean {
  const pt = /^([\d.]+)pt/.exec(decl.fontSize ?? '');
  const px = /^([\d.]+)px/.exec(decl.fontSize ?? '');
  const weight = parseInt(decl.fontWeight ?? '400', 10);
  const bold = weight >= 700;
  if (pt) return parseFloat(pt[1]) >= 18 || (bold && parseFloat(pt[1]) >= 14);
  if (px) return parseFloat(px[1]) >= 24 || (bold && parseFloat(px[1]) >= 18.66);
  return false;
}

export function runAccessibilityChecks(html: string): AccessibilityFinding[] {
  const out: AccessibilityFinding[] = [];

  // contrast: every text node's effective color vs effective background,
  // resolved from the element stack (declared styles win over inherited)
  const stack: Array<{ tag: string; decl: StyleDecl }> = [];
  const tagRe = /<\/?([a-z0-9]+)([^>]*)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  let textBuf = '';
  const emitContrast = () => {
    if (!textBuf.trim() || stack.length === 0) { textBuf = ''; return; }
    let color: [number, number, number] | null = null;
    let bg: [number, number, number] | null = null;
    let large = false;
    // CSS resolves innermost-declared first: walk the stack inside-out
    for (let i = stack.length - 1; i >= 0; i--) {
      const s = stack[i];
      if (!color && s.decl.color) color = parseColor(s.decl.color);
      if (!bg && s.decl.backgroundColor) bg = parseColor(s.decl.backgroundColor);
      if (!large && (s.decl.fontSize || s.decl.fontWeight)) large = isLargeText(s.decl);
    }
    if (color && bg) {
      const ratio = contrastRatio(color, bg);
      const threshold = large ? 3.0 : 4.5;
      if (ratio < threshold) {
        out.push({
          rule: 'a11y:contrast',
          severity: ratio < 3.0 && !large ? 'error' : 'warn',
          excerpt: `"${textBuf.trim().slice(0, 60)}" — contrast ${ratio.toFixed(2)}:1`,
          explanation: `Text contrast ${ratio.toFixed(2)}:1 is below the WCAG AA threshold (${threshold}:1${large ? ', large text' : ''}) for its declared colours. Deterministic check on inline styles only.`,
        });
      }
    }
    textBuf = '';
  };
  while ((m = tagRe.exec(html)) !== null) {
    if (m[1] !== undefined) {
      emitContrast();
      const tag = m[1].toLowerCase();
      const attrs = m[2] ?? '';
      if (m[0][1] === '/') {
        const idx = stack.map((s) => s.tag).lastIndexOf(tag);
        if (idx !== -1) stack.length = idx;
      } else if (!m[0].endsWith('/>')) {
        stack.push({ tag, decl: parseStyle(attrs) });
        if (['img', 'br', 'hr', 'input', 'meta', 'link'].includes(tag)) stack.pop();
      }
      if (tag === 'img') {
        const alt = /(^|\s)alt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
        const src = /src\s*=\s*"([^"]*)"/i.exec(attrs);
        if (!alt) {
          out.push({
            rule: 'a11y:img-alt',
            severity: 'error',
            excerpt: `<img ${src?.[1]?.slice(0, 40) ?? 'no src'}>`,
            explanation: 'Image has no alt attribute. Deterministic check: every image needs alt text (or alt="" if decorative).',
          });
        }
      }
    } else {
      textBuf += m[3];
    }
  }
  emitContrast();

  // heading order: no skipped levels (h1 -> h3 etc.)
  let lastLevel = 0;
  for (const hm of html.matchAll(/<h([1-6])[\s>]/gi)) {
    const level = +hm[1];
    if (lastLevel > 0 && level > lastLevel + 1) {
      out.push({
        rule: 'a11y:heading-order',
        severity: 'warn',
        excerpt: `h${lastLevel} followed by h${level}`,
        explanation: `Heading level skipped from h${lastLevel} to h${level}. Screen-reader users navigate by heading hierarchy; steps should not skip levels.`,
      });
    }
    lastLevel = level;
  }

  // links with no discernible text (an image with non-empty alt IS discernible)
  for (const lm of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const inner = lm[2]
      .replace(/<img\b[^>]*alt\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (_m, _q, dq: string | undefined, sq: string | undefined) => (dq ?? sq ?? '').trim())
      .replace(/<[^>]*>/g, '')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .trim();
    const labelled = /aria-label\s*=\s*("[^"]{1,80}"|'[^']{1,80}')/i.test(lm[1]);
    if (!inner && !labelled) {
      out.push({
        rule: 'a11y:empty-link',
        severity: 'error',
        excerpt: `<a ${lm[1].trim().slice(0, 40)}>`,
        explanation: 'Link has no text content for screen readers. Deterministic check: every link needs discernible text or an aria-label.',
      });
    }
  }

  // identical findings collapse (sibling text nodes in one styled element)
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${f.rule}:${f.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
