/**
 * Round 3 improvement 2: deterministic accessibility lane.
 * Includes the planted-violation measurement the Round 1 plan committed to
 * ("at least 91.7% of planted violations caught, precision at least 95%").
 * The dataset below IS that measurement: 19 planted violations (contrast 8,
 * img-alt 5, heading-order 3, empty-link 2, sibling-contrast 1) across 21
 * fixtures, plus 9 clean controls. Assertions pin the exact measured
 * numbers — a regression fails, an improvement requires a deliberate
 * update of this file.
 */

import { describe, expect, it } from 'vitest';
import { runAccessibilityChecks, type AccessibilityFinding } from '../src/lib/rules/accessibility';
import { runReview } from '../src/lib/pipeline/review';
import { RULES, FACTS } from '../seed/meridian-flow';

const ruleOf = (f: AccessibilityFinding) => f.rule;

describe('unit behavior per check', () => {
  it('flags low contrast (normal text)', () => {
    const f = runAccessibilityChecks('<p style="color:#999999;background-color:#ffffff">faint text</p>');
    expect(f.filter((x) => x.rule === 'a11y:contrast')).toHaveLength(1);
  });
  it('passes AA-compliant contrast', () => {
    const f = runAccessibilityChecks('<p style="color:#1a3a5c;background-color:#ffffff">solid text</p>');
    expect(f.filter((x) => x.rule === 'a11y:contrast')).toHaveLength(0);
  });
  it('applies the large-text 3.0 threshold', () => {
    const large = '<p style="color:#777777;background-color:#ffffff;font-size:24pt">big faint</p>';
    const normal = '<p style="color:#777777;background-color:#ffffff">small faint</p>';
    expect(runAccessibilityChecks(large).filter((x) => x.rule === 'a11y:contrast')).toHaveLength(0);
    expect(runAccessibilityChecks(normal).filter((x) => x.rule === 'a11y:contrast')).toHaveLength(1);
  });
  it('resolves inherited colors from ancestors', () => {
    const f = runAccessibilityChecks('<div style="color:#aaaaaa;background-color:#ffffff"><p>inherited faint</p></div>');
    expect(f.filter((x) => x.rule === 'a11y:contrast')).toHaveLength(1);
  });
  it('skips non-deterministic color forms silently (gradients)', () => {
    const f = runAccessibilityChecks('<p style="color:transparent;background-color:#fff">ghost</p>');
    expect(f.filter((x) => x.rule === 'a11y:contrast')).toHaveLength(0);
  });
  it('flags images without alt', () => {
    const f = runAccessibilityChecks('<img src="logo.png">');
    expect(f.filter((x) => x.rule === 'a11y:img-alt')).toHaveLength(1);
    expect(runAccessibilityChecks('<img src="logo.png" alt="Meridian Flow logo">')).toHaveLength(0);
    expect(runAccessibilityChecks('<img src="divider.png" alt="">')).toHaveLength(0);
  });
  it('flags skipped heading levels', () => {
    const f = runAccessibilityChecks('<h1>Title</h1><h3>Sub</h3>');
    expect(f.filter((x) => x.rule === 'a11y:heading-order')).toHaveLength(1);
    expect(runAccessibilityChecks('<h1>Title</h1><h2>Sub</h2>')).toHaveLength(0);
  });
  it('flags links with no discernible text', () => {
    expect(runAccessibilityChecks('<a href="https://x.example"></a>').filter((x) => x.rule === 'a11y:empty-link')).toHaveLength(1);
    expect(runAccessibilityChecks('<a href="https://x.example" aria-label="docs"></a>')).toHaveLength(0);
    expect(runAccessibilityChecks('<a href="https://x.example">documentation</a>')).toHaveLength(0);
  });
});

// ---------------- planted-violation measurement dataset ----------------

interface Planted {
  html: string;
  rules: AccessibilityFinding['rule'][];
}

