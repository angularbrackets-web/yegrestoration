import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import gsap from 'gsap';

interface ComparisonSliderProps {
  beforeImage: string;
  afterImage: string;
  beforeAlt?: string;
  afterAlt?: string;
}

export function ComparisonSlider({
  beforeImage,
  afterImage,
  beforeAlt = 'Before image showing damage',
  afterAlt = 'After image showing restoration',
}: ComparisonSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const teaserTlRef = useRef<gsap.core.Timeline | null>(null);
  const [position, setPosition] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const [showLabels, setShowLabels] = useState(false);
  const prefersReducedMotion = useRef(false);

  // Check for reduced motion preference
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion.current = mediaQuery.matches;

    const handleChange = (e: MediaQueryListEvent) => {
      prefersReducedMotion.current = e.matches;
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  // Teaser animation on load
  useEffect(() => {
    if (prefersReducedMotion.current) {
      setPosition(50);
      setShowLabels(true);
      return;
    }

    const proxy = { pos: 50 };
    const tl = gsap.timeline({
      onComplete: () => {
        setTimeout(() => setShowLabels(true), 400);
      },
    });

    // Phase 1: swing left to 22% — reveal the damage dramatically
    tl.to(proxy, {
      pos: 22,
      duration: 1.0,
      ease: 'power3.out',
      onUpdate: () => setPosition(Math.max(5, Math.min(95, proxy.pos))),
    });

    // Phase 2: spring-settle back toward center — 50ms pause then elastic snap
    tl.to(proxy, {
      pos: 50,
      duration: 1.4,
      ease: 'elastic.out(1, 0.75)',
      onUpdate: () => setPosition(Math.max(5, Math.min(95, proxy.pos))),
    }, '+=0.05');

    teaserTlRef.current = tl;

    return () => {
      tl.kill();
    };
  }, []);

  // Handle drag/touch
  const handleInteraction = useCallback(
    (clientX: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newPosition = Math.max(5, Math.min(95, ((clientX - rect.left) / rect.width) * 100));
      setPosition(newPosition);
    },
    []
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // Kill teaser if still running
      teaserTlRef.current?.kill();
      setIsDragging(true);
      handleInteraction(e.clientX);
    },
    [handleInteraction]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      handleInteraction(e.clientX);
    },
    [isDragging, handleInteraction]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      teaserTlRef.current?.kill();
      setIsDragging(true);
      const touch = e.touches[0];
      handleInteraction(touch.clientX);
    },
    [handleInteraction]
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!isDragging) return;
      const touch = e.touches[0];
      handleInteraction(touch.clientX);
    },
    [isDragging, handleInteraction]
  );

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPosition((prev) => Math.max(5, prev - 5));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPosition((prev) => Math.min(95, prev + 5));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setPosition(5);
      } else if (e.key === 'End') {
        e.preventDefault();
        setPosition(95);
      }
    },
    []
  );

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('touchmove', handleTouchMove, { passive: false });
      window.addEventListener('touchend', handleTouchEnd);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isDragging, handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full rounded-lg overflow-hidden shadow-image cursor-ew-resize"
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
    >
      {/* After image (full background) */}
      <div className="absolute inset-0 w-full h-full">
        <img
          src={afterImage}
          alt={afterAlt}
          className="w-full h-full object-cover"
          loading="eager"
          fetchPriority="high"
        />
      </div>

      {/* Before image — GPU-composited clipPath clipping */}
      <div
        className="absolute inset-0 w-full h-full"
        style={{
          clipPath: `inset(0 ${100 - position}% 0 0)`,
          willChange: 'clip-path',
        }}
      >
        <img
          src={beforeImage}
          alt={beforeAlt}
          className="w-full h-full object-cover"
          loading="eager"
          fetchPriority="high"
        />
      </div>

      {/* Ambient glow beam — follows divider */}
      <div
        className="absolute top-0 bottom-0 pointer-events-none z-[15]"
        style={{
          left: `${position}%`,
          transform: 'translateX(-50%)',
          width: isDragging ? '120px' : '80px',
          background: isDragging
            ? 'radial-gradient(ellipse 60px 100% at 50% 50%, rgba(242,201,76,0.18) 0%, rgba(242,201,76,0.06) 50%, transparent 100%)'
            : 'radial-gradient(ellipse 40px 100% at 50% 50%, rgba(242,201,76,0.10) 0%, rgba(242,201,76,0.03) 50%, transparent 100%)',
          transition: 'width 0.3s ease, background 0.3s ease',
        }}
      />

      {/* Vertical divider line with glow */}
      <div
        className="absolute top-0 bottom-0 w-px bg-yeg-amber z-10"
        style={{
          left: `${position}%`,
          transform: 'translateX(-50%)',
          boxShadow: isDragging
            ? '0 0 8px 2px rgba(242,201,76,0.9), 0 0 20px 4px rgba(242,201,76,0.55), 0 0 48px 8px rgba(242,201,76,0.25)'
            : '0 0 6px 1px rgba(242,201,76,0.7), 0 0 16px 3px rgba(242,201,76,0.35), 0 0 36px 6px rgba(242,201,76,0.15)',
          transition: 'box-shadow 0.2s ease',
        }}
      />

      {/* Handle */}
      <button
        ref={handleRef}
        className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-yeg-amber flex items-center justify-center shadow-[0_0_20px_rgba(255,182,39,0.5),0_0_40px_rgba(255,182,39,0.3),0_0_60px_rgba(255,182,39,0.15)] hover:shadow-[0_0_30px_rgba(255,182,39,0.7),0_0_60px_rgba(255,182,39,0.4),0_0_90px_rgba(255,182,39,0.2)] hover:scale-110 transition-all duration-200 cursor-ew-resize focus:outline-none focus:ring-2 focus:ring-yeg-amber focus:ring-offset-2 focus:ring-offset-yeg-bg z-20"
        style={{ left: `${position}%` }}
        aria-label="Comparison slider showing water damage restoration before and after"
        role="slider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        aria-orientation="horizontal"
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e);
        }}
        onTouchStart={(e) => {
          e.stopPropagation();
          handleTouchStart(e);
        }}
        tabIndex={0}
      >
        <div className="flex items-center">
          <ChevronLeft className="w-4 h-4 text-yeg-bg" />
          <ChevronRight className="w-4 h-4 text-yeg-bg" />
        </div>
      </button>

      {/* Labels */}
      <div
        className={`absolute top-4 left-4 px-3 py-1.5 bg-yeg-bg/80 backdrop-blur-sm rounded text-xs font-medium tracking-wider uppercase text-yeg-amber transition-opacity duration-300 ${showLabels ? 'opacity-100' : 'opacity-0'}`}
        style={{ fontFamily: "'Source Serif 4', serif", letterSpacing: '0.1em' }}
      >
        Before
      </div>
      <div
        className={`absolute top-4 right-4 px-3 py-1.5 bg-yeg-bg/80 backdrop-blur-sm rounded text-xs font-medium tracking-wider uppercase text-yeg-amber transition-opacity duration-300 ${showLabels ? 'opacity-100' : 'opacity-0'}`}
        style={{ fontFamily: "'Source Serif 4', serif", letterSpacing: '0.1em' }}
      >
        After
      </div>

      {/* Drag hint */}
      <div
        className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-yeg-amber font-semibold bg-yeg-bg/85 border border-yeg-amber/30 backdrop-blur-sm px-3 py-1.5 rounded-full pointer-events-none transition-opacity duration-300"
        style={{ opacity: showLabels ? 1 : 0 }}
      >
        Drag to compare
      </div>

      {/* Screen reader description */}
      <span className="sr-only">
        Before image showing mold damage, After image showing restored framing
      </span>
    </div>
  );
}
