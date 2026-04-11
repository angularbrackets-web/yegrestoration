import { useEffect, useRef } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Phone, Search, Hammer, CheckCircle } from 'lucide-react';

gsap.registerPlugin(ScrollTrigger);

const steps = [
  {
    step: '01',
    icon: Phone,
    timing: 'Within 60 min',
    title: 'Emergency Call',
    copy: 'Day or night, our emergency line is answered by a restoration specialist — not a call centre. We dispatch a crew immediately.',
  },
  {
    step: '02',
    icon: Search,
    timing: 'Same day',
    title: 'Rapid Assessment',
    copy: 'Our technicians arrive, assess the full scope of damage, and walk you through a clear restoration plan. No surprises.',
  },
  {
    step: '03',
    icon: Hammer,
    timing: '1–3 days',
    title: 'Restoration Begins',
    copy: 'We get to work immediately — stopping ongoing damage first, then systematically restoring with IICRC-certified methods and industrial equipment.',
  },
  {
    step: '04',
    icon: CheckCircle,
    timing: 'Complete',
    title: 'Final Walkthrough',
    copy: "We don't leave until you're completely satisfied. A final inspection ensures everything meets our quality standard — and yours.",
  },
];

export function ProcessSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const progressPathRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const ctx = gsap.context(() => {
      // Header reveal
      gsap.fromTo(
        headerRef.current,
        { y: 24, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.8,
          ease: 'power3.out',
          scrollTrigger: { trigger: section, start: 'top 80%', once: true },
        }
      );

      // Progress line animation (Desktop only)
      if (progressPathRef.current) {
        gsap.fromTo(
          progressPathRef.current,
          { scaleX: 0 },
          {
            scaleX: 1,
            ease: 'none',
            scrollTrigger: {
              trigger: stepsRef.current,
              start: 'top 70%',
              end: 'bottom 60%',
              scrub: 1,
            },
          }
        );
      }

      // Steps reveal
      const stepEls = stepsRef.current?.querySelectorAll('.process-step');
      if (stepEls) {
        gsap.fromTo(
          stepEls,
          { y: 40, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.8,
            stagger: 0.15,
            ease: 'power3.out',
            scrollTrigger: { trigger: stepsRef.current, start: 'top 80%', once: true },
          }
        );
      }
    }, section);

    return () => ctx.revert();
  }, []);

  return (
    <section ref={sectionRef} id="process" className="yeg-surface-paper py-24 lg:py-32 relative overflow-hidden">
      <div className="relative z-10 px-6 lg:px-[8vw] max-w-7xl mx-auto">
        {/* Header */}
        <div ref={headerRef} className="mb-16 opacity-0">
          <p className="text-xs font-semibold text-yeg-signal uppercase tracking-[0.2em] mb-4">
            Our Process
          </p>
          <h2 className="font-display font-extrabold text-4xl md:text-5xl lg:text-display-lg text-yeg-on-surface mb-5 leading-[1.1]">
            From First Call <br className="hidden sm:block" /> to Fully Restored
          </h2>
          <p className="text-yeg-on-surface-muted text-lg max-w-xl font-light leading-relaxed">
            A clear, predictable process — so you always know exactly what happens next.
          </p>
        </div>

        {/* Steps Grid */}
        <div ref={stepsRef} className="relative mt-8">
          {/* Animated Timeline Progress (Desktop) */}
          <div className="hidden lg:block absolute top-[2.75rem] left-[15%] right-[15%] h-[2px] bg-yeg-signal/10" aria-hidden>
            <div 
              ref={progressPathRef}
              className="absolute inset-0 bg-yeg-signal origin-left"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
            {steps.map((item) => (
              <div key={item.step} className="process-step group flex flex-col opacity-0">
                {/* Step Card */}
                <div className="bg-white/40 backdrop-blur-sm rounded-2xl p-8 border border-white/60 shadow-[0_4px_24px_rgba(0,0,0,0.03)] h-full transition-all duration-500 hover:-translate-y-2 hover:bg-white/60 hover:shadow-[0_20px_48px_rgba(0,0,0,0.06)] hover:border-yeg-signal/20">
                  
                  {/* Step Header: Icon + Number */}
                  <div className="flex items-center justify-between mb-8">
                    <div className="w-14 h-14 rounded-xl bg-yeg-signal/5 border border-yeg-signal/15 flex items-center justify-center relative z-10 group-hover:bg-yeg-signal group-hover:border-yeg-signal transition-all duration-500">
                      <item.icon className="w-6 h-6 text-yeg-signal group-hover:text-white transition-colors duration-500" />
                    </div>
                    <span className="font-display font-black text-yeg-signal/10 text-4xl transition-colors duration-500 group-hover:text-yeg-signal/20">
                      {item.step}
                    </span>
                  </div>

                  {/* Timing Badge */}
                  <div className="inline-block text-[10px] font-bold text-yeg-signal uppercase tracking-widest px-2.5 py-1 bg-yeg-signal/10 rounded-md mb-4 border border-yeg-signal/10">
                    {item.timing}
                  </div>

                  {/* Copy */}
                  <h3 className="font-display font-bold text-xl text-yeg-on-surface mb-3 group-hover:text-yeg-signal transition-colors duration-300">
                    {item.title}
                  </h3>
                  <p className="text-yeg-on-surface-muted text-[15px] leading-relaxed font-light">
                    {item.copy}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