const PLANTED: Planted[] = [
  { html: '<p style="color:#cccccc;background-color:#ffffff">pale on white</p>', rules: ['a11y:contrast'] },
  { html: '<p style="color:#888888;background-color:#f5f5f5">grey on grey</p>', rules: ['a11y:contrast'] },
  { html: '<span style="color:#b0b0b0;background-color:#eeeeee">tiny label</span>', rules: ['a11y:contrast'] },
  { html: '<p style="color:#ffcc00;background-color:#ffffff">yellow on white</p>', rules: ['a11y:contrast'] },
  { html: '<div style="background-color:#333333"><p style="color:#555555">dark on dark</p></div>', rules: ['a11y:contrast'] },
  { html: '<p style="color:#777777;background-color:#ffffff;font-size:14pt">medium faint</p>', rules: ['a11y:contrast'] },
  { html: '<img src="chart.png">', rules: ['a11y:img-alt'] },
  { html: '<img src="team.jpg">', rules: ['a11y:img-alt'] },
  { html: '<img src="diagram.png">', rules: ['a11y:img-alt'] },
  { html: '<h1>Report</h1><h3>Section</h3>', rules: ['a11y:heading-order'] },
  { html: '<h2>A</h2><h4>B</h4>', rules: ['a11y:heading-order'] },
  { html: '<h1>Doc</h1><h2>S1</h2><h4>S1.1</h4>', rules: ['a11y:heading-order'] },
  { html: '<a href="https://example.meridianflow.dev/x"></a>', rules: ['a11y:empty-link'] },
  { html: '<a href="https://example.meridianflow.dev/y"><img src="icon.png"></a>', rules: ['a11y:empty-link', 'a11y:img-alt'] },
  { html: '<p style="color:#99aabb;background-color:#ffffff">blue-grey pale</p>', rules: ['a11y:contrast'] },
  { html: '<img src="banner.png">', rules: ['a11y:img-alt'] },
  { html: '<h5>deep start</h5>', rules: [] }, // deep start is unusual but not a skip: control
  { html: '<a href="https://example.meridianflow.dev/z">read the guide</a>', rules: [] },
  { html: '<p style="color:#000000;background-color:#ffffff">black on white</p>', rules: [] },
  { html: '<h1>H</h1><h2>H2</h2><h3>H3</h3>', rules: [] },
  { html: '<img src="ok.png" alt="chart of uptime">', rules: [] },
  { html: '<p>plain paragraph, no styling</p>', rules: [] },
  { html: '<a href="https://example.meridianflow.dev/a" aria-label="pricing"></a>', rules: [] },
  { html: '<p style="color:#ffffff;background-color:#1a3a5c">white on navy</p>', rules: [] },
  { html: '<img src="spacer.png" alt="">', rules: [] },
  // reviewer D4 counterexamples (added after the fix, pinned by exact numbers)
  { html: '<div style="color:#cccccc;background-color:#ffffff"><p style="color:#000000">fine text</p></div>', rules: [] },
  { html: '<div style="color:#000000;background-color:#ffffff"><p style="color:#cccccc">pale text</p></div>', rules: ['a11y:contrast'] },
  { html: '<a href="https://x.example"><img src="i.png" alt="Home"></a>', rules: [] },
  { html: '<p style="color:#cccccc;background-color:rgba(255,255,255,0)">transparent bg</p>', rules: [] },
  { html: '<p style="color:#cccccc;background-color:#ffffff"><b>bold</b> and <i>italic</i> siblings</p>', rules: ['a11y:contrast'] },
];

function measure() {
  let planted = 0;
  let caught = 0;
  let raised = 0;
  let trueRaised = 0;
  for (const p of PLANTED) {
    const found = runAccessibilityChecks(p.html).map(ruleOf);
    const uniqueExpected = [...new Set(p.rules)];
    planted += uniqueExpected.length;
    raised += found.length;
    trueRaised += found.filter((r) => uniqueExpected.includes(r)).length;
    for (const r of uniqueExpected) if (found.includes(r)) caught++;
  }
  return { planted, caught, recall: caught / planted, precision: raised === 0 ? 1 : trueRaised / raised };
}

describe('Round 1 commitment: planted-violation measurement', () => {
  it('catches every planted violation (exact pin: any regression fails)', () => {
    const m = measure();
    expect(m.recall).toBe(1);
  });
  it('raises no false findings (exact pin)', () => {
    const m = measure();
    expect(m.precision).toBe(1);
  });
  it('reports the actual numbers (printed for the submission doc)', () => {
    const m = measure();
    console.log(`[a11y measurement] planted=${m.planted} caught=${m.caught} recall=${(m.recall * 100).toFixed(1)}% precision=${(m.precision * 100).toFixed(1)}%`);
    expect(m.planted).toBe(19);
  });
});

describe('pipeline integration', () => {
  it('accessibility findings flow through the deterministic lane, advisory only', async () => {
    const res = await runReview({
      content: '<img src="x.png">\n\n<h1>Launch</h1><h3>Details</h3>\n\nMeridianFlow update.',
      format: 'html',
      brandRules: RULES,
      approvedFacts: FACTS,
      gateway: { provider: 'none', embed: async () => null, extractClaims: async () => ({ claims: [] }), entailmentJudge: async () => 0 },
    });
    const a11y = res.findings.filter((f) => f.state === 'accessibility_issue');
    expect(a11y.length).toBeGreaterThanOrEqual(2);
    expect(a11y.every((f) => f.lane === 'deterministic' && f.ruleRef?.startsWith('a11y:'))).toBe(true);
  });
});
