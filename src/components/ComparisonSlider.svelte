<script lang="ts">
  import { onMount } from 'svelte';
  import gsap from 'gsap';

  interface Props {
    beforeImage: string;
    afterImage: string;
    beforeAlt?: string;
    afterAlt?: string;
  }

  let {
    beforeImage,
    afterImage,
    beforeAlt = 'Before image showing damage',
    afterAlt = 'After image showing restoration',
  }: Props = $props();

  let containerRef: HTMLDivElement | undefined = $state();
  let teaserTl: gsap.core.Timeline | null = null;

  let position = $state(50);
  let isDragging = $state(false);
  let showLabels = $state(false);

  onMount(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion) {
      showLabels = true;
      return;
    }

    const proxy = { pos: 50 };
    teaserTl = gsap.timeline({
      onComplete: () => {
        setTimeout(() => {
          showLabels = true;
        }, 400);
      },
    });

    teaserTl.to(proxy, {
      pos: 22,
      duration: 1.0,
      ease: 'power3.out',
      onUpdate: () => {
        position = Math.max(5, Math.min(95, proxy.pos));
      },
    });

    teaserTl.to(
      proxy,
      {
        pos: 50,
        duration: 1.4,
        ease: 'elastic.out(1, 0.75)',
        onUpdate: () => {
          position = Math.max(5, Math.min(95, proxy.pos));
        },
      },
      '+=0.05'
    );

    return () => {
      teaserTl?.kill();
    };
  });

  function handleInteraction(clientX: number) {
    if (!containerRef) return;
    const rect = containerRef.getBoundingClientRect();
    position = Math.max(5, Math.min(95, ((clientX - rect.left) / rect.width) * 100));
  }

  function handleMouseDown(e: MouseEvent) {
    e.preventDefault();
    teaserTl?.kill();
    isDragging = true;
    handleInteraction(e.clientX);
  }

  function handleTouchStart(e: TouchEvent) {
    teaserTl?.kill();
    isDragging = true;
    handleInteraction(e.touches[0].clientX);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      position = Math.max(5, position - 5);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      position = Math.min(95, position + 5);
    } else if (e.key === 'Home') {
      e.preventDefault();
      position = 5;
    } else if (e.key === 'End') {
      e.preventDefault();
      position = 95;
    }
  }

  // Add/remove global drag listeners when isDragging changes
  $effect(() => {
    if (!isDragging) return;

    function onMouseMove(e: MouseEvent) {
      handleInteraction(e.clientX);
    }
    function onMouseUp() {
      isDragging = false;
    }
    function onTouchMove(e: TouchEvent) {
      handleInteraction(e.touches[0].clientX);
    }
    function onTouchEnd() {
      isDragging = false;
    }

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  });
</script>

<div
  bind:this={containerRef}
  class="relative w-full h-full rounded-lg overflow-hidden shadow-image cursor-ew-resize"
  onmousedown={handleMouseDown}
  ontouchstart={handleTouchStart}
  role="none"
>
  <!-- After image (full background) -->
  <div class="absolute inset-0 w-full h-full">
    <img
      src={afterImage}
      alt={afterAlt}
      class="w-full h-full object-cover"
      loading="eager"
      fetchpriority="high"
    />
  </div>

  <!-- Before image — clipped -->
  <div
    class="absolute inset-0 w-full h-full"
    style:clip-path={`inset(0 ${100 - position}% 0 0)`}
    style:will-change="clip-path"
  >
    <img
      src={beforeImage}
      alt={beforeAlt}
      class="w-full h-full object-cover"
      loading="eager"
      fetchpriority="high"
    />
  </div>

  <!-- Ambient glow beam -->
  <div
    class="absolute top-0 bottom-0 pointer-events-none z-[15]"
    style:left={`${position}%`}
    style:transform="translateX(-50%)"
    style:width={isDragging ? '120px' : '80px'}
    style:background={isDragging
      ? 'radial-gradient(ellipse 60px 100% at 50% 50%, rgba(242,201,76,0.18) 0%, rgba(242,201,76,0.06) 50%, transparent 100%)'
      : 'radial-gradient(ellipse 40px 100% at 50% 50%, rgba(242,201,76,0.10) 0%, rgba(242,201,76,0.03) 50%, transparent 100%)'}
    style:transition="width 0.3s ease, background 0.3s ease"
  >
  </div>

  <!-- Vertical divider line -->
  <div
    class="absolute top-0 bottom-0 w-px bg-yeg-amber z-10"
    style:left={`${position}%`}
    style:transform="translateX(-50%)"
    style:box-shadow={isDragging
      ? '0 0 8px 2px rgba(242,201,76,0.9), 0 0 20px 4px rgba(242,201,76,0.55), 0 0 48px 8px rgba(242,201,76,0.25)'
      : '0 0 6px 1px rgba(242,201,76,0.7), 0 0 16px 3px rgba(242,201,76,0.35), 0 0 36px 6px rgba(242,201,76,0.15)'}
    style:transition="box-shadow 0.2s ease"
  >
  </div>

  <!-- Handle button -->
  <button
    class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-yeg-amber flex items-center justify-center shadow-[0_0_20px_rgba(255,182,39,0.5),0_0_40px_rgba(255,182,39,0.3),0_0_60px_rgba(255,182,39,0.15)] hover:shadow-[0_0_30px_rgba(255,182,39,0.7),0_0_60px_rgba(255,182,39,0.4),0_0_90px_rgba(255,182,39,0.2)] hover:scale-110 transition-all duration-200 cursor-ew-resize focus:outline-none focus:ring-2 focus:ring-yeg-amber focus:ring-offset-2 focus:ring-offset-yeg-bg z-20"
    style:left={`${position}%`}
    aria-label="Comparison slider showing water damage restoration before and after"
    role="slider"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(position)}
    aria-orientation="horizontal"
    onkeydown={handleKeyDown}
    onmousedown={(e) => {
      e.stopPropagation();
      handleMouseDown(e);
    }}
    ontouchstart={(e) => {
      e.stopPropagation();
      handleTouchStart(e);
    }}
    tabindex={0}
  >
    <div class="flex items-center">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yeg-bg" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yeg-bg" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
    </div>
  </button>

  <!-- Labels -->
  <div
    class="absolute top-4 left-4 px-3 py-1.5 bg-yeg-bg/80 backdrop-blur-sm rounded text-xs font-medium tracking-wider uppercase text-yeg-amber transition-opacity duration-300"
    style:opacity={showLabels ? 1 : 0}
    style:font-family="'Source Serif 4', serif"
    style:letter-spacing="0.1em"
  >
    Before
  </div>
  <div
    class="absolute top-4 right-4 px-3 py-1.5 bg-yeg-bg/80 backdrop-blur-sm rounded text-xs font-medium tracking-wider uppercase text-yeg-amber transition-opacity duration-300"
    style:opacity={showLabels ? 1 : 0}
    style:font-family="'Source Serif 4', serif"
    style:letter-spacing="0.1em"
  >
    After
  </div>

  <!-- Drag hint -->
  <div
    class="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-yeg-amber font-semibold bg-yeg-bg/85 border border-yeg-amber/30 backdrop-blur-sm px-3 py-1.5 rounded-full pointer-events-none transition-opacity duration-300"
    style:opacity={showLabels ? 1 : 0}
  >
    Drag to compare
  </div>

  <!-- Screen reader description -->
  <span class="sr-only">
    Before image showing mold damage, After image showing restored framing
  </span>
</div>
