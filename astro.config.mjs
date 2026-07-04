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
    sitemap({ filter: (page) => !page.includes('/admin') }),
    mdx(),
  ],
  output: 'static',
  adapter: vercel(),
  // Responsive images: auto srcset/sizes + aspect-ratio CSS (CLS guard) on
  // every <Image>. Styles are zero-specificity, so Tailwind classes win.
  image: { layout: 'constrained' },
  vite: { plugins: [tailwindcss()] },
});
