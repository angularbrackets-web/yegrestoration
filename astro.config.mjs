import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://yegrestoration.ca',
  // All internal links, canonicals, and schema URLs use trailing slashes;
  // enforcing it here makes Vercel redirect the non-slash variants instead
  // of serving duplicate URLs. File routes (/rss.xml, /llms.txt) are exempt.
  trailingSlash: 'always',
  // Astro 7 changed the default to 'jsx' (JSX-style whitespace stripping).
  // Several sections rely on inline-block/{' '} spacing tuned for the old
  // compressor, so pin the pre-7 behavior. Revisit in a dedicated pass.
  compressHTML: true,
  integrations: [
    svelte(),
    // /book/ is IN the sitemap as of BK-10: it is the site's quote path now,
    // and its noindex came off in the same change — the two always move
    // together, which is why they were commented as a pair.
    // /book/confirmed/ and /book/received/ stay excluded, permanently and for a
    // different reason: neither renders anything at all without a session, so
    // neither has anything to rank for, and both keep their own noindex.
    // BK-23 added /book/received/ as the form's landing page and left
    // /book/confirmed/ for the post-payment redirect — two pages, one rule.
    // Exact match, not a substring: `includes('/book')` would silently also
    // exclude any future /bookings… path.
    sitemap({
      // `/upload/` is a signed-token capability page (BK-34a). It is an SSR
      // dynamic route, so the sitemap would not find one today in any case —
      // this is here so that a future `getStaticPaths` cannot quietly publish a
      // list of live upload links. The page's own `noindex` is the real guard.
      filter: (page) =>
        !page.includes('/admin') &&
        !page.includes('/upload/') &&
        !page.endsWith('/book/confirmed/') &&
        !page.endsWith('/book/received/') &&
        // BK-32's cancel_url. Same rule as its two siblings: one visitor's
        // abandoned payment has nothing to rank for.
        !page.endsWith('/book/payment-cancelled/'),
    }),
    mdx(),
  ],
  output: 'static',
  adapter: vercel(),
  // Responsive images: auto srcset/sizes + aspect-ratio CSS (CLS guard) on
  // every <Image>. Styles are zero-specificity, so Tailwind classes win.
  image: { layout: 'constrained' },
  vite: { plugins: [tailwindcss()] },
});
