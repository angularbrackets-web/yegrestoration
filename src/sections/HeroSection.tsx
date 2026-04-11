import { useEffect, useRef } from 'react';
import { Phone } from 'lucide-react';
import gsap from 'gsap';
import { ComparisonSlider } from '../components/ComparisonSlider';

export function HeroSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const bgWordRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const headlineRef = useRef<HTMLHeadingElement>(null);
  const subheadRef = useRef<HTMLParagraphElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const trustBadgesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    // Closure vars for parallax — initialized after load animation completes
    let xTo: ((v: number) => void) | null = null;
    let yTo: ((v: number) => void) | null = null;
    let parallaxEnabled = false;

    const ctx = gsap.context(() => {
      const loadTl = gsap.timeline({
        defaults: { ease: 'power2.out' },
        onComplete: () => {
          if (!sliderRef.current) return;
          if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          xTo = gsap.quickTo(sliderRef.current, 'x', { duration: 0.6, ease: 'power2.out' });
          yTo = gsap.quickTo(sliderRef.current, 'y', { duration: 0.8, ease: 'power2.out' });
          parallaxEnabled = true;
        },
      });

      loadTl.fromTo(bgWordRef.current, { opacity: 0 }, { opacity: 1, duration: 0.6 }, 0);
      loadTl.fromTo(sliderRef.current, { x: '12vw', opacity: 0 }, { x: 0, opacity: 1, duration: 0.9 }, 0.1);

      const headlineWords = headlineRef.current?.querySelectorAll('.word');
      if (headlineWords) {
        loadTl.fromTo(
          headlineWords,
          { y: 40, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.8, stagger: 0.04 },
          0.2
        );
      }

      loadTl.fromTo(subheadRef.current, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6 }, 0.5);
      loadTl.fromTo(ctaRef.current, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6 }, 0.6);
      loadTl.fromTo(trustBadgesRef.current, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5 }, 0.68);
    }, section);

    const handleMouseMove = (e: MouseEvent) => {
      if (!parallaxEnabled || !xTo || !yTo || window.innerWidth < 1024) return;
      const rect = section.getBoundingClientRect();
      const nx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
      const ny = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
      xTo(nx * 8);
      yTo(ny * 5);
    };

    const handleMouseLeave = () => {
      if (!sliderRef.current) return;
      gsap.to(sliderRef.current, { x: 0, y: 0, duration: 0.8, ease: 'power3.out' });
    };

    section.addEventListener('mousemove', handleMouseMove);
    section.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      ctx.revert();
      section.removeEventListener('mousemove', handleMouseMove);
      section.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      className="relative min-h-screen overflow-hidden bg-yeg-bg flex flex-col lg:flex-row lg:items-center z-10"
    >
      {/* Background Word */}
      <div
        ref={bgWordRef}
        className="absolute bg-word opacity-0"
        style={{ left: '4vw', top: '8vh' }}
      >
        EMERGENCY
      </div>

      {/* Ambient amber glow — upper left light source */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          background:
            'radial-gradient(ellipse 55% 45% at 10% 20%, rgba(242,201,76,0.05) 0%, transparent 65%)',
        }}
      />

      {/* Left Content Gradient */}
      <div
        className="absolute left-0 top-0 bottom-0 w-full lg:w-[45%] z-10"
        style={{
          background: 'linear-gradient(to right, #0A0E17 0%, #0A0E17 60%, transparent 100%)',
        }}
      />

      {/* Text Content */}
      <div className="relative z-20 w-full lg:w-[40%] px-6 lg:px-[8vw] pt-24 lg:pt-0 pb-24 lg:pb-0">
        {/* Headline */}
        <h1
          ref={headlineRef}
          className="font-display font-extrabold text-display-xl text-yeg-text uppercase mb-6"
        >
          <span className="word inline-block">YOUR</span>{' '}
          <span className="word inline-block">EMERGENCY</span>
          <br />
          <span className="word inline-block">ENDS</span>{' '}
          <span className="word inline-block text-yeg-amber">NOW</span>
        </h1>

        {/* Subheadline */}
        <p
          ref={subheadRef}
          className="text-yeg-text-secondary text-lg lg:text-xl leading-relaxed max-w-md mb-8 opacity-0"
        >
          4,200+ Edmonton families restored. 60-minute response, any time of day.
        </p>

        {/* Primary CTA */}
        <div ref={ctaRef} className="flex items-start gap-4 mb-5 opacity-0">
          <a href="tel:7805550199" className="cta-primary animate-beacon-pulse">
            <Phone className="w-5 h-5" />
            <span className="font-bold">Call (780) 555-0199</span>
          </a>
        </div>

        {/* Trust Badges */}
        <div ref={trustBadgesRef} className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-6 opacity-0">
          {['IICRC Certified', '60-Min Response', 'Written Guarantee'].map((badge) => (
            <span key={badge} className="trust-badge">
              <span className="w-1 h-1 rounded-full bg-yeg-amber/50 flex-shrink-0 inline-block" />
              {badge}
            </span>
          ))}
        </div>

        {/* Mobile Slider (in-flow, below badges) */}
        <div className="lg:hidden mt-6 w-full aspect-[4/3] max-h-[45vh]">
          <ComparisonSlider
            beforeImage="/before-damage.png"
            afterImage="/after-restored.png"
            beforeAlt="Before: Mold damage and deteriorated framing"
            afterAlt="After: Clean restored framing with new insulation"
          />
        </div>
      </div>

      {/* Desktop Slider */}
      <div
        ref={sliderRef}
        className="hidden lg:block absolute right-0 top-[12vh] w-[60vw] h-[70vh] opacity-0"
      >
        <ComparisonSlider
          beforeImage="/before-damage.png"
          afterImage="/after-restored.png"
          beforeAlt="Before: Mold damage and deteriorated framing with debris"
          afterAlt="After: Clean restored framing with new insulation and copper pipes"
        />
      </div>
    </section>
  );
}
