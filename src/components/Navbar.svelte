<script lang="ts">
  import { onMount } from 'svelte';
  import BrandLogo from './BrandLogo.svelte';

  const navLinks = [
    { label: 'Services', href: '#water' },
    { label: 'How It Works', href: '#process' },
    { label: 'Reviews', href: '#testimonials' },
    { label: 'Blog', href: '/blog/' },
    { label: 'Contact', href: '#contact' },
  ];

  const mobileServices = [
    { label: 'Water Damage', href: '#water' },
    { label: 'Fire & Smoke', href: '#fire' },
    { label: 'Mold Removal', href: '#mold' },
    { label: 'Storm Damage', href: '#storm' },
  ];

  let isScrolled = $state(false);
  let isMobileMenuOpen = $state(false);
  let activeLink = $state('');

  let mobileMenuRef: HTMLDivElement | undefined = $state();
  let hamburgerRef: HTMLButtonElement | undefined = $state();
  let lastFocusedElement: HTMLElement | null = null;

  onMount(() => {
    const handleScroll = () => {
      isScrolled = window.scrollY > 50;
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  });

  $effect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
      lastFocusedElement = document.activeElement as HTMLElement;
      setTimeout(() => {
        const closeButton = mobileMenuRef?.querySelector('[data-close-button]') as HTMLElement;
        closeButton?.focus();
      }, 100);
    } else {
      document.body.style.overflow = '';
      lastFocusedElement?.focus();
    }
    return () => {
      document.body.style.overflow = '';
    };
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && isMobileMenuOpen) {
      isMobileMenuOpen = false;
    }
    if (e.key === 'Tab' && isMobileMenuOpen && mobileMenuRef) {
      const focusable = mobileMenuRef.querySelectorAll<HTMLElement>(
        'a[href], button, [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function handleLinkClick(e: MouseEvent, href: string) {
    isMobileMenuOpen = false;
    // Page links (e.g. /blog/) — let the browser navigate normally
    if (!href.startsWith('#')) {
      activeLink = href;
      return;
    }
    // Hash links — smooth scroll on current page, or navigate to /#hash from other pages
    e.preventDefault();
    activeLink = href;
    const element = document.querySelector(href);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    } else {
      // Not on homepage — navigate there with the hash
      window.location.href = '/' + href;
    }
  }
</script>

<!-- Skip to content -->
<a
  href="#main-content"
  class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[1001] focus:bg-yeg-amber focus:text-yeg-bg focus:px-4 focus:py-2 focus:rounded focus:font-semibold"
>
  Skip to content
</a>

<!-- Main Navbar -->
<nav
  class={`fixed top-0 left-0 right-0 z-[1000] transition-all duration-300 ${
    isScrolled
      ? 'bg-[rgba(248,246,243,0.96)] backdrop-blur-[14px] border-b border-black/[0.07] shadow-[0_4px_24px_rgba(0,0,0,0.08)]'
      : 'bg-transparent'
  }`}
  style="transition-timing-function: cubic-bezier(0.25, 0.1, 0.25, 1.0);"
  onkeydown={handleKeyDown}
