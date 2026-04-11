import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const testimonials = [
  {
    quote:
      "They showed up within 45 minutes of my call — at 2am on a Sunday. My basement had 4 inches of water and I didn't know where to start. The team was calm, professional, and had equipment running within the hour. Back to normal in under two weeks.",
    name: 'Sandra M.',
    location: 'Edmonton',
    service: 'Water damage',
  },
  {
    quote:
      "As a property manager, I've dealt with plenty of restoration companies. This is the only one I trust completely. Their documentation is thorough, their communication is excellent, and they always deliver on time. My adjusters love working with them.",
    name: 'David K.',
    location: 'Sherwood Park',
    service: 'Property manager',
  },
  {
    quote:
      "The fire left a smell throughout the whole house that I thought would never go away. Their team spent three days on odour elimination alone. Six months later, you'd never know anything happened.",
    name: 'Priya T.',
    location: 'St. Albert',
    service: 'Fire & smoke',
  },
];

function StarIcon() {
  return (
    <svg className="w-4 h-4 text-yeg-amber fill-yeg-amber" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

export function TestimonialsSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const ctx = gsap.context(() => {
      gsap.fromTo(
        headerRef.current,
        { y: 24, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.7,
          ease: 'power2.out',
          scrollTrigger: { trigger: section, start: 'top 80%', once: true },
        }
      );

      const cards = cardsRef.current?.querySelectorAll('.testimonial-card');
      if (cards) {
        gsap.fromTo(
          cards,
          { y: 36, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.7,
            stagger: 0.12,
            ease: 'power2.out',
            scrollTrigger: { trigger: cardsRef.current, start: 'top 85%', once: true },
          }
        );
      }
    }, section);

    return () => ctx.revert();
  }, []);

  return (
    <section
      ref={sectionRef}
      id="testimonials"
      className="bg-yeg-bg-light py-20 lg:py-28"
      style={{
        borderTop: '1px solid rgba(255,255,255,0.04)',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <div className="px-6 lg:px-[8vw]">
        {/* Header */}
        <div
          ref={headerRef}
          className="flex flex-col lg:flex-row lg:items-end justify-between mb-12 lg:mb-16 gap-6 opacity-0"
        >
          <div>
            <p className="text-xs font-medium text-yeg-amber/60 uppercase tracking-widest mb-3">
              Client Stories
            </p>
            <h2 className="font-display font-extrabold text-display-lg text-yeg-text mb-3">
              Real Stories, Real Results
            </h2>
            <p className="text-yeg-text-secondary text-lg">
              From families and property managers across the Edmonton area.
            </p>
          </div>

          {/* Rating badge */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="flex gap-0.5">
              {[...Array(5)].map((_, i) => (
                <StarIcon key={i} />
              ))}
            </div>
            <div className="text-sm text-yeg-text">
              <span className="font-semibold text-yeg-amber">4.9</span>
              <span className="text-yeg-text-secondary ml-1">· 287+ Google Reviews</span>
            </div>
          </div>
        </div>

        {/* Review cards */}
        <div ref={cardsRef} className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {testimonials.map((t, i) => (
            /* Gradient border wrapper — 1px gradient border via padding trick */
            <div
              key={i}
              className="testimonial-card rounded-xl p-px opacity-0"
              style={{
                background:
                  'linear-gradient(135deg, rgba(242,201,76,0.18) 0%, rgba(242,201,76,0.06) 40%, rgba(255,255,255,0.04) 100%)',
              }}
            >
              <div className="bg-yeg-bg rounded-[11px] p-6 lg:p-8 flex flex-col h-full">
                {/* Stars */}
                <div className="flex gap-0.5 mb-5">
                  {[...Array(5)].map((_, j) => (
                    <StarIcon key={j} />
                  ))}
                </div>

                {/* Quote */}
                <blockquote className="text-yeg-text text-sm lg:text-base leading-relaxed flex-1 mb-6 font-light">
                  "{t.quote}"
                </blockquote>

                {/* Attribution */}
                <div className="border-t border-white/[0.06] pt-5">
                  <div className="font-semibold text-yeg-text text-sm">{t.name}</div>
                  <div className="text-xs text-yeg-text-secondary mt-0.5">
                    {t.location} · {t.service}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
