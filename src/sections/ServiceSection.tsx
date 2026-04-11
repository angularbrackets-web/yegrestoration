import { ArrowRight, Check } from 'lucide-react';

interface ServiceSectionProps {
  id: string;
  bgWord: string;
  tagline: string;
  title: string;
  description: string;
  features: string[];
  ctaText: string;
  imageSrc: string;
  imageAlt: string;
  reversed?: boolean;
  onContactClick?: () => void;
}

export function ServiceSection({
  id,
  bgWord,
  tagline,
  title,
  description,
  features,
  ctaText,
  imageSrc,
  imageAlt,
  reversed = false,
  onContactClick,
}: ServiceSectionProps) {
  return (
    <section
      id={id}
      className={`relative min-h-screen overflow-hidden flex items-center ${
        reversed ? 'bg-[#0d1220]' : 'bg-yeg-bg'
      }`}
    >
      {/* Ambient glow — matches image side */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: reversed
            ? 'radial-gradient(ellipse 60% 50% at 15% 60%, rgba(251,146,60,0.07) 0%, transparent 70%)'
            : 'radial-gradient(ellipse 60% 50% at 85% 60%, rgba(251,146,60,0.07) 0%, transparent 70%)',
        }}
      />

      {/* Background Word */}
      <div
        className="absolute bg-word opacity-[0.07]"
        style={reversed ? { right: '4vw', top: '8vh' } : { left: '4vw', top: '8vh' }}
      >
        {bgWord}
      </div>

      {/* Mobile Image — shown above text on small screens */}
      <div className="lg:hidden w-full h-52 overflow-hidden relative mt-20">
        <img
          src={imageSrc}
          alt={imageAlt}
          className="w-full h-full object-cover"
          loading="lazy"
          decoding="async"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-yeg-bg via-transparent to-transparent" />
      </div>

      {/* Text Content */}
      <div
        className={`relative z-10 w-full lg:w-[45%] px-6 py-10 lg:py-0 ${
          reversed ? 'lg:ml-auto lg:pr-[8vw] lg:pl-8' : 'lg:px-[8vw]'
        }`}
      >
        {/* Tagline */}
        <p className="text-yeg-signal-on-dark text-xs font-medium uppercase tracking-widest mb-3">
          {tagline}
        </p>

        {/* Title */}
        <h2 className="font-display font-extrabold text-display-lg text-yeg-text mb-6">
          {title}
        </h2>

        {/* Description */}
        <p className="text-yeg-text-secondary text-lg leading-relaxed max-w-md mb-8">
          {description}
        </p>

        {/* Features */}
        <ul className="space-y-3 mb-10">
          {features.map((feature, index) => (
            <li key={index} className="flex items-center gap-3 text-yeg-text">
              <div className="w-5 h-5 rounded-full bg-yeg-signal-on-dark/20 flex items-center justify-center flex-shrink-0">
                <Check className="w-3 h-3 text-yeg-signal-on-dark" />
              </div>
              <span className="text-sm">{feature}</span>
            </li>
          ))}
        </ul>

        {/* CTA */}
        <a
          href="#contact"
          className="cta-primary"
          onClick={(e) => {
            e.preventDefault();
            onContactClick?.();
          }}
        >
          <span>{ctaText}</span>
          <ArrowRight className="w-4 h-4" />
        </a>
      </div>

      {/* Image (desktop only) */}
      <div
        className={`hidden lg:block absolute ${
          reversed ? 'left-[6vw]' : 'right-[6vw]'
        } top-[18vh] w-[46vw] h-[56vh]`}
      >
        <div className="image-frame w-full h-full rounded-lg overflow-hidden">
          <img
            src={imageSrc}
            alt={imageAlt}
            className="w-full h-full object-cover"
            loading="lazy"
            decoding="async"
          />
          {/* Gradient fades toward the text side */}
          <div
            className={`absolute inset-0 ${
              reversed
                ? 'bg-gradient-to-r from-transparent via-transparent to-[#0d1220]/50'
                : 'bg-gradient-to-l from-transparent via-transparent to-yeg-bg/50'
            }`}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/30 via-transparent to-transparent" />
        </div>
      </div>
    </section>
  );
}
