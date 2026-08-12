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
