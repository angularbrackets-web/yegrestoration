/**
 * Homepage comparison-slider derivatives, shared by HeroSection (render)
 * and index.astro (LCP preloads) so both always reference the same files.
 * Astro's build-time image cache dedupes the transforms.
 *
 * Widths match the two ComparisonSlider instances in HeroSection: desktop
 * slider is w-[60vw] (~1150px on common viewports), mobile is full-width
 * inside the text column (~430px, ~860px at 2x DPR). The lg: breakpoint
 * (1024px) decides which instance shows — keep the preload media queries
 * in index.astro in sync with it.
 */
import { getImage } from 'astro:assets';
import beforeSrc from '../assets/hero/before-damage.png';
import afterSrc from '../assets/hero/after-restored.png';

const opts = { format: 'webp', quality: 75 } as const;

export const heroSliderImages = {
  desktopBefore: await getImage({ src: beforeSrc, width: 1200, ...opts }),
  desktopAfter: await getImage({ src: afterSrc, width: 1200, ...opts }),
  mobileBefore: await getImage({ src: beforeSrc, width: 700, ...opts }),
  mobileAfter: await getImage({ src: afterSrc, width: 700, ...opts }),
};
