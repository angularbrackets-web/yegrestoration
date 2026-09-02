// The BK-10 cutover, checked from two directions.
//
//   npm run verify:cutover
//
// PART 1 — THE CTA SWEEP, over source. After the cutover there is exactly one
// quote door (`/book/`), one question door (the message form on `/contact/`),
// and one emergency door (the phone). A single missed CTA re-opens the second
// quote door, and a single unslashed link costs a 308. Both are invisible to
// the type checker and to every other gate.
//
// The sweep looks for the ENTITY SPELLINGS as well as the plain ones. The three
// blog posts wrote their links as `](/&#35;contact)`, so a literal `#contact`
// grep sees nothing — the plan reviewer's own first pass missed them exactly
// that way.
//
// PART 2 — THE TRACKING BUILD GREP. `import.meta.env.PUBLIC_*` is substituted
// by Vite at build time by matching the SOURCE TEXT, so whether a label reaches
// the browser is a fact about `dist/`, not about `src/`. This script therefore
// runs its own build with sentinel values and greps the client bundle:
//
//   * the FORM sentinel must appear NOWHERE — the Ads form conversion retired.
//   * the BOOKING sentinel MUST appear — the booking conversion is untouched,
//     and its literal-expression read still works (ROADMAP: a helper-wrapped
//     read compiles to `undefined` and fails silently in production).
//
// That build overwrites `dist/` with sentinel-laden output. It is throwaway —
// Vercel builds from source — but do not deploy the tree this leaves behind.
//
// Pure otherwise: no database, no network, no environment beyond what it sets
// for its own build.
//
// Exits non-zero if any assertion fails.

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, extname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
// The ONE import from `src/` in this file, and it earns its place: the `dist/`
// pins below have to find the built chunk that carries the terms copy, and
// naming that chunk by filename is what made an earlier version of those pins
// inert. Matching on the constant's own text follows the copy wherever Vite
// puts it.
import { FEE_TERMS_HEADING as FEE_TERMS_HEADING_TEXT } from '../src/lib/booking-copy';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Walking the source
// ---------------------------------------------------------------------------

const SCANNED = new Set(['.astro', '.svelte', '.ts', '.tsx', '.md', '.mdx']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED.has(extname(entry))) out.push(full);
  }
  return out;
}

const files = walk(resolve(root, 'src'));
check(files.length > 40, `the sweep found source files to scan, got ${files.length}`);

/** One link found in a source file: where it points, and what it says. */
type Link = { file: string; href: string; text: string };

/**
 * Every link in a file, from both spellings the codebase uses.
 *
 * `<a>` elements cover `.astro` and `.svelte`; the markdown form covers the
 * blog `.mdx`. The anchor regex is non-greedy to `</a>` so the captured text
 * belongs to the href that opened it.
 */
