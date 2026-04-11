import { useState, useEffect, useRef, useCallback } from 'react';
import { Phone, Menu, X, ChevronRight } from 'lucide-react';
import { BrandLogoGoldBlob } from './BrandLogo';

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

export function Navbar() {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [activeLink, setActiveLink] = useState('');
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const lastFocusedElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
      lastFocusedElement.current = document.activeElement as HTMLElement;
      setTimeout(() => {
        const closeButton = mobileMenuRef.current?.querySelector('[data-close-button]') as HTMLElement;
        closeButton?.focus();
      }, 100);
    } else {
      document.body.style.overflow = '';
      if (lastFocusedElement.current) lastFocusedElement.current.focus();
    }
    return () => { document.body.style.overflow = ''; };
  }, [isMobileMenuOpen]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && isMobileMenuOpen) setIsMobileMenuOpen(false);
    if (e.key === 'Tab' && isMobileMenuOpen && mobileMenuRef.current) {
      const focusable = mobileMenuRef.current.querySelectorAll(
        'a[href], button, [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
  }, [isMobileMenuOpen]);

  const handleLinkClick = (href: string) => {
    setActiveLink(href);
    setIsMobileMenuOpen(false);
    const element = document.querySelector(href);
    if (element) element.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <>
      {/* Skip to content */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[1001] focus:bg-yeg-amber focus:text-yeg-bg focus:px-4 focus:py-2 focus:rounded focus:font-semibold"
      >
        Skip to content
      </a>

      {/* Main Navbar */}
      <nav
        className={`fixed top-0 left-0 right-0 z-[1000] transition-all duration-300 ${
          isScrolled
            ? 'bg-[rgba(11,15,23,0.96)] backdrop-blur-[14px] border-b border-white/[0.07] shadow-[0_4px_24px_rgba(0,0,0,0.4)]'
            : 'bg-transparent'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(0.25, 0.1, 0.25, 1.0)' }}
        onKeyDown={handleKeyDown}
      >
        <div className="w-full px-6 lg:px-12">
          <div className="flex items-center justify-between min-h-16 h-[4.75rem] lg:h-[5.25rem]">

            {/* Logo */}
            <a
              href="#"
              className={`flex items-center transition-transform duration-300 ${
                isScrolled ? 'scale-95' : 'scale-100'
              }`}
              style={{ transitionTimingFunction: 'cubic-bezier(0.25, 0.1, 0.25, 1.0)' }}
              onClick={(e) => {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              <BrandLogoGoldBlob variant="nav" />
            </a>

            {/* Desktop Nav Links */}
            <div className="hidden xl:flex items-center gap-1">
              {navLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  onClick={(e) => {
                    e.preventDefault();
                    handleLinkClick(link.href);
                  }}
                  className={`relative px-4 py-2 font-body text-sm font-medium tracking-wide rounded-full transition-all duration-200 ${
                    activeLink === link.href
                      ? 'text-yeg-amber bg-yeg-amber/5'
                      : 'text-yeg-text hover:text-yeg-amber hover:bg-white/[0.04]'
                  }`}
                >
                  {link.label}
                  {activeLink === link.href && (
                    <span className="absolute inset-x-4 -bottom-px h-px bg-yeg-amber/60" />
                  )}
                </a>
              ))}
            </div>

            {/* Right: Emergency CTA (Desktop) */}
            <div className="hidden xl:flex items-center gap-3">
              <a
                href="#contact"
                onClick={(e) => {
                  e.preventDefault();
                  handleLinkClick('#contact');
                }}
                className="flex items-center gap-2 bg-yeg-amber/10 hover:bg-yeg-amber/[0.15] border border-yeg-amber/25 hover:border-yeg-amber/40 text-yeg-amber rounded-full px-4 py-2 text-sm font-semibold transition-all duration-200"
              >
                Free Assessment
              </a>
              <a
                href="tel:7805550199"
                className="flex items-center gap-2.5 bg-yeg-amber hover:bg-yeg-amber-hover text-yeg-bg rounded-full px-4 py-2 text-sm font-bold transition-all duration-200"
              >
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
                  <span className="text-[9px] uppercase tracking-widest font-bold leading-none">24/7</span>
                </span>
                <Phone className="w-3.5 h-3.5" />
                <span>(780) 555-0199</span>
              </a>
            </div>

            {/* Mobile Hamburger */}
            <button
              ref={hamburgerRef}
              onClick={() => setIsMobileMenuOpen(true)}
              className="xl:hidden p-2 text-yeg-amber hover:bg-yeg-amber/10 rounded-lg transition-colors"
              aria-label="Open navigation menu"
              aria-expanded={isMobileMenuOpen}
              aria-controls="mobile-menu"
            >
              <Menu className="w-6 h-6" />
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile Menu Overlay */}
      <div
        ref={mobileMenuRef}
        id="mobile-menu"
        className={`fixed inset-0 z-[1002] xl:hidden transition-all duration-300 ${
          isMobileMenuOpen ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
        onKeyDown={handleKeyDown}
      >
        {/* Backdrop */}
        <div
          className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300 ${
            isMobileMenuOpen ? 'opacity-100' : 'opacity-0'
          }`}
          onClick={() => setIsMobileMenuOpen(false)}
        />

        {/* Panel */}
        <div
          className={`absolute right-0 top-0 bottom-0 w-full max-w-sm bg-[#0B0F17] flex flex-col transition-transform duration-300 ${
            isMobileMenuOpen ? 'translate-x-0' : 'translate-x-full'
          }`}
          style={{ transitionTimingFunction: 'cubic-bezier(0.25, 0.1, 0.25, 1.0)' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Panel Header */}
          <div className="flex items-center justify-between px-6 py-5 border-b border-white/[0.07]">
            <BrandLogoGoldBlob variant="drawer" />
            <button
              data-close-button
              onClick={() => setIsMobileMenuOpen(false)}
              className="p-2 text-yeg-text-secondary hover:text-yeg-text hover:bg-white/[0.06] rounded-lg transition-colors"
              aria-label="Close navigation menu"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Nav Links */}
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <div className="space-y-1">
              {navLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  onClick={(e) => {
                    e.preventDefault();
                    handleLinkClick(link.href);
                  }}
                  className={`flex items-center justify-between w-full px-4 py-3 rounded-xl font-display font-bold text-xl transition-colors duration-200 ${
                    activeLink === link.href
                      ? 'text-yeg-amber bg-yeg-amber/5'
                      : 'text-yeg-text hover:text-yeg-amber hover:bg-white/[0.04]'
                  }`}
                >
                  {link.label}
                  <ChevronRight className="w-4 h-4 opacity-30" />
                </a>
              ))}
            </div>

            {/* Divider + Services quick links */}
            <div className="mt-6 pt-6 border-t border-white/[0.07]">
              <p className="text-xs font-medium text-yeg-text-secondary/60 uppercase tracking-widest px-4 mb-3">
                Our Services
              </p>
              <div className="grid grid-cols-2 gap-2">
                {mobileServices.map((svc) => (
                  <a
                    key={svc.label}
                    href={svc.href}
                    onClick={(e) => {
                      e.preventDefault();
                      handleLinkClick(svc.href);
                    }}
                    className="px-3 py-2.5 rounded-lg bg-yeg-bg border border-white/[0.06] text-sm text-yeg-text-secondary hover:text-yeg-text hover:border-white/[0.12] transition-all duration-200 text-center"
                  >
                    {svc.label}
                  </a>
                ))}
              </div>
            </div>
          </div>

          {/* Panel Footer */}
          <div className="p-5 border-t border-white/[0.07] space-y-3">
            <a
              href="tel:7805550199"
              className="flex items-center justify-center gap-2.5 w-full py-3.5 bg-yeg-amber text-yeg-bg rounded-xl font-bold text-base hover:bg-yeg-amber-hover transition-colors"
            >
              <Phone className="w-4.5 h-4.5" />
              (780) 555-0199
            </a>
            <p className="text-center text-xs text-yeg-text-secondary/70">
              Emergency line — live answer, 24/7
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
