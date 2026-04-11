import { HeroSection } from './sections/HeroSection';
import { VideoReelSection } from './sections/VideoReelSection';
import { ServiceSection } from './sections/ServiceSection';
import { AdditionalServicesSection } from './sections/AdditionalServicesSection';
import { ContactSection } from './sections/ContactSection';
import { StatsBar } from './components/StatsBar';
import { ProcessSection } from './sections/ProcessSection';
import { TestimonialsSection } from './sections/TestimonialsSection';
import { Footer } from './components/Footer';
import { CommandStrip } from './components/CommandStrip';
import { Navbar } from './components/Navbar';
import './App.css';

const services = [
  {
    id: 'water',
    bgWord: 'FLOOD',
    tagline: 'Stop the damage before it spreads.',
    title: 'Water Damage',
    description:
      'Rapid extraction, drying, and structural protection. We stop the spread and prevent secondary damage.',
    features: [
      "24/7 extraction — we're on-site within 60 minutes",
      'Industrial drying & dehumidification',
      'Complete moisture mapping for your insurance claim',
    ],
    ctaText: 'Get Free Assessment',
    imageSrc: '/hero-water.jpg',
    imageAlt: 'Water damage restoration',
  },
  {
    id: 'fire',
    bgWord: 'BURN',
    tagline: 'Every trace of the fire, gone.',
    title: 'Fire & Smoke Damage',
    description:
      'Soot removal, odor neutralization, and structural cleanup—fast, safe, and thorough.',
    features: [
      'Emergency board-up & securing',
      'Soot & residue cleaning',
      'Thermal fogging & deodorization',
    ],
    ctaText: 'Get Free Assessment',
    imageSrc: '/hero-fire.jpg',
    imageAlt: 'Fire damage restoration',
  },
  {
    id: 'mold',
    bgWord: 'MOLD',
    tagline: 'Safely removed. Not just masked.',
    title: 'Mold Remediation',
    description:
      'Containment, removal, and prevention—built around safety and air quality.',
    features: [
      'Containment & negative air setup',
      'HEPA filtration & removal',
      'Prevention plan & moisture control',
    ],
    ctaText: 'Get Free Assessment',
    imageSrc: '/hero-mold.jpg',
    imageAlt: 'Mold remediation',
  },
  {
    id: 'storm',
    bgWord: 'STORM',
    tagline: 'Emergency response, same day.',
    title: 'Storm Damage',
    description:
      'Roof tarps, debris removal, and structural stabilization when the weather strikes.',
    features: [
      'Emergency roof tarps & patching',
      'Debris removal & tree impact',
      'Structural stabilization',
    ],
    ctaText: 'Get Free Assessment',
    imageSrc: '/hero-storm.jpg',
    imageAlt: 'Storm damage restoration',
  },
];

function App() {
  const scrollToContact = () => {
    const contact = document.getElementById('contact');
    if (contact) window.scrollTo({ top: contact.offsetTop, behavior: 'smooth' });
  };

  return (
    <>
      {/* Film Grain Overlay */}
      <div className="grain-overlay" />

      {/* Concrete Texture Overlay (2% opacity) */}
      <div className="concrete-texture" />

      {/* Sticky Navbar */}
      <Navbar />

      {/* Main Content */}
      <main id="main-content" className="relative">
        <HeroSection />
        <VideoReelSection />
        <StatsBar />
        {services.map((service, index) => (
          <ServiceSection
            key={service.id}
            {...service}
            reversed={index % 2 !== 0}
            onContactClick={scrollToContact}
          />
        ))}
        <AdditionalServicesSection />
        <ProcessSection />
        <TestimonialsSection />
        <ContactSection />
      </main>

      {/* Footer */}
      <Footer />

      {/* Command Strip (fixed bottom) */}
      <CommandStrip />

    </>
  );
}

export default App;
