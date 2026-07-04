import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://yegrestoration.ca',
  integrations: [
    svelte(),
    tailwind({ applyBaseStyles: false }),
    sitemap({ filter: (page) => !page.includes('/admin') }),
    mdx(),
  ],
  output: 'static',
  adapter: vercel(),
});
