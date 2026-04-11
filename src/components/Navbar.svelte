<script lang="ts">
  import { onMount } from 'svelte';
  import { Phone, Menu, X, ChevronRight } from 'lucide-svelte';
  import BrandLogo from './BrandLogo.svelte';

  const navLinks = [
    { label: 'Services', href: '#water' },
    { label: 'How It Works', href: '#process' },
    { label: 'Reviews', href: '#testimonials' },
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

  let mobileMenuRef: HTMLDivElement;
  let hamburgerRef: HTMLButtonElement;
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
    e.preventDefault();
    activeLink = href;
    isMobileMenuOpen = false;
    const element = document.querySelector(href);
    if (element) element.scrollIntoView({ behavior: 'smooth' });
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
      ? 'bg-[rgba(11,15,23,0.96)] backdrop-blur-[14px] border-b border-white/[0.07] shadow-[0_4px_24px_rgba(0,0,0,0.4)]'
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
                : 'text-yeg-text hover:text-yeg-amber hover:bg-white/[0.04]'
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
          href="tel:7805550199"
          class="flex items-center gap-2.5 bg-yeg-amber hover:bg-yeg-amber-hover text-yeg-bg rounded-full px-4 py-2 text-sm font-bold transition-all duration-200"
        >
          <span class="flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse flex-shrink-0"></span>
            <span class="text-[9px] uppercase tracking-widest font-bold leading-none">24/7</span>
          </span>
          <Phone size={14} />
          <span>(780) 555-0199</span>
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
        <Menu size={24} />
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
    class={`absolute right-0 top-0 bottom-0 w-full max-w-sm bg-[#0B0F17] flex flex-col transition-transform duration-300 ${isMobileMenuOpen ? 'translate-x-0' : 'translate-x-full'}`}
    style="transition-timing-function: cubic-bezier(0.25, 0.1, 0.25, 1.0);"
    onclick={(e) => e.stopPropagation()}
    role="none"
  >
    <!-- Panel Header -->
    <div class="flex items-center justify-between px-6 py-5 border-b border-white/[0.07]">
      <BrandLogo variant="drawer" />
      <button
        data-close-button
        onclick={() => (isMobileMenuOpen = false)}
        class="p-2 text-yeg-text-secondary hover:text-yeg-text hover:bg-white/[0.06] rounded-lg transition-colors"
        aria-label="Close navigation menu"
      >
        <X size={20} />
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
                : 'text-yeg-text hover:text-yeg-amber hover:bg-white/[0.04]'
            }`}
          >
            {link.label}
            <ChevronRight size={16} class="opacity-30" />
          </a>
        {/each}
      </div>

      <!-- Services quick links -->
      <div class="mt-6 pt-6 border-t border-white/[0.07]">
        <p class="text-xs font-medium text-yeg-text-secondary/60 uppercase tracking-widest px-4 mb-3">
          Our Services
        </p>
        <div class="grid grid-cols-2 gap-2">
          {#each mobileServices as svc}
            <a
              href={svc.href}
              onclick={(e) => handleLinkClick(e, svc.href)}
              class="px-3 py-2.5 rounded-lg bg-yeg-bg border border-white/[0.06] text-sm text-yeg-text-secondary hover:text-yeg-text hover:border-white/[0.12] transition-all duration-200 text-center"
            >
              {svc.label}
            </a>
          {/each}
        </div>
      </div>
    </div>

    <!-- Panel Footer -->
    <div class="p-5 border-t border-white/[0.07] space-y-3">
      <a
        href="tel:7805550199"
        class="flex items-center justify-center gap-2.5 w-full py-3.5 bg-yeg-amber text-yeg-bg rounded-xl font-bold text-base hover:bg-yeg-amber-hover transition-colors"
      >
        <Phone size={18} />
        (780) 555-0199
      </a>
      <p class="text-center text-xs text-yeg-text-secondary/70">
        Emergency line — live answer, 24/7
      </p>
    </div>
  </div>
</div>
