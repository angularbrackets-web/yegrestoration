import { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

interface VideoItem {
  src: string;
  label: string;
}

const videoItems: VideoItem[] = [
  { src: '/videos/hero1.mp4', label: 'Moisture Detection' },
  { src: '/videos/hero2.mp4', label: 'Water Extraction' },
  { src: '/videos/hero3.mp4', label: 'Immediate Response' },
  { src: '/videos/hero4.mp4', label: 'Day Or Night' },
  { src: '/videos/hero5.mp4', label: 'Certified Crews' },
  { src: '/videos/hero6.mp4', label: 'Mold Removal' },
  { src: '/videos/hero7.mp4', label: 'Guaranteed Restoration' },
];

export function VideoReelSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [fading, setFading] = useState(false);

  // Scroll entrance animation
  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    gsap.set(section, { opacity: 0, y: 40 });

    const ctx = gsap.context(() => {
      gsap.to(section, {
        opacity: 1,
        y: 0,
        duration: 0.9,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: section,
          start: 'top 80%',
          once: true,
        },
      });
    }, section);

    return () => ctx.revert();
  }, []);

  // Play/pause videos based on activeIndex
  useEffect(() => {
    videoRefs.current.forEach((video, i) => {
      if (!video) return;
      if (i === activeIndex) {
        video.play().catch(() => {});
      } else {
        video.pause();
        video.currentTime = 0;
      }
    });
  }, [activeIndex]);

  // Auto-advance when active video ends
  const handleEnded = () => {
    setFading(true);
    setTimeout(() => {
      setActiveIndex((i) => (i + 1) % videoItems.length);
      setFading(false);
    }, 350);
  };

  const handlePanelEnter = (index: number) => {
    if (index === activeIndex) return;
    setActiveIndex(index);
  };

  const scrollToContact = () => {
    const contact = document.getElementById('contact');
    if (contact) window.scrollTo({ top: contact.offsetTop, behavior: 'smooth' });
  };

  return (
    <section ref={sectionRef} className="relative bg-yeg-bg py-20 lg:py-28 overflow-hidden">
      <div className="container mx-auto px-6 lg:px-8">
        <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">

          {/* Left: Text Column */}
          <div className="w-full lg:w-2/5 flex-shrink-0 text-center lg:text-left">
            <span className="inline-block text-xs font-semibold tracking-[0.2em] uppercase text-yeg-amber mb-5 font-body">
              See the Work
            </span>
            <h2 className="font-display font-bold text-yeg-text leading-tight mb-6" style={{ fontSize: 'clamp(34px, 4.2vw, 56px)' }}>
              From Disaster<br />to Restored
            </h2>
            <p className="font-body text-yeg-text-secondary text-lg leading-relaxed mb-8 max-w-md mx-auto lg:mx-0">
              Every project tells a story. Watch our teams respond, remediate, and rebuild — returning homes and businesses to better than before.
            </p>
            <button onClick={scrollToContact} className="cta-primary">
              Get Emergency Help
            </button>
          </div>

          {/* Right: Video Accordion */}
          <div className="w-full lg:w-3/5">
            <div className="flex flex-row gap-2 h-[500px] overflow-hidden rounded-2xl">
              {videoItems.map((item, i) => (
                <div
                  key={i}
                  onMouseEnter={() => handlePanelEnter(i)}
                  style={{ flex: i === activeIndex ? '5 1 0%' : '0.5 1 0%' }}
                  className="relative overflow-hidden rounded-2xl cursor-pointer transition-all duration-700 ease-in-out"
                >
                  {/* Video */}
                  <video
                    ref={(el) => { videoRefs.current[i] = el; }}
                    src={item.src}
                    muted
                    playsInline
                    preload="metadata"
                    onEnded={i === activeIndex ? handleEnded : undefined}
                    className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-[350ms] ${
                      i === activeIndex && fading ? 'opacity-0' : 'opacity-100'
                    }`}
                  />

                  {/* Overlay — lighter when active */}
                  <div
                    className={`absolute inset-0 transition-all duration-700 ${
                      i === activeIndex ? 'bg-black/25' : 'bg-black/65'
                    }`}
                  />

                  {/* Amber bottom accent when active */}
                  <div
                    className={`absolute bottom-0 inset-x-0 h-0.5 bg-yeg-amber transition-opacity duration-500 ${
                      i === activeIndex ? 'opacity-100' : 'opacity-0'
                    }`}
                  />

                  {/* Panel label */}
                  <span
                    className={`absolute font-body font-semibold text-white whitespace-nowrap transition-all duration-300 ease-in-out ${
                      i === activeIndex
                        ? 'bottom-5 left-5 text-sm rotate-0 opacity-100'
                        : 'bottom-24 left-1/2 -translate-x-1/2 text-xs rotate-90 opacity-60'
                    }`}
                  >
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}