function linksIn(file: string, source: string): Link[] {
  const found: Link[] = [];
  const label = relative(root, file);

  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const [, attributes, text] = match;
    const href =
      attributes.match(/href="([^"]*)"/)?.[1] ??
      attributes.match(/href=\{`([^`]*)`\}/)?.[1] ??
      attributes.match(/href=\{'([^']*)'\}/)?.[1] ??
      attributes.match(/href=\{"([^"]*)"\}/)?.[1] ??
      null;
    if (href === null) continue;
    found.push({ file: label, href, text: text.replace(/<[^>]*>/g, ' ') });
  }

  if (file.endsWith('.md') || file.endsWith('.mdx')) {
    for (const match of source.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      found.push({ file: label, href: match[2], text: match[1] });
    }
  }

  return found;
}

const links: Link[] = [];
for (const file of files) links.push(...linksIn(file, readFileSync(file, 'utf8')));
check(links.length > 40, `and links inside them, got ${links.length}`);

// ---------------------------------------------------------------------------
console.log('No CTA anchors at the retired form (AC3)');
// ---------------------------------------------------------------------------
{
  // `#contact` and `#quote` still EXIST as section ids — that is deliberate, so
  // a bookmark or a cached SERP lands on a relevant section rather than
  // nowhere. What may not exist is a LINK to one: the sections they name are
  // booking CTAs now, not forms, so an anchor to them is a funnel that stops.
  const FORBIDDEN = ['#contact', '#quote', '&#35;contact', '&#35;quote'];

  for (const link of links) {
    for (const needle of FORBIDDEN) {
      check(
        !link.href.includes(needle),
        `${link.file}: a link still points at ${needle} ("${link.text.trim().slice(0, 40)}")`,
      );
    }
  }

  // And the entity spellings anywhere at all, link or not — this is the pair a
  // plain grep cannot see, so it gets its own pass over raw text.
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const needle of ['&#35;contact', '&#35;quote']) {
      check(
        !source.includes(needle),
        `${relative(root, file)}: carries the entity spelling ${needle}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\nNo quote-framed CTA points at /contact/ (AC3)');
// ---------------------------------------------------------------------------
{
  // The survivors are message-framed by construction rather than by allowlist:
  // the footer's "request a callback", the pages' "Just have a question?", the
  // booking form's "Send a message". A callback IS a message. What must not
  // survive is a link that promises a quote or an assessment and lands on the
  // form, because that is the second quote door the cutover exists to close.
  const QUOTE_WORDS = /\b(quote|assessment|estimate)\b/i;

  for (const link of links) {
    const path = link.href.split(/[?#]/)[0];
    if (path !== '/contact/' && path !== '/contact') continue;
    check(
      !QUOTE_WORDS.test(link.text),
      `${link.file}: a quote-framed CTA points at /contact/ — "${link.text.trim().slice(0, 60)}"`,
    );
  }
}

// ---------------------------------------------------------------------------
console.log('\nEvery internal link is slashed (AC3)');
// ---------------------------------------------------------------------------
{
  // `trailingSlash: 'always'`, so an unslashed internal href 308s. File routes
  // are exempt because they are files: /rss.xml and /llms.txt have extensions
  // and Astro does not normalize them.
  for (const link of links) {
    const path = link.href.split(/[?#]/)[0];
    if (!path.startsWith('/')) continue; // tel:, mailto:, https:, bare #hash
    if (path === '/') continue;
    if (extname(path) !== '') continue; // /rss.xml, /favicon.svg, /llms.txt
    check(path.endsWith('/'), `${link.file}: ${link.href} is unslashed — it will 308`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nThe doors themselves (AC3, AC5)');
// ---------------------------------------------------------------------------
{
  function read(file: string): string {
    const path = resolve(root, file);
    check(existsSync(path), `${file} exists`);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  // `servicePath` is asserted against its source rather than by calling it:
  // `services.ts` imports `.jpg` assets through Vite, which `tsx` cannot
  // resolve. The line is short enough that reading it is not a weaker check.
  const services = read('src/data/services.ts');
  const servicePathLine = services
    .split('\n')
    .find((line) => line.includes('export const servicePath'));
  check(servicePathLine !== undefined, 'servicePath is where this check expects it');
  check(
    servicePathLine?.includes("'/book/'") === true,
    `servicePath falls back to /book/, got: ${servicePathLine?.trim()}`,
  );
  check(
    servicePathLine?.includes("'/contact/'") === false,
    'and no longer to /contact/ — an unpaged service is quote intent',
  );

  const form = read('src/components/ContactForm.svelte');
  check(
    form.includes("fetch('/api/contact/'"),
    'the message form posts to the SLASHED endpoint — the ROADMAP-named 308',
  );
  check(!form.includes("fetch('/api/contact'"), 'and not to the unslashed one');
  check(!form.includes('defaultService'), 'the defaultService prop is gone with its only pass site');
  check(
    form.includes("'generate_lead'"),
    'GA4 generate_lead survives the reframe under its old name',
  );
  check(
    !form.includes("'conversion'"),
    'and the Google Ads conversion event does NOT — bidding follows bookings now',
  );

  const bar = read('src/components/MobileCallBar.astro');
  check(bar.includes("bookHref = '/book/'"), 'the mobile bar defaults to a real URL, not an anchor');
  check(!bar.includes("'#quote'"), 'and its stale #quote default is gone');

  // AC5's other half: nothing anywhere still READS the retired label. The
  // needle is the read expression, not the bare name — `env.d.ts` and this
  // file both mention it in prose explaining that it is gone, and a check that
  // forbade the name would forbid the explanation.
  for (const file of files) {
    check(
      !readFileSync(file, 'utf8').includes('env.PUBLIC_AW_FORM_LABEL'),
      `${relative(root, file)}: still reads PUBLIC_AW_FORM_LABEL`,
    );
  }
  // The ROADMAP's permanent invariant — every Resend call goes through
  // booking-notify's adapter, because a direct call re-imports the
  // swallowed-`{error}` defect — was scan-pinned for reply.ts only
  // (implementation-review should-fix). Pin it store-wide: a fresh
  // `new Resend(` or `.emails.send(` anywhere else in src/ is the trap
  // coming back, whatever file it lands in.
  // Comments are stripped first, for the same reason the label sweep matches
  // the read expression: `contact.ts` and `lead-reply.ts` both EXPLAIN the
  // trap in prose that names the forbidden call, and a check that forbade the
  // words would forbid the explanation.
  const RESEND_HOME = 'src/lib/booking-notify.ts';
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const file of files) {
    const rel = relative(root, file);
    if (rel === RESEND_HOME) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    check(
      !code.includes('new Resend(') && !code.includes('.emails.send('),
      `${rel}: calls Resend directly — every send goes through booking-notify's adapter`,
    );
  }

  const envTypes = read('src/env.d.ts');
  check(
    !/readonly PUBLIC_AW_FORM_LABEL/.test(envTypes),
    'PUBLIC_AW_FORM_LABEL is declared nowhere in env.d.ts',
  );
  check(
    /readonly PUBLIC_AW_BOOKING_LABEL/.test(envTypes),
    'while the booking label is still declared',
  );

  // The literal-expression rule. A helper-wrapped read compiles to `undefined`
  // in the client bundle and fails silently in production; part 2 proves the
  // substitution happened, and this pins the spelling that makes it possible.
  const handoff = read('src/lib/booking-handoff.ts');
  check(
    handoff.includes('import.meta.env.PUBLIC_AW_BOOKING_LABEL'),
    'booking-handoff.ts reads the booking label as a literal expression',
  );
  check(!handoff.includes("readEnv('PUBLIC"), 'and never through readEnv — that is the server rule');
}

// ---------------------------------------------------------------------------
console.log('\n/book/ is indexed; /book/confirmed/ is not (AC4)');
// ---------------------------------------------------------------------------
{
  // The `<Layout …>` tag itself, not the file: both pages carry prose about
  // noindex, and a whole-file grep cannot tell a policy from a comment about
  // one. The rendered `<meta name="robots">` is checked separately in part 2 —
  // this is the source-level half of the same claim.
  function layoutTag(file: string): string {
    const source = readFileSync(resolve(root, file), 'utf8');
    return source.match(/<Layout\b[^>]*>/)?.[0] ?? '';
  }

  const book = readFileSync(resolve(root, 'src/pages/book.astro'), 'utf8');
  check(layoutTag('src/pages/book.astro') !== '', '/book/ renders through Layout');
  check(!layoutTag('src/pages/book.astro').includes('noindex'), '/book/ passes no noindex');
  check(book.includes('breadcrumbSchema('), 'and has the breadcrumb every other page has');
  check(book.includes("'@type': 'WebPage'"), 'and WebPage JSON-LD');

  check(
    layoutTag('src/pages/book/confirmed.astro').includes('noindex={true}'),
    '/book/confirmed/ keeps its noindex, by design',
  );

  const config = readFileSync(resolve(root, 'astro.config.mjs'), 'utf8');
  check(
    !config.includes("endsWith('/book/')"),
    'the sitemap no longer excludes /book/ — it is the quote path now',
  );
  check(
    config.includes("endsWith('/book/confirmed/')"),
    'while /book/confirmed/ stays excluded, permanently',
  );
}

// ---------------------------------------------------------------------------
console.log('\nThe fee terms reach both booking surfaces (BK-27)');
// ---------------------------------------------------------------------------
{
  // The client's decision was that the terms appear on `/book/` AND on the
  // homepage booking section. Nothing else asserts that: the email script
  // checks the confirmation, the payload and form scripts check the rule, and
  // a surface that silently stopped rendering the box would keep every one of
  // them green while the customer ticks a checkbox agreeing to terms they were
  // never shown.
  //
  // The pin is on the CONSTANTS, not on the prose — the wording is placeholder
  // pending client sign-off, and a pin on the sentences would fail the day they
  // sign it off. Comments AND import lines are stripped first: an import line
  // mentions the identifier without rendering anything, which is the BK-14 trap
  // where a pin was satisfied by the import it was meant to prove was used.
  //
  // THE `//` RULE IS NOT `/\/\/[^\n]*/`, and the difference is a hole a review
  // walked through. That form is right for frontmatter, where `//` starts a
  // comment — but this helper is also applied to the rendered TEMPLATE, where
  // `//` most often appears inside `https://`. Everything after the scheme on
  // that line then vanishes, so any banned phrase authored on the same line as
  // an absolute URL is invisible to the pins below. Demonstrated, not theorised:
  // a reviewer put `<a href="https://yegrestoration.ca/book/" …><span>Book a
  // Free Assessment</span>` on one line in `ContactSection.astro` and this file
  // passed green while the phrase rendered into `dist/` on the homepage CTA
  // card. It was already eating the tails of the `xmlns="http://…"` lines in
  // that template.
  //
  // The lookbehind-free fix: only treat `//` as a comment when it is not
  // preceded by `:`. Keeps the frontmatter behaviour, drops the hole.
  // The terms block, in render order. BK-36 split FEE_TERMS_OUTRO into the last
  // three; the order they appear in this array IS the constraint every surface
  // is held to.
  const TERMS_CONSTANTS = [
    'FEE_TERMS_HEADING',
    'FEE_TERMS_INTRO',
    'FEE_TERMS_ITEMS',
    'FEE_TERMS_PAYMENT',
    'FEE_TERMS_REFUND',
    'FEE_TERMS_CREDIT',
  ] as const;

  // Asserts the chain rather than the pair. Reads the STRIPPED source, so an
  // import line listing the constants alphabetically cannot satisfy it — that
  // is the BK-14 trap, and the alphabetical import in every one of these files
  // would otherwise pass this check while the template rendered them backwards.
  const checkTermsOrder = (code: string, label: string) => {
    for (let i = 1; i < TERMS_CONSTANTS.length; i++) {
      const prev = code.indexOf(TERMS_CONSTANTS[i - 1]);
      const here = code.indexOf(TERMS_CONSTANTS[i]);
      check(
        prev >= 0 && here > prev,
        `${label}: renders ${TERMS_CONSTANTS[i]} after ${TERMS_CONSTANTS[i - 1]} — the block must end on the credit`,
      );
    }
  };

  const stripForUse = (s: string) =>
    s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');

  // Entity-normalised before any prose pin reads it: `Free&nbsp;Assessment`
  // renders identically to `Free Assessment` and would slip a `\s`-based regex.
  const normalise = (s: string) => s.replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, ' ');

  // Rendered template only — frontmatter stripped. Defined here rather than
  // beside its first prose pin because three separate blocks below need it.
  const templateOf = (src: string, file: string) => {
    const lines = src.split('\n');
    const fences = lines.reduce<number[]>((a, l, i) => (l.trim() === '---' ? [...a, i] : a), []);
    check(fences.length >= 2 && fences[0] === 0, `${file}: frontmatter fences are where this file expects them`);
    return lines.slice(fences[1] + 1).join('\n');
  };

  for (const file of ['src/pages/book.astro', 'src/sections/ContactSection.astro']) {
    const code = stripForUse(readFileSync(resolve(root, file), 'utf8'));
    // PAYMENT, REFUND and CREDIT are in this list, not appended to it as an
    // afterthought: between them they carry when the money moves, the 24-hour
    // refund window, and the credit. A surface that renders the tiers but drops
    // one of them shows a customer three prices and only part of the terms
    // attached to them, which is worse than showing nothing.
    //
    // (They were one constant, FEE_TERMS_OUTRO, until BK-36. It was split
    // rather than edited because its second line ENDED the block on
    // non-refundability, and the block has to end on the credit.)
    for (const constant of TERMS_CONSTANTS) {
      check(code.includes(constant), `${file} renders ${constant}`);
    }

    // ORDER, not just presence. "The block ends on the credit" is an ordering
    // claim — refund and no-refund language sits in the MIDDLE so the last
    // thing read is the good news — and a presence loop cannot tell that apart
    // from the reverse. Same chain is pinned on the island below and in both
    // arms of both customer emails by `verify-booking-email.ts`.
    checkTermsOrder(code, file);
  }

  // …and `/contact/` does not. It renders the message form, not a booking
  // surface, and assessment pricing beside "send us a message" prices a
  // question. The homepage and `/contact/` share `ContactSection.astro`, so
  // this is a claim about which ARM of the `showForm` ternary the block sits
  // in — the one thing a careless edit to that file would break.
  //
  // ANCHORED ON `) : (`, THE ARM BOUNDARY — not on `showForm ? (`, which is
  // where the first version of this check anchored and is why it did not
  // enforce its own claim. `showForm ? (` is the start of the whole ternary,
  // so everything after it spans BOTH arms: the block could be moved into the
  // form arm, rendering assessment pricing on `/contact/`, and this stayed
  // green. Found by the implementation review, which proved it by planting the
  // block in the form arm rather than reasoning about it — and the red pass had
  // not caught it because breaking it in the shared left column confirms only
  // the weaker "not outside the ternary" property while reading like the
  // stronger one. An assertion's red must break the thing it actually claims.
  //
  // Stripped, so the frontmatter's own `import { FEE_TERMS_… }` is not read as
  // a rendering — the same trap the pin above avoids, one file further on.
  const section = stripForUse(readFileSync(resolve(root, 'src/sections/ContactSection.astro'), 'utf8'));
  const boundary = section.indexOf(') : (');
  check(boundary > 0, "the ternary's form/CTA arm boundary is where this file expects it");
  // EVERY terms constant, not just ITEMS. The first version tested
  // `FEE_TERMS_ITEMS` alone, so the constant carrying the non-refundable term
  // could be rendered in the form arm and appear on `/contact/` beside "Send Us
  // a Message" with this gate green. BK-36 split that constant into three, so
  // the list is the whole block rather than a pair.
  for (const constant of TERMS_CONSTANTS) {
    check(
      section.slice(boundary).includes(constant),
      `${constant} sits in the CTA-card arm, which only the homepage renders`,
    );
    check(
      !section.slice(0, boundary).includes(constant),
      `and ${constant} never in the message-form arm, which is what /contact/ renders`,
    );
  }
  // The claim the terms contradict, pinned on the two surfaces this ticket
  // owns. "No obligation" is FALSE — under the credit model EVERY customer owes
  // the fee at the visit, and it is only credited back if they go ahead; the
  // obligation is not contingent on declining. (The phrase originally went out
  // because declining carried a potential $699 under the superseded waiver
  // model. The reason changed; the phrase is if anything more false now.) It
  // survived BK-27's first pass in `ContactSection.astro`'s own lead paragraph,
  // one screen above the box that prices the visit (implementation review,
  // blocker 1). Copy is only ever as true as the last person to remember it, so
  // this is the reader that remembers.
  //
  // Deliberately NOT site-wide: ~50 other unqualified "free assessment" claims
  // are a recorded Known trap with a client decision attached, and a sweep that
  // fails on all of them would be turned off within a day. Two files, the two
  // that render the terms.
  for (const file of ['src/pages/book.astro', 'src/sections/ContactSection.astro']) {
    const prose = stripForUse(readFileSync(resolve(root, file), 'utf8'));
    check(
      !/no obligation/i.test(prose),
      `${file}: says "no obligation", which the fee terms it renders contradict`,
    );
  }

  // The same reader, for the claim the 2026-08-14 pricing model falsified.
  //
  // Under the old model "free assessment" was conditionally true — free for the
  // customers who went ahead — and the CTA button and headings that said it were
  // parked for the client (BK-27 Q9). Under the credit model NOBODY gets a free
  // assessment at the point of sale: every customer pays — under P9 on a link
  // before the visit rather than at it — and the fee is credited back
  // afterwards. So these strings are now false, and two of them
  // sat in the same card as the box that prices the visit.
  //
  // RENDERED TEMPLATE ONLY, and the boundary is the point. `book.astro`'s
  // frontmatter still carries "Book a Free Assessment" in its <title> and its
  // WebPage schema `name` — deliberately, because those are the page's SEARCH
  // surface and are BK-29's to sweep with the other ~50 site-wide claims.
  // Pinning the whole file would fail on them today and the pin would be
  // deleted by Monday.
  //
  // The criterion is RENDERED-vs-SEARCH surface. Stating it plainly because an
  // earlier version of this comment justified the split by "a contradiction in
  // the priced box's own section", which does not actually produce this
  // boundary — the <title> is in the same FILE as the priced box and is left
  // alone. Rendered-vs-search is the line that was really drawn.
  //
  // WHAT THIS DOES NOT ENFORCE, because an earlier version of this comment
  // claimed it did: it is NOT true that "no visitor reads 'free assessment' on
  // the same screen as the price". This pin reads FILE TEXT, not the rendered
  // component tree, and `book.astro` mounts <Navbar />, whose desktop pill and
  // drawer both say it — `dist/client/book/index.html` currently contains the
  // phrase 7 times. That does not ship, because BK-29 is a declared hard
  // blocker on this ticket's deploy and owns `Navbar.svelte`. But the claim was
  // wrong and the kind of wrong that gets copied forward, so: this pin stops
  // these two FILES from reintroducing the phrase. Whole-page coverage is
  // BK-29's, and it will need to read `dist/`, not source.
  for (const file of ['src/pages/book.astro', 'src/sections/ContactSection.astro']) {
    const raw = readFileSync(resolve(root, file), 'utf8');
    const template = normalise(stripForUse(templateOf(raw, file)));
    check(
      !/free\s+assessment/i.test(template),
      `${file}: renders "free assessment", which is false under the credit model`,
    );
  }

  // THE THIRD SURFACE, and the only one that carries the checkbox.
  //
  // The two pins above cover the `.astro` surfaces and the email script covers
  // both mail bodies — which left the island, where the acknowledgment actually
  // happens, covered by nothing. A review deleted the whole terms box from step
  // 3 and every gate stayed green, `svelte-check` included (the orphaned
  // imports raise no error). The customer would reach step 3, read
  // FEE_TERMS_ACK_LABEL — "I understand the assessment terms above." — with
  // nothing above it, tick it, and have `terms_acked_at` stamped against terms
  // never shown.
  //
  // The file's own comment already calls the box-then-checkbox adjacency an
  // invariant and "a claim about this markup". This is that claim's gate.
  // ORDER IS ASSERTED, not just presence: a box rendered BELOW the checkbox
  // satisfies every `includes` while making the label's "above" a lie.
  const island = stripForUse(readFileSync(resolve(root, 'src/components/BookingForm.svelte'), 'utf8'));
  for (const constant of [...TERMS_CONSTANTS, 'FEE_TERMS_ACK_LABEL']) {
    check(island.includes(constant), `the booking island renders ${constant}`);
  }
  checkTermsOrder(island, 'the booking island');
  const boxAt = island.indexOf('FEE_TERMS_HEADING');
  const ackAt = island.indexOf('FEE_TERMS_ACK_LABEL');
  const outroAt = island.indexOf('FEE_TERMS_CREDIT');
  check(
    boxAt > 0 && ackAt > boxAt,
    'the island\'s terms box renders ABOVE its acknowledgment label, which is what that label claims',
  );
  check(
    outroAt > 0 && ackAt > outroAt,
    'and the credit — the LAST line of the terms prose — is above it too, not stranded below the checkbox',
  );
  check(
    island.includes('values.termsAck'),
    'and the checkbox is still bound to the field the server enforces',
  );

  // BK-31, and the same gate for the same reason one step later.
  //
  // The tier picker went in with NO assertion anywhere: a review deleted the
  // whole fieldset and the quote block and typecheck plus four verify scripts
  // stayed green. That failure is worse than the terms-box one above, because
  // the server REQUIRES the tier — a public booking with the control missing
  // 422s with `field: assessment_tier`, `FIELD_STEPS` routes the visitor to
  // step 3, and step 3 no longer contains anything that can set it. The funnel
  // is 100% dead with every gate passing.
  //
  // These are presence-and-order pins, deliberately not a recomputation of the
  // price: an assertion that calls `assessmentQuote` to check a number
  // `assessmentQuote` produced moves both sides together and cannot go red.
  // What is pinned instead is that the island's figures COME FROM that function
  // and from nowhere else, which is the property a wrong number would break.
  for (const constant of [
    'ASSESSMENT_TIER_LEGEND',
    'ASSESSMENT_TIERS',
    'ASSESSMENT_TIER_NAMES',
    'QUOTE_HEADING',
    'AFTER_HOURS_NOTE',
  ]) {
    check(island.includes(constant), `the booking island renders ${constant}`);
  }
  check(
    island.includes('values.assessmentTier'),
    'the tier radios are bound to the field the server enforces',
  );
  const tierAt = island.indexOf('ASSESSMENT_TIER_LEGEND');
  check(
    tierAt > 0 && tierAt > outroAt && ackAt > tierAt,
    'the tier picker renders inside the terms box and ABOVE the acknowledgment label, which is what "the terms above" claims of it',
  );

  // AC10 — the displayed figure is `assessmentQuote`'s, not a second
  // calculation. Every rendered amount goes through `formatCents` over a field
  // of a quote object; a hand-rolled multiply or a hard-coded price in the
  // island would be a number that can disagree with the charge.
  check(
    island.includes('formatCents(quote.totalCents)') &&
      island.includes('formatCents(quote.gstCents)') &&
      island.includes('formatCents(tierQuotes[tier].baseCents)'),
    'the island prints its amounts from quote fields through formatCents, never from its own arithmetic',
  );
  check(
    !/\*\s*3\s*\/\s*2|\*\s*1\.5|GST_RATE_PERCENT/.test(island),
    'and the island contains no price arithmetic of its own — the multiplier and the GST rate live in booking-pricing.ts',
  );

  // AC11 — a weekend price must be EXPLAINED where it is shown. The radio
  // prices are multiplied before any tier is selected, so the note has to be
  // gated on the same value they are; gating it on `quote` (which needs a tier)
  // showed three inflated figures against a terms box quoting the standard ones
  // with nothing on the page saying why.
  const noteAt = island.indexOf('AFTER_HOURS_NOTE');
  const radiosAt = island.indexOf('bind:group={values.assessmentTier}');
  check(
    /\{#if tierQuotes\?\.\[ASSESSMENT_TIERS\[0\]\]\.afterHours\}/.test(island),
    'the weekend note is gated on the same tierQuotes the radio prices are computed from, so it cannot render later than the number it explains',
  );
  check(
    noteAt > 0 && radiosAt > noteAt,
    'and it renders ABOVE the radio list, where the comparison actually happens',
  );

  // BK-36 — THE TERMS MOVED BELOW THE PICKER ON /book/.
  //
  // They used to render inside the page <header>, so the first screen was the
  // friction and the converting element — the calendar — was below it. The
  // order was backwards: the terms are the qualification on an offer that has
  // not been made yet.
  //
  // This is pinned rather than left to layout because the move is only SAFE if
  // the island's own box stays above its checkbox: `FEE_TERMS_ACK_LABEL` says
  // "the terms above", which is a claim about the acknowledged copy, not about
  // this informational block. Both halves are asserted — here, and in the
  // island section below — because either one alone reads like the pair.
  {
    const raw = readFileSync(resolve(root, 'src/pages/book.astro'), 'utf8');
    const template = stripForUse(templateOf(raw, 'src/pages/book.astro'));
    const islandAt = template.indexOf('<BookingForm');
    const termsAt = template.indexOf('FEE_TERMS_HEADING');
    check(islandAt > 0, '/book/ still mounts the booking island');
    check(
      termsAt > islandAt,
      '/book/ renders the terms box BELOW the booking island, not in the page header above it',
    );
  }

  // AND THE INSURER-BILLING PROHIBITION, on the two files that author the terms.
  //
  // Nothing may state or imply that the ASSESSMENT is billed to an insurer —
  // the $699/$1,199 language describes documentation the CUSTOMER receives and
  // hands to their adjuster, and it never says who pays. The constants are
  // pinned in `verify-booking-email.ts`; this is the prose AROUND them, which
  // no constant covers. The live risk is concrete: `ContactSection.astro`'s
  // "Insurance claim? We document it the way your adjuster needs" is one edit
  // away from "your insurance pays for it", one screen above the priced box.
  //
  // DELIBERATELY TWO FILES, not site-wide. The site says it bills insurers for
  // restoration WORK in a dozen places — `insurance-claims.astro` is an entire
  // page about it — and that is a different claim on a different page, with a
  // client behind it and no ticket to change it. A sweep that failed on all of
  // them would be turned off within a day, which is the same reasoning the
  // "free assessment" pin above records.
  const INSURER_BILLING_SHAPES = [
    /billed to your insur\w+/i,
    /your insurance (?:pays|covers|is billed)/i,
    /we bill your (?:insurance|insurer)/i,
    /(?:covered|paid) by your insurance/i,
    /insurance (?:pays|covers) (?:for )?(?:the |this )?assessment/i,
  ];
  for (const file of ['src/pages/book.astro', 'src/sections/ContactSection.astro']) {
    const raw = readFileSync(resolve(root, file), 'utf8');
    const template = normalise(stripForUse(templateOf(raw, file)));
    const hit = INSURER_BILLING_SHAPES.find((r) => r.test(template));
    check(
      hit === undefined,
      `${file}: says the assessment is billed to an insurer (${hit?.source ?? ''}) — the terms it renders never name who pays`,
    );
  }

  // BK-36 — THE ISLAND MAKES NO BOOKED/CONFIRMED CLAIM AT SUBMISSION.
  //
  // Not a constant, which is why no pin caught it for two tickets. The island's
  // fallback card — the branch taken when `storeConfirmation()` fails, which is
  // ordinary private-mode browsing — rendered "You're booked" under a checkmark
  // beside a reference number, for a row sitting in `pending_review`. The
  // submit button said "Confirm booking" and the SMS consent line said "you're
  // booked either way".
  //
  // BK-23 swept `/book/confirmed/`, `BookingConfirmation.svelte` and both
  // messages, and `verify-booking-email.ts` pins the claim out of the request
  // EMAIL. Nothing pinned the island, which is how three sentences survived the
  // flip inside the component that submits it.
  //
  // THE GENERAL RULE THIS ENFORCES: a copy inventory built from "where does the
  // constant render" misses every sentence that describes the same mechanism in
  // its own words.
  //
  // ── AND IT IS APPLIED TO EVERY PUBLIC SURFACE THAT DESCRIBES THE MECHANISM,
  //    not only to the island ─────────────────────────────────────────────────
  //
  // The first version read `BookingForm.svelte` alone, which is how the
  // implementation review found the claim still live in three more places on
  // the day this ticket was meant to remove it: `/contact/`'s hero said "Pick a
  // time and you're confirmed on the spot", `llms.txt` said "confirmed
  // instantly" AND "paid at the end of the visit" in one sentence, and the
  // homepage bullet this ticket had just rewritten was pinned by nothing at
  // all. Two of those are on surfaces no constant renders, and `llms.txt` is
  // the file an AI assistant quotes with no page around it to qualify the
  // claim.
  //
  // So the grammars are pinned, over every file that can carry them. Both
  // shapes of the claim: the ADJECTIVAL ("instant confirmation") and the
  // PREDICATIVE ("you're confirmed on the spot"), plus the payment-timing claim
  // the flip falsified.
  const BOOKED_CLAIM_SHAPES = [
    /\byou'?re booked\b/i,
    /\bconfirm booking\b/i,
    /\bbooking confirmed\b/i,
    /\byour booking is confirmed\b/i,
    /\binstant(?:ly)?\s+confirm/i,
    /\bconfirmation\b[^.<>]{0,20}\binstant/i,
    /\bconfirmed\s+(?:instantly|immediately|on the spot|right away)\b/i,
  ];
  // The pre-prepay payment claim, anchored to a payment verb for the same
  // reason `verify-booking-email.ts` anchors its own: a bare `on site` fires on
  // "the on-site assessment" and survives only by a hyphen.
  const ONSITE_PAYMENT_SHAPE =
    /pa(?:id|y|yable|ying)\b[^.<>]{0,40}(?:end of the visit|at the visit|on site|on the day)/i;

  const CLAIM_SURFACES = [
    'src/components/BookingForm.svelte',
    'src/sections/ContactSection.astro',
    'src/pages/book.astro',
    'src/pages/contact.astro',
    'src/pages/llms.txt.ts',
  ];
  for (const file of CLAIM_SURFACES) {
    const text = normalise(stripForUse(readFileSync(resolve(root, file), 'utf8')));
    const bookedHit = BOOKED_CLAIM_SHAPES.find((r) => r.test(text));
    check(
      bookedHit === undefined,
      `${file}: claims the request is booked or confirmed at submission (${bookedHit?.source ?? ''}) — under prepay it produces a REQUEST, and neither the review nor the payment has happened`,
    );
    check(
      !ONSITE_PAYMENT_SHAPE.test(text),
      `${file}: says the assessment is paid on site or on the day — the pre-prepay claim, which must not survive the flip by even one deploy`,
    );
  }

  const islandRaw = stripForUse(readFileSync(resolve(root, 'src/components/BookingForm.svelte'), 'utf8'));
  check(
    islandRaw.includes('RECEIVED_HEADING') && islandRaw.includes('RECEIVED_LEAD'),
    'and the island\'s post-submit card renders the request wording from the same constants /book/received/ and the request email use',
  );
  // The fourth sibling, and it hid inside a constant NAME rather than in a
  // sentence: `EMAILED_LINE` reads "a copy of this confirmation" and
  // `RECEIVED_EMAILED_LINE` reads "a copy of this request". No shape above can
  // tell them apart at the call site, so the call site is asserted directly.
  check(
    islandRaw.includes('RECEIVED_EMAILED_LINE') && !/\bEMAILED_LINE\b(?<!RECEIVED_EMAILED_LINE)/.test(islandRaw),
    'and it names the emailed copy a REQUEST, not a confirmation — RECEIVED_EMAILED_LINE, never EMAILED_LINE',
  );

  // ── BK-50 · THE TIMING LINE, ON THE CARD, IN THE RIGHT PLACE ────────────
  //
  // `RECEIVED_TIMING_LINE` — "if you have not heard from us and the appointment
  // is close, call or text us" — is the customer's ENTIRE recourse once the
  // client's 2026-09-01 decision removes the stale-request sweep. Nothing
  // auto-declines, nothing emails; a request nobody reviews goes silent.
  //
  // /book/received/ and the request email have always rendered it. This card
  // did not, and this card is the branch that renders when storeConfirmation()
  // fails — private browsing, storage pressure — i.e. exactly the visitor who
  // cannot navigate back to /book/received/ to find the line there.
  //
  // SCOPED TO THE CARD, NOT THE FILE, and that is the whole point of the slice.
  // `islandRaw` is the entire component: the {#if result} card AND the {:else}
  // form below it. A whole-file check is satisfied by rendering the line on
  // step 3 of the FORM, leaving the card — the only surface this assertion
  // exists for — still missing it. Plan review measured the gap at ~20k
  // characters of the same string.
  //
  // And `islandRaw` rather than a raw read, because `stripForUse` removes
  // import statements: against unstripped source the IMPORT alone satisfies
  // the check, so deleting the render stays green.
  const cardAt = islandRaw.indexOf('{#if result}');
  const formAt = islandRaw.indexOf('{:else}');
  check(
    cardAt !== -1 && formAt !== -1 && cardAt < formAt,
    'the island\'s fallback card is locatable and precedes the form arm — the slice below is real',
  );
  const card = cardAt !== -1 && formAt !== -1 ? islandRaw.slice(cardAt, formAt) : '';
  check(card.length > 0, 'and the card slice is non-empty');
  check(
    card.includes('RECEIVED_TIMING_LINE'),
    'the fallback card renders RECEIVED_TIMING_LINE — once cron sweep 2 is deleted (T1/T2) it is the only thing telling a customer what to do when a request goes unanswered',
  );

  // ── AND UNCONDITIONALLY. `includes` CANNOT SEE A CONDITIONAL WRAPPER ─────
  //
  // Adversarial review moved the line INSIDE the existing
  // `{#if result.emailSent}` block and every check above stayed green: the
  // substring is present, and the constant order is unchanged because
  // EMAILED still precedes TIMING. The suite passed on a card that shows the
  // line only to the visitor who already has it in their inbox — and hides it
  // from the one whose email did NOT send, who is precisely the person this
  // ticket exists for. That break inverts the ticket's own thesis and three
  // separately-justified scoping fixes could not see it.
  //
  // The general lesson, and it is the one this whole block kept re-learning:
  // slicing fixes WHERE a needle may appear and says nothing about WHAT IT IS
  // ATTACHED TO. So this walks Svelte block depth and requires the render to
  // sit at the card's own level.
  const beforeTiming = card.slice(0, card.indexOf('RECEIVED_TIMING_LINE'));
  const opens = (beforeTiming.match(/\{#(?:if|each|await|key)\b/g) ?? []).length;
  const closes = (beforeTiming.match(/\{\/(?:if|each|await|key)\}/g) ?? []).length;
  // Depth 1, not 0: the slice STARTS at the card's own `{#if result}`, whose
  // `{/if}` falls outside it. So the card's own level is one open block deep,
  // and anything nested further is inside a second condition.
  check(
    opens === closes + 1,
    `and it renders UNCONDITIONALLY — at the card's own block level, not nested in a further {#if} (${opens} opened, ${closes} closed before it; expected exactly one unclosed, the card itself). Gated on result.emailSent it would reach only the visitor who already got the email, and hide from the one who did not`,
  );

  // ── AND IN THE SAME ORDER THE OTHER TWO SURFACES USE ────────────────────
  //
  // The expected order is DERIVED from BookingConfirmation.svelte rather than
  // written out here, so this pin cannot rot into a list that agrees with
  // nothing. Any pair reshuffled on either surface reddens it.
  //
  // BK-50's first draft hard-coded a four-name subset — heading, lead, hold,
  // timing — which holds in both files under EITHER placement, so it was green
  // while the two surfaces read differently. The one constant that
  // distinguishes the layouts is RECEIVED_EMAILED_LINE, and it was the one
  // omitted. That is BK-48's negative-assertion trap in mirror form: a pin
  // named for a category, shaped for one case.
  const confirmation = stripForUse(
    readFileSync(resolve(root, 'src/components/BookingConfirmation.svelte'), 'utf8'),
  );
  const SHARED_RECEIVED_CONSTANTS = [
    'RECEIVED_HEADING',
    'RECEIVED_LEAD',
    'RECEIVED_HOLD_LINE',
    'RECEIVED_EMAILED_LINE',
    'RECEIVED_TIMING_LINE',
  ];
  const orderIn = (text: string) =>
    SHARED_RECEIVED_CONSTANTS.filter((name) => text.includes(name)).sort(
      (a, b) => text.indexOf(a) - text.indexOf(b),
    );
  const cardOrder = orderIn(card);
  const confirmationOrder = orderIn(confirmation);
  check(
    confirmationOrder.length === SHARED_RECEIVED_CONSTANTS.length,
    'BookingConfirmation.svelte renders all five shared request constants — it is the reference order, so a missing one would silently shrink the comparison below',
  );
  check(
    cardOrder.join(' > ') === confirmationOrder.join(' > '),
    `the card orders the five constants it shares with /book/received/ exactly as that page does (card: ${cardOrder.join(' > ')} | page: ${confirmationOrder.join(' > ')})`,
  );

  // THE THIRD SURFACE, and it needs its own comparison rather than a mention.
  //
  // Implementation review found the shipped comment claiming "the three
  // surfaces cannot drift apart" when only two were compared. booking-email.ts
  // renders NO RECEIVED_EMAILED_LINE — it IS the email — so the strict
  // five-constant sequence above cannot apply to it. Comparing each pair on the
  // constants they actually SHARE keeps every comparison as strong as its own
  // overlap allows, instead of weakening all three to the intersection.
  //
  // What this catches that nothing did before: the timing line moved above the
  // hold line in the request email.
  const email = stripForUse(readFileSync(resolve(root, 'src/lib/booking-email.ts'), 'utf8'));
  const emailOrder = orderIn(email);
  const sharedWithEmail = cardOrder.filter((name) => emailOrder.includes(name));
  check(
    sharedWithEmail.length >= 4,
    `the card and the request email share at least four ordered constants (${sharedWithEmail.join(' > ')})`,
  );
  check(
    sharedWithEmail.join(' > ') === emailOrder.filter((n) => cardOrder.includes(n)).join(' > '),
    `and the card orders them as the request email does (card: ${sharedWithEmail.join(' > ')} | email: ${emailOrder.filter((n) => cardOrder.includes(n)).join(' > ')})`,
  );

  // BOTH ARMS OF THE EMAIL, NOT JUST THE HTML ONE.
  //
  // `orderIn` sorts by FIRST occurrence, and in booking-email.ts that is always
  // the HTML arm — so the plaintext arm was unreachable by the check above.
  // Adversarial review swapped hold/timing in the text arm alone and the suite
  // stayed green: the plaintext request email would have said "if you have not
  // heard from us" before it said what we are holding.
  //
  // Every occurrence is paired instead: the Nth hold line must precede the Nth
  // timing line, which holds arm by arm however many arms there are.
  const allOf = (text: string, name: string) => {
    const out: number[] = [];
    for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) out.push(i);
    return out;
  };
  const holds = allOf(email, 'RECEIVED_HOLD_LINE');
  const timings = allOf(email, 'RECEIVED_TIMING_LINE');
  check(
    holds.length === timings.length && holds.length >= 2,
    `the request email renders the hold and timing lines once per arm (${holds.length} hold, ${timings.length} timing — expected 2 each, html and text)`,
  );
  check(
    holds.length === timings.length && holds.every((h, i) => h < timings[i]),
    'and in EVERY arm the hold line precedes the timing line — the html arm alone is what a first-occurrence check sees',
  );

  // RECEIVED_NEXT_STEPS IS DELIBERATELY ABSENT FROM THE CARD AND FROM THE
  // COMPARISON ABOVE. It renders on the other two surfaces and not here, which
  // leaves the timing line without the antecedent it has there — a real gap,
  // found by implementation review. It is NOT closed by adding the list,
  // because two of its three steps ("we email you to approve it, with a secure
  // payment link" / "confirmed once that payment goes through") describe the
  // prepay flow the free-assessment changeover deletes. Adding it here would
  // put two soon-false sentences on a new surface. Owner: T3, with the rest of
  // the request copy. Recorded in ROADMAP Known traps.
  check(
    !card.includes('RECEIVED_NEXT_STEPS'),
    'and the card does NOT render RECEIVED_NEXT_STEPS — its steps still describe the prepay flow, and T3 owns rewriting them',
  );

  // NOT a check on `contact.astro`. The first version asserted that file
  // contains no `FEE_TERMS` — which it cannot, since all it renders is
  // `<ContactSection showForm={true} />`; the string could only appear there by
  // someone importing a constant into a file that has no use for it. A check
  // that cannot fail regardless of what the reviewed component does is the
  // repo's own documented "a pin must be anchored to the construct it is about"
  // trap, so it is gone rather than kept for reassurance.
}

// ---------------------------------------------------------------------------
console.log('\nBuilding with sentinel tracking labels…');
// ---------------------------------------------------------------------------
// The build runs even when part 1 has already failed. It is half a minute of
// waste on a red run, and it is the price of the build-grep assertions being
// independently observable: every way to break the tracking also trips a
// source check, so an early exit here would make the bundle assertions
// unreachable — the "assertion that cannot fail" shape this project keeps
// paying for.

const FORM_SENTINEL = 'FORMLABELSHOULDNOTAPPEAR';
const BOOKING_SENTINEL = 'BOOKINGLABELMUSTAPPEAR';

try {
  execFileSync('npx', ['astro', 'build'], {
    cwd: root,
    stdio: 'pipe',
    env: {
      ...process.env,
      PUBLIC_GA4_ID: 'G-CUTOVERTEST',
      PUBLIC_AW_ID: 'AW-CUTOVERTEST',
      PUBLIC_AW_CALL_LABEL: 'CALLLABELSENTINEL',
      // Set deliberately. If anything still reads it, the sentinel lands in the
      // bundle and the assertion below turns red.
      PUBLIC_AW_FORM_LABEL: FORM_SENTINEL,
      PUBLIC_AW_BOOKING_LABEL: BOOKING_SENTINEL,
    },
  });
} catch (err) {
  const output = err as { stdout?: Buffer; stderr?: Buffer };
  console.error(output.stdout?.toString() ?? '');
  console.error(output.stderr?.toString() ?? '');
  console.error('  ✗ the sentinel build failed — nothing below could be checked');
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log('\nWhat actually reaches the browser (AC5)');
// ---------------------------------------------------------------------------
{
  const clientDir = resolve(root, 'dist/client');
  check(existsSync(clientDir), 'the build produced dist/client');

  const bundles = existsSync(clientDir)
    ? walkAll(clientDir).filter((f) => f.endsWith('.js') || f.endsWith('.html'))
    : [];
  check(bundles.length > 0, `there are bundles to grep, got ${bundles.length}`);

  const everything = bundles.map((f) => readFileSync(f, 'utf8')).join('\n');

  check(
    !everything.includes(FORM_SENTINEL),
    'the FORM conversion label reaches the browser nowhere — the tag is retired',
  );
  check(
    everything.includes(BOOKING_SENTINEL),
    'while the BOOKING label IS inlined — the literal-expression read still works',
  );
  check(everything.includes('generate_lead'), 'generate_lead still ships');
  check(
    everything.includes('booking_availability_error'),
    'and so do the two new funnel events',
  );

  // The contact form's own bundle, by name. A `conversion` send from anywhere
  // in it would mean the Ads tag came back.
  const contactBundles = bundles.filter((f) => /ContactForm\.[^/]*\.js$/.test(f));
  check(contactBundles.length > 0, `the contact form bundle was found, got ${contactBundles.length}`);
  for (const bundle of contactBundles) {
    const source = readFileSync(bundle, 'utf8');
    check(
      !source.includes('"conversion"') && !source.includes("'conversion'"),
      `${relative(root, bundle)}: sends no Ads conversion`,
    );
    check(source.includes('generate_lead'), `${relative(root, bundle)}: still sends generate_lead`);
  }

  // The sitemap is the other half of AC4, and it is generated rather than
  // written — so it is checked here rather than against the config alone.
  const sitemaps = existsSync(clientDir)
    ? walkAll(clientDir).filter((f) => /sitemap.*\.xml$/.test(f))
    : [];
  check(sitemaps.length > 0, `a sitemap was generated, got ${sitemaps.length}`);
  const sitemap = sitemaps.map((f) => readFileSync(f, 'utf8')).join('\n');
  check(sitemap.includes('/book/</loc>'), '/book/ is IN the sitemap');
  check(!sitemap.includes('/book/confirmed/'), 'and /book/confirmed/ is not');
  check(!sitemap.includes('/admin'), 'and neither is anything under /admin');

  // -------------------------------------------------------------------------
  // BK-29: "free assessment" reaches the browser NOWHERE.
  //
  // THIS READS THE BUILT OUTPUT, AND THAT IS THE WHOLE POINT. BK-27 pinned the
  // two booking surfaces at SOURCE level, which is narrower and fails earlier
  // with a better message — but `/book/` rendered the phrase 7 times without
  // `book.astro` containing it once, because `<Navbar />` does. A source-level
  // sweep of the page files passes while the page says it. Chrome, layouts and
  // island bundles are only visible here.
  //
  // Scoped to `.html` AND `.js`: a Svelte island's strings compile into its
  // bundle, so a client-rendered CTA would never appear in the HTML.
  //
  // EVERY offending file is reported, not the first. A 51-claim sweep gets
  // iterated on, and a gate that names one file per run turns a morning into a
  // day.
  //
  // MATCHED ON THE CLAIM, NOT ON THE ADJACENT PAIR OF WORDS. The first version
  // was `/free(\s|&nbsp;)+assessments?/i`, which reads like a check on "does
  // this page say the assessment is free" and is actually a check on whether
  // two specific words are neighbours. Its own red pass caught it: the page at
  // `/book/confirmed/` says "Your **free on-site restoration** assessment is
  // booked" — three words in between — and stayed green. It had appeared in the
  // first red run only because the Navbar's "Free Assessment" was still on the
  // page, so the file looked covered while the claim on it was invisible.
  //
  // Two shapes, because the claim has two grammars: the adjectival ("free
  // on-site assessment") and the predicative ("the assessment is free"). Both
  // bounded by `[^.<>]` so a match cannot run across a sentence break or out of
  // one HTML element into another — that bound is what keeps "…frees up your
  // crew. The assessment…" from reading as a hit.
  //
  // No separate entity handling needed now: `&nbsp;` is ordinary text to
  // `[^.<>]`. `normalise()` is still applied for the source-level pins, where
  // the regex is tighter.
  const BANNED_SHAPES = [
    /\bfree[^.<>]{0,40}?assessments?\b/i,
    /\bassessments?\b[^.<>]{0,24}?\b(?:is|are|'s)\s+free\b/i,
  ];
  const BANNED = { test: (s: string) => BANNED_SHAPES.some((r) => r.test(s)) };
  const offenders = bundles.filter((f) => BANNED.test(readFileSync(f, 'utf8')));
  check(
    offenders.length === 0,
    offenders.length === 0
      ? 'no built page or bundle claims a "free assessment"'
      : `"free assessment" reaches the browser in ${offenders.length} built file(s): ${offenders
          .map((f) => relative(root, f))
          .join(', ')}`,
  );

  // -------------------------------------------------------------------------
  // BK-36: the two prohibitions, read from `dist/` AFTER the build.
  //
  // SAME LESSON AS THE SWEEP ABOVE, and it is why these are here rather than
  // only at the constants: BK-27 pinned the booking surfaces at SOURCE level and
  // `/book/` rendered "free assessment" seven times without `book.astro`
  // containing it once, because `<Navbar />` does. What a page SAYS is a
  // property of the built page, not of the file that names it.
  //
  // ── SCOPE, STATED RATHER THAN DISCOVERED LATER ───────────────────────────
  //
  // The ticket says "no `deductible`, anywhere". Taken literally that is red on
  // arrival: the word appears 16 times in `src/` — `insurance-claims.astro` is
  // an entire page explaining what one is, plus `about.astro`,
  // `TrustStrip.astro` and four service entries — and reaches seven built
  // files. Deleting it site-wide is a marketing rewrite with no ticket and no
  // client behind it, and it is not what the constraint is about: the
  // prohibition is that the ASSESSMENT TERMS never name what the customer's
  // share is called, because deductible rebating by contractors is illegal in
  // several US jurisdictions and reads as claims-fraud territory to Canadian
  // insurers. So the scope is the surfaces that price and acknowledge the
  // assessment, where it is green today and where it catches the real failure
  // mode — a shared component putting the word onto `/book/`.
  //
  // The insurer-billing shapes are narrower again, for a harder reason.
  // `Navbar.svelte` says "We bill your insurer directly" and its bundle is
  // loaded by BOTH booking surfaces; `HeroSection` and `TestimonialsSection`
  // put the same claim in the homepage's own HTML. Those are claims about
  // restoration WORK, they are the client's, and no ticket touches them — so
  // this pin covers `/book/**` and the booking island's bundle, which is where
  // a customer chooses and acknowledges an assessment. The homepage's own card
  // is covered at source instead, in the section above.
  //
  // AND ONE MORE EXCLUSION WORTH NAMING because it looks like coverage and is
  // not: `/book/` carries "direct insurance billing" inside its `LocalBusiness`
  // JSON-LD (`data/services.ts`). This pin is green partly because none of its
  // shapes match that string — not because `/book/` is clean of every insurer
  // claim. Stated so the next reader does not mistake the pin's scope for its
  // subject.
  // ── HOW THE SURFACE LIST IS BUILT, AND WHY IT IS NOT A FILENAME GUESS ─────
  //
  // The first version named `_astro/BookingForm.*.js` as the island's bundle.
  // That chunk contains NONE of this copy: Vite splits `booking-copy.ts` into a
  // shared chunk (`booking-handoff.*.js` today, and the name is a build
  // artifact that will change), so the arm the comment described as "where a
  // customer chooses and acknowledges an assessment" matched zero fee-terms
  // strings. Coverage survived only through the SSR'd HTML — a different
  // property than the one claimed, and one that would vanish the day any of
  // this copy became client-only. Neither red row noticed, because both fired
  // on HTML.
  //
  // So the JS arm is found by CONTENT, not by filename: any built chunk that
  // carries the terms copy is a booking surface, whatever it ends up called.
  // And the guard below is a presence probe rather than a count — a count of
  // four is satisfied by the `/book/**` HTML alone, which is exactly how the
  // inert arm went unnoticed.
  const TERMS_MARKER = FEE_TERMS_HEADING_TEXT;
  const termsBundles = bundles.filter(
    (f) => f.endsWith('.js') && readFileSync(f, 'utf8').includes(TERMS_MARKER),
  );
  const bookingSurfaces = [
    ...bundles.filter(
      (f) => /dist\/client\/book\/.*\.html$/.test(f) || /dist\/client\/index\.html$/.test(f),
    ),
    ...termsBundles,
  ];
  check(
    termsBundles.length > 0,
    `at least one built JS chunk carries the terms copy, so the bundle arm of these pins is live, got ${termsBundles.length}`,
  );
  check(
    bookingSurfaces.filter((f) => f.endsWith('.html')).length >= 2,
    `and the built booking pages were found, got ${bookingSurfaces.filter((f) => f.endsWith('.html')).length}`,
  );
  const deductibleOffenders = bookingSurfaces.filter((f) =>
    /deductible/i.test(readFileSync(f, 'utf8')),
  );
  check(
    deductibleOffenders.length === 0,
    deductibleOffenders.length === 0
      ? 'no built booking surface says "deductible"'
      : `"deductible" reaches a booking surface in ${deductibleOffenders.length} built file(s): ${deductibleOffenders
          .map((f) => relative(root, f))
          .join(', ')}`,
  );

  // The insurer pin, on `/book/**` and the island bundle only — see the scope
  // note above for why the homepage is not in this list.
  const DIST_INSURER_SHAPES = [
    /billed to your insur\w+/i,
    /your insurance (?:pays|covers|is billed)/i,
    /we bill your (?:insurance|insurer)/i,
    /(?:covered|paid) by your insurance/i,
    /insurance (?:pays|covers) (?:for )?(?:the |this )?assessment/i,
  ];
  // The homepage HTML is dropped here and only here: its hero and testimonials
  // carry the site-wide direct-billing claim about restoration WORK, which is
  // the client's, has no ticket, and is a different claim from "the assessment
  // is billed to an insurer". The JS chunks stay in — they carry the terms copy
  // and are loaded by /book/.
  const bookOnly = bookingSurfaces.filter((f) => !/dist\/client\/index\.html$/.test(f));
  const insurerOffenders = bookOnly.filter((f) => {
    const source = readFileSync(f, 'utf8');
    return DIST_INSURER_SHAPES.some((r) => r.test(source));
  });
  check(
    insurerOffenders.length === 0,
    insurerOffenders.length === 0
      ? 'and no built /book/ surface says the assessment is billed to an insurer'
      : `an insurer-billing claim reaches ${insurerOffenders.length} built /book/ file(s): ${insurerOffenders
          .map((f) => relative(root, f))
          .join(', ')}`,
  );

  // `llms.txt` is generated, is not `.html` or `.js`, and the glob above would
  // miss it. It is also the file an AI assistant quotes with no page around it
  // to qualify the claim, which makes an inaccuracy here worse than one on a
  // marketing page rather than more obscure.
  const llms = resolve(clientDir, 'llms.txt');
  check(existsSync(llms), 'llms.txt was generated');
  check(
    existsSync(llms) && !BANNED.test(readFileSync(llms, 'utf8')),
    'and llms.txt does not tell an assistant the assessment is free',
  );

  // The robots meta specifically, not the word anywhere in the file: Astro
  // ships HTML comments, so a comment ABOUT noindex would otherwise read as a
  // noindex. (That is not hypothetical — it is how this assertion first went
  // red.)
  function robotsMeta(file: string): string | null {
    if (!existsSync(file)) return null;
    const html = readFileSync(file, 'utf8');
    return html.match(/<meta\s+name="robots"\s+content="([^"]*)"/)?.[1] ?? null;
  }

  const bookRobots = robotsMeta(resolve(clientDir, 'book/index.html'));
  check(bookRobots !== null, '/book/ was built and declares a robots policy');
  check(
    bookRobots?.includes('noindex') === false,
    `/book/ is indexable, got robots="${bookRobots}"`,
  );

  const confirmedRobots = robotsMeta(resolve(clientDir, 'book/confirmed/index.html'));
  check(confirmedRobots !== null, '/book/confirmed/ was built');
  check(
    confirmedRobots?.includes('noindex') === true,
    `/book/confirmed/ stays out of the index, got robots="${confirmedRobots}"`,
  );
}

function walkAll(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkAll(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ cutover checks passed\n');
console.log('  NOTE: dist/ now holds a SENTINEL build. Re-run `npm run build` before inspecting it.\n');
