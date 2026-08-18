// Guards the homepage reveal animation against the defect that hid the booking
// CTA in production (BK-42).
//
//   npm run build && npx tsx scripts/verify-reveal.ts
//
// Exits non-zero if any assertion failed.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT
//
// It cannot prove the button is visible — that needs a browser, and the repo has
// no driver. What it does prove is the two structural conditions the defect
// required, so the conditions cannot come back unnoticed:
//
//   1. The shipped CTA rule does not transition `opacity`. A GSAP `from()` tween
//      sets the start state and then re-reads the element to learn its
//      destination; on an element mid-CSS-transition that read returns the START
//      value, the tween becomes 0 -> 0, and the element never appears.
//   2. Every reveal tween in `ContactSection.astro` ends by clearing the inline
//      styles GSAP wrote, so the final state is the stylesheet's whatever the
//      tween recorded.
//
// Assertion (1) reads the BUILT css, not the source. The hazard is spelled
// `transition-all` in source and `transition-property:all` in the artifact, and
// only one of those two is what browsers get — a source-only check would keep
// passing if the expansion ever changed underneath it.
import { readFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
console.log('The shipped CTA rules must not transition opacity');
// ---------------------------------------------------------------------------
{
  const cssDir = join(root, '.vercel/output/static/_astro');
  if (!existsSync(cssDir)) {
    // Loud, not skipped. A gate that quietly passes when it cannot run is worse
    // than no gate: it reports green for a build nobody made.
    console.error('  ✗ no build output at .vercel/output/static/_astro — run `npm run build` first');
    process.exit(1);
  }

  const css = readdirSync(cssDir)
    .filter((f) => f.endsWith('.css'))
    .map((f) => readFileSync(join(cssDir, f), 'utf-8'))
    .join('\n');

  for (const cls of ['.cta-primary', '.cta-secondary']) {
    // The declaration block that carries the transition, not merely the first
    // block for this selector — `.cta-primary` also appears under a
    // prefers-contrast rule that sets a border and nothing else.
    const blocks = [...css.matchAll(new RegExp(`\\${cls}\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
    check(blocks.length > 0, `${cls} exists in the built css`);

    const withTransition = blocks.filter((b) => b.includes('transition-property'));
    check(withTransition.length > 0, `${cls} declares an explicit transition-property`);

    for (const block of withTransition) {
      const list = /transition-property:([^;]*)/.exec(block)?.[1] ?? '';
      check(!/\ball\b/.test(list), `${cls} does not transition \`all\` (got: ${list.trim()})`);
      check(!/\bopacity\b/.test(list), `${cls} does not transition opacity (got: ${list.trim()})`);
    }
  }
  console.log('  the built rules transition only what hover changes');
}

// ---------------------------------------------------------------------------
console.log('Every reveal tween must clear the inline styles it wrote');
// ---------------------------------------------------------------------------
{
  const section = readFileSync(join(root, 'src/sections/ContactSection.astro'), 'utf-8');

  const tweens = (section.match(/gsap\.from\(/g) ?? []).length;
  const settled = (section.match(/onComplete: settle\(/g) ?? []).length;

  check(tweens > 0, 'ContactSection still has reveal tweens to guard');
  check(
    tweens === settled,
    `every gsap.from() carries onComplete: settle() (${tweens} tweens, ${settled} settled)`,
  );

  // The clear list is the assertion's real subject: `settle` calling clearProps
  // with a list that omits opacity would satisfy the count above and strand the
  // button exactly as before.
  const cleared = /clearProps: '([^']*)'/.exec(section)?.[1] ?? '';
  check(cleared.includes('opacity'), `the clear list includes opacity (got: ${cleared})`);
  check(cleared.includes('transform'), `the clear list includes transform (got: ${cleared})`);

  console.log(`  ${tweens} tweens, all of them settled, clearing: ${cleared}`);
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ All reveal checks passed.');