>
  <div class="w-full px-6 lg:px-12">
    <div class="flex items-center justify-between min-h-16 h-[4.75rem] lg:h-[5.25rem]">

      <!-- Logo -->
      <a
        href="/"
        class={`flex items-center transition-transform duration-300 ${isScrolled ? 'scale-95' : 'scale-100'}`}
        style="transition-timing-function: cubic-bezier(0.25, 0.1, 0.25, 1.0);"
      >
        <BrandLogo variant="nav" />
      </a>

      <!-- Desktop Nav Links -->
      <div class="hidden xl:flex items-center gap-1">
        {#each navLinks as link}
          <a
            href={link.href}
            onclick={(e) => handleLinkClick(e, link.href)}
            class={`relative px-4 py-2 font-body text-sm font-medium tracking-wide rounded-full transition-all duration-200 ${
              activeLink === link.href
                ? 'text-yeg-amber bg-yeg-amber/5'
                : 'text-yeg-text hover:text-yeg-amber hover:bg-black/[0.04]'
            }`}
          >
            {link.label}
            {#if activeLink === link.href}
              <span class="absolute inset-x-4 -bottom-px h-px bg-yeg-amber/60"></span>
            {/if}
          </a>
        {/each}
      </div>

      <!-- Desktop CTAs -->
      <div class="hidden xl:flex items-center gap-3">
        <a
          href="#contact"
          onclick={(e) => handleLinkClick(e, '#contact')}
          class="flex items-center gap-2 bg-yeg-amber/10 hover:bg-yeg-amber/[0.15] border border-yeg-amber/25 hover:border-yeg-amber/40 text-yeg-amber rounded-full px-4 py-2 text-sm font-semibold transition-all duration-200"
        >
          Free Assessment
        </a>
        <a
          href="tel:7804793285"
          class="flex items-center gap-2.5 bg-yeg-amber hover:bg-yeg-amber-hover text-yeg-bg rounded-full px-4 py-2 text-sm font-bold transition-all duration-200"
        >
          <span class="flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse flex-shrink-0"></span>
            <span class="text-[9px] uppercase tracking-widest font-bold leading-none">24/7</span>
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.65 3.37 2 2 0 0 1 3.64 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8.91a16 16 0 0 0 6 6l.81-.81a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          <span>(780) 479-3285</span>
        </a>
      </div>

      <!-- Mobile Hamburger -->
      <button
        bind:this={hamburgerRef}
        onclick={() => (isMobileMenuOpen = true)}
        class="xl:hidden p-2 text-yeg-amber hover:bg-yeg-amber/10 rounded-lg transition-colors"
        aria-label="Open navigation menu"
        aria-expanded={isMobileMenuOpen}
        aria-controls="mobile-menu"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>
      </button>
    </div>
  </div>
</nav>

<!-- Mobile Menu Overlay -->
<div
  bind:this={mobileMenuRef}
  id="mobile-menu"
  class={`fixed inset-0 z-[1002] xl:hidden transition-all duration-300 ${isMobileMenuOpen ? 'pointer-events-auto' : 'pointer-events-none'}`}
  onkeydown={handleKeyDown}
  role="dialog"
  aria-modal="true"
  aria-label="Navigation menu"
>
  <!-- Backdrop -->
  <div
    class={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${isMobileMenuOpen ? 'opacity-100' : 'opacity-0'}`}
    onclick={() => (isMobileMenuOpen = false)}
    role="none"
  ></div>

  <!-- Panel -->
  <div
    class={`absolute right-0 top-0 bottom-0 w-full max-w-sm bg-[#F8F6F3] flex flex-col transition-transform duration-300 ${isMobileMenuOpen ? 'translate-x-0' : 'translate-x-full'}`}
    style="transition-timing-function: cubic-bezier(0.25, 0.1, 0.25, 1.0);"
    onclick={(e) => e.stopPropagation()}
    role="none"
  >
    <!-- Panel Header -->
    <div class="flex items-center justify-between px-6 py-5 border-b border-black/[0.07]">
      <BrandLogo variant="drawer" />
      <button
        data-close-button
        onclick={() => (isMobileMenuOpen = false)}
        class="p-2 text-yeg-text-secondary hover:text-yeg-text hover:bg-black/[0.06] rounded-lg transition-colors"
        aria-label="Close navigation menu"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>

    <!-- Nav Links -->
    <div class="flex-1 overflow-y-auto px-4 py-4">
      <div class="space-y-1">
        {#each navLinks as link}
          <a
            href={link.href}
            onclick={(e) => handleLinkClick(e, link.href)}
            class={`flex items-center justify-between w-full px-4 py-3 rounded-xl font-display font-bold text-xl transition-colors duration-200 ${
              activeLink === link.href
                ? 'text-yeg-amber bg-yeg-amber/5'
                : 'text-yeg-text hover:text-yeg-amber hover:bg-black/[0.04]'
            }`}
          >
            {link.label}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-30" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          </a>
        {/each}
      </div>

      <!-- Services quick links -->
      <div class="mt-6 pt-6 border-t border-black/[0.07]">
        <p class="text-xs font-medium text-yeg-text-secondary/60 uppercase tracking-widest px-4 mb-3">
          Our Services
        </p>
        <div class="grid grid-cols-2 gap-2">
          {#each mobileServices as svc}
            <a
              href={svc.href}
              onclick={(e) => handleLinkClick(e, svc.href)}
              class="px-3 py-2.5 rounded-lg bg-yeg-bg border border-black/[0.06] text-sm text-yeg-text-secondary hover:text-yeg-text hover:border-black/[0.12] transition-all duration-200 text-center"
            >
              {svc.label}
            </a>
          {/each}
        </div>
      </div>
    </div>

    <!-- Panel Footer -->
    <div class="p-5 border-t border-black/[0.07] space-y-3">
      <a
        href="tel:7804793285"
        class="flex items-center justify-center gap-2.5 w-full py-3.5 bg-yeg-amber text-yeg-bg rounded-xl font-bold text-base hover:bg-yeg-amber-hover transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.65 3.37 2 2 0 0 1 3.64 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 8.91a16 16 0 0 0 6 6l.81-.81a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        (780) 479-3285
      </a>
      <p class="text-center text-xs text-yeg-text-secondary/70">
        Emergency line — live answer, 24/7
      </p>
    </div>
  </div>
</div>
