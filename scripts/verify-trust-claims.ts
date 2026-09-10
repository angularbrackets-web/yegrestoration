// BK-58 — the trust claims, checked against what actually reaches a browser.
//
//   npm run verify:trust
//
// WHY THIS RUNS OVER `dist/` AND NOT OVER `src/`.
//
// The two false claims this ticket removed had TWO GRAMMARS and only one of
// them was prose. A grep for the sentence "Since 2008" found five pages; the
// structured-data assertion `"foundingDate": "2008"` was on all seventeen,
// because `seo.ts` emits it site-wide, and the BBB badge was on all seventeen
// because it lived in the footer. A human auditing the rendered text would have
// cleared twelve pages that were making the claim to Google.
//
// So the corpus is the BUILD, and the shapes are matched against raw file text
// rather than against extracted prose — JSON-LD is not prose and is exactly
// where the site-wide instance lived.
//
// ── THE RULE THIS FILE EXISTS TO OBEY ──────────────────────────────────────
//
// A NEGATIVE CHECK WITH NO POSITIVE TWIN PASSES ON AN EMPTY DOCUMENT.
//
// G1, G2, G3 and G6's ban are all satisfied by a build that produced nothing,
// by a page that failed to render, and by deleting the badge arrays outright.
// G4, G5 and G7 are the controls that make the bans mean something:
//
//   * G4 proves the TRUE form of the experience claim survived, so "no 2008"
//     was not achieved by deleting the client's genuine selling point.
//   * G5 proves the two SUBSTANTIATED badges still render, so "no BBB" was not
//     achieved by emptying the arrays that carry all three.
//   * G7 proves the shared entity description still reaches the about page,
//     which is the one string whose edit propagates.
//
// Each ban below names the control that guards it, in its own message.
//
// ── ONE SHAPE NOTE, AND IT IS LOAD-BEARING ─────────────────────────────────
//
// G2 bans /BBB/i, NOT /BBB Accredited/. `about.astro` spelled the claim out in
// full — "Accredited by the Better Business Bureau." — and a ban shaped for the
// badge text would have walked straight past it. Red-first row R3 is the row
// that proves this, and it is the reason the shape is broader than the string
// the ticket was written about.
//
// Pure: no database, no network. Reads `dist/client` only.
//
// Exits non-zero if any assertion fails.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
let checks = 0;
const check = (ok: boolean, label: string) => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const clientDir = resolve(root, 'dist/client');
if (!existsSync(clientDir)) {
  console.error('✗ dist/client is missing — run `npm run build` first.');
  process.exit(2);
}

const htmlFiles = walk(clientDir).filter((f) => f.endsWith('.html'));
const llmsTxt = resolve(clientDir, 'llms.txt');

// The corpus is the built HTML plus llms.txt, which is the AI-discovery surface
// and carried a seventeenth instance of the founding-year claim that the
// ticket's own inventory missed. It is not an HTML file, so it needs naming.
const corpus: { path: string; text: string }[] = [
  ...htmlFiles.map((f) => ({ path: f.replace(clientDir, ''), text: readFileSync(f, 'utf8') })),
  ...(existsSync(llmsTxt) ? [{ path: '/llms.txt', text: readFileSync(llmsTxt, 'utf8') }] : []),
];

console.log(`\nBK-58 — trust claims over the build (${htmlFiles.length} HTML + llms.txt)\n`);

check(htmlFiles.length === 17, `the build produced 17 HTML pages, got ${htmlFiles.length}`);
check(existsSync(llmsTxt), 'llms.txt is in the build — the AI-discovery surface is in the corpus');

const hits = (re: RegExp) =>
  corpus.filter((f) => re.test(f.text)).map((f) => f.path);

// ── THE BANS ───────────────────────────────────────────────────────────────

const G1 = hits(/"foundingDate"/);
check(
  G1.length === 0,
  `G1 · no page asserts a foundingDate — the site-wide grammar (control: G4). Offenders: ${G1.join(', ') || 'none'}`,
);

// Broader than the badge text on purpose. See the shape note above.
const G2 = hits(/BBB|Better Business Bureau/i);
check(
  G2.length === 0,
  `G2 · no page claims BBB accreditation, in EITHER spelling (control: G5). Offenders: ${G2.join(', ') || 'none'}`,
);

