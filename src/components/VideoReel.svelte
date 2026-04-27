<script lang="ts">
  import { onMount } from 'svelte';
  import gsap from 'gsap';
  import { ScrollTrigger } from 'gsap/ScrollTrigger';

  gsap.registerPlugin(ScrollTrigger);

  const videoItems = [
    { src: '/videos/hero1.mp4', label: 'Moisture Detection' },
    { src: '/videos/hero2.mp4', label: 'Water Extraction' },
    { src: '/videos/hero3.mp4', label: 'Immediate Response' },
    { src: '/videos/hero4.mp4', label: 'Day Or Night' },
    { src: '/videos/hero5.mp4', label: 'Certified Crews' },
    { src: '/videos/hero6.mp4', label: 'Mold Removal' },
    { src: '/videos/hero7.mp4', label: 'Guaranteed Restoration' },
  ];

  let sectionRef: HTMLElement | undefined = $state();
  let videoRefs: HTMLVideoElement[] = $state([]);

  let activeIndex = $state(0);
  let fading = $state(false);

  onMount(() => {
    gsap.set(sectionRef, { opacity: 0, y: 40 });

    gsap.to(sectionRef, {
      opacity: 1,
      y: 0,
      duration: 0.9,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: sectionRef,
        start: 'top 80%',
        once: true,
      },
    });
  });

  // Play/pause videos when activeIndex changes
  $effect(() => {
    videoRefs.forEach((video, i) => {
      if (!video) return;
      if (i === activeIndex) {
        video.play().catch(() => {});
      } else {
        video.pause();
        video.currentTime = 0;
      }
    });
  });

  function handleEnded() {
    fading = true;
    setTimeout(() => {
      activeIndex = (activeIndex + 1) % videoItems.length;
      fading = false;
    }, 350);
  }

  function handlePanelEnter(index: number) {
    if (index === activeIndex) return;
    activeIndex = index;
  }
</script>

<section bind:this={sectionRef} class="relative bg-yeg-bg py-20 lg:py-28 overflow-hidden">
  <div class="container mx-auto px-6 lg:px-8">
    <div class="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">

      <!-- Left: Text Column -->
      <div class="w-full lg:w-2/5 flex-shrink-0 text-center lg:text-left">
        <span
          class="inline-block text-xs font-semibold tracking-[0.2em] uppercase text-yeg-amber mb-5 font-body"
        >
          See the Work
        </span>
        <h2
          class="font-display font-bold text-yeg-text leading-tight mb-6"
          style="font-size: clamp(34px, 4.2vw, 56px);"
        >
          From Disaster<br />to Restored
        </h2>
        <p class="font-body text-yeg-text-secondary text-lg leading-relaxed mb-8 max-w-md mx-auto lg:mx-0">
          Every project tells a story. Watch our teams respond, remediate, and rebuild — returning
          homes and businesses to better than before.
        </p>
        <a href="#contact" class="cta-primary">Get Emergency Help</a>
      </div>

      <!-- Right: Video Accordion -->
      <div class="w-full lg:w-3/5">
        <div class="flex flex-row gap-2 h-[500px] overflow-hidden rounded-2xl">
          {#each videoItems as item, i}
            <div
              onmouseenter={() => handlePanelEnter(i)}
              style:flex={i === activeIndex ? '5 1 0%' : '0.5 1 0%'}
              class="relative overflow-hidden rounded-2xl cursor-pointer transition-all duration-700 ease-in-out"
            >
              <!-- Video -->
              <video
                bind:this={videoRefs[i]}
                src={item.src}
                muted
                playsinline
                preload="metadata"
                onended={i === activeIndex ? handleEnded : undefined}
                class={`absolute inset-0 w-full h-full object-cover transition-opacity duration-[350ms] ${
                  i === activeIndex && fading ? 'opacity-0' : 'opacity-100'
                }`}
              ></video>

              <!-- Overlay -->
              <div
                class={`absolute inset-0 transition-all duration-700 ${
                  i === activeIndex ? 'bg-black/25' : 'bg-black/65'
                }`}
              ></div>

              <!-- Amber accent bar -->
              <div
                class={`absolute bottom-0 inset-x-0 h-0.5 bg-yeg-amber transition-opacity duration-500 ${
                  i === activeIndex ? 'opacity-100' : 'opacity-0'
                }`}
              ></div>

              <!-- Panel label -->
              <span
                class={`absolute font-body font-semibold text-white whitespace-nowrap transition-all duration-300 ease-in-out ${
                  i === activeIndex
                    ? 'bottom-5 left-5 text-sm rotate-0 opacity-100'
                    : 'bottom-24 left-1/2 -translate-x-1/2 text-xs rotate-90 opacity-60'
                }`}
              >
                {item.label}
              </span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
</section>
