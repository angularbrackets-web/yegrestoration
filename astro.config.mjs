import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://yegrestoration.ca',
  // All internal links, canonicals, and schema URLs use trailing slashes;
  // enforcing it here makes Vercel redirect the non-slash variants instead
  // of serving duplicate URLs. File routes (/rss.xml, /llms.txt) are exempt.
  trailingSlash: 'always',
  integrations: [
    svelte(),
    tailwind({ applyBaseStyles: false }),
    sitemap({ filter: (page) => !page.includes('/admin') }),
    mdx(),
  ],
  output: 'static',
  adapter: vercel(),
});