// The firm was founded 2026. Any "since <year>" attached to the COMPANY is
// false whatever the year, so this bans the SUBJECT and not the number.
//
// ⚠️ THIS SHAPE WAS RED ON ARRIVAL TWICE, AND BOTH TIMES THE FIX WAS TO THE
// SHAPE RATHER THAN TO THE COPY. Recorded because the second failure was the
// first failure's fix.
//
//   v1  /(?:serving|operated|in business|established)[^.<]{0,60}since\s+\d{4}/i
//       Fired on "…operated in Edmonton, and our people have been doing this
//       work since 2008." TRUE, and decision 42's approved wording. "operated"
//       and the year are 55 characters apart but sit in different clauses.
//
//   v2  the same idea inverted — an anchor word required within 70 characters
//       BEFORE the year. Fired on the shared entity description, where the
//       anchor "crews" is ~103 characters ahead of "since 2008".
//
// Both versions were tuning a DISTANCE, and distance cannot tell one clause
// from another. The unit that can is the SENTENCE — which is the unit BK-53
// reached independently after trying the block and the whole file (R12-0).
//
// So: split to sentences, find the ones carrying "since <year>", and require
// each to anchor the year to experience rather than to the company. Tags are
// stripped so a sentence broken across markup stays one sentence; script
// CONTENT survives that strip, which matters because JSON-LD carried the
// site-wide instance.
const ANCHORS = /experience|this work|have handled|crews|doing this/i;
const g3Offenders: string[] = [];
for (const f of corpus) {
  const flat = f.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
    if (!/since\s+\d{4}/i.test(sentence)) continue;
    if (ANCHORS.test(sentence)) continue;
    g3Offenders.push(`${f.path} ("${sentence.trim().slice(0, 90)}")`);
  }
}
check(
  g3Offenders.length === 0,
  `G3 · every "since <year>" SENTENCE anchors the year to EXPERIENCE, never to the company (control: G4). Offenders: ${g3Offenders.join(' | ') || 'none'}`,
);

// ── THE CONTROLS ───────────────────────────────────────────────────────────

const G4 = hits(/experience since 2008|this work since 2008|repair since 2008/i);
check(
  G4.length > 0,
  `G4 · POSITIVE TWIN — the TRUE experience claim survives on ${G4.length} page(s). Without this, G1/G3 pass on an empty build`,
);

const G5iicrc = hits(/IICRC/);
const G5lic = hits(/Licensed &(?:amp;)? Insured/i);
check(
  G5iicrc.length > 0 && G5lic.length > 0,
  `G5 · POSITIVE CONTROL — the two SUBSTANTIATED badges still render (IICRC on ${G5iicrc.length}, Licensed & Insured on ${G5lic.length}). Without this, G2 passes on emptied arrays`,
);

// ── THE HOURS PAIR ─────────────────────────────────────────────────────────
//
// A pair, not a ban. The banned string and the required string are asserted
// together, because removing the block entirely would satisfy the ban alone.

const contactPages = corpus.filter((f) => f.path === '/contact/index.html' || f.path === '/index.html');
check(contactPages.length === 2, `the two pages rendering ContactSection are present, got ${contactPages.length}`);

const openClaim = contactPages.filter((f) => /Open 24\/7/.test(f.text)).map((f) => f.path);
check(
  openClaim.length === 0,
  `G6a · no page claims "Open 24/7" under an Hours heading. Offenders: ${openClaim.join(', ') || 'none'}`,
);

const hoursTruth = contactPages.filter((f) => /closed Fridays/i.test(f.text)).map((f) => f.path);
check(
  hoursTruth.length === contactPages.length,
  `G6b · POSITIVE TWIN — the real booking hours render on all ${contactPages.length} of them, got ${hoursTruth.length}`,
);

// Every OTHER 24/7 on the site is about the phone and is true. If this ever
// reaches zero, the fix over-reached and stripped a legitimate claim.
const phoneClaim = hits(/24\/7/);
check(
  phoneClaim.length > 0,
  `G6c · POSITIVE CONTROL — the true 24/7 PHONE claim survives on ${phoneClaim.length} page(s). Decision 35 keeps it`,
);

// ── THE PROPAGATING STRING ─────────────────────────────────────────────────

const about = corpus.find((f) => f.path === '/about/index.html');
check(Boolean(about), 'the about page is in the build');
if (about) {
  check(
    /Our IICRC-certified crews have handled/.test(about.text),
    'G7 · the shared entity description reaches the about page — the one string whose edit propagates',
  );
}

console.log(
  `\n${failures === 0 ? '✓' : '✗'} verify-trust-claims: ${checks - failures}/${checks} checks passed\n`,
);
process.exit(failures === 0 ? 0 : 1);
