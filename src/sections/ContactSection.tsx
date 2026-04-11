import { useEffect, useRef, useState } from 'react';
import { Phone, Mail, Clock, MapPin, Send, Shield, Star } from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export function ContactSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const leftColRef = useRef<HTMLDivElement>(null);
  const formCardRef = useRef<HTMLDivElement>(null);
  const formFieldsRef = useRef<HTMLDivElement>(null);
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    service: '',
    message: '',
  });
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const ctx = gsap.context(() => {
      // Left column reveal
      gsap.fromTo(
        leftColRef.current,
        { x: '-8vw', opacity: 0 },
        {
          x: 0,
          opacity: 1,
          duration: 0.7,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: section,
            start: 'top 85%',
            once: true,
          },
        }
      );

      // Form card reveal with subtle rotation
      gsap.fromTo(
        formCardRef.current,
        { x: '8vw', opacity: 0, rotateY: 6 },
        {
          x: 0,
          opacity: 1,
          rotateY: 0,
          duration: 0.7,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: section,
            start: 'top 85%',
            once: true,
          },
        }
      );

      // Form fields stagger reveal
      const fields = formFieldsRef.current?.querySelectorAll('.form-field');
      if (fields) {
        gsap.fromTo(
          fields,
          { y: 16, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            stagger: 0.06,
            duration: 0.7,
            ease: 'power2.out',
            scrollTrigger: {
              trigger: section,
              start: 'top 85%',
              once: true,
            },
          }
        );
      }
    }, section);

    return () => ctx.revert();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setTimeout(() => setSubmitted(false), 3000);
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  return (
    <section
      ref={sectionRef}
      id="contact"
      className="relative bg-yeg-bg min-h-screen py-20 lg:py-0"
      style={{ zIndex: 60 }}
    >
      {/* Background Word */}
      <div
        className="absolute bg-word opacity-[0.06]"
        style={{ left: '4vw', top: '8vh' }}
      >
        RESPONSE
      </div>

      <div className="relative w-full min-h-screen flex items-center">
        <div className="w-full flex flex-col lg:flex-row items-start lg:items-center gap-12 lg:gap-0 px-6 lg:px-[8vw] py-12 lg:py-0">
          {/* Left Column - Info */}
          <div ref={leftColRef} className="w-full lg:w-[40%] opacity-0">
            <h2 className="font-display font-extrabold text-display-lg text-yeg-text mb-4">
              Get a Free Quote
            </h2>
            <p className="text-yeg-text-secondary text-lg leading-relaxed max-w-md mb-10">
              Tell us what happened. We'll respond within 15 minutes.
            </p>

            {/* Contact Details */}
            <div className="space-y-5 mb-10">
              <a
                href="tel:7805550199"
                className="flex items-center gap-4 text-yeg-text hover:text-yeg-amber transition-colors group"
              >
                <div className="w-10 h-10 rounded-full bg-yeg-bg-light border border-white/10 flex items-center justify-center group-hover:border-yeg-amber/50 transition-colors">
                  <Phone className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xs text-yeg-text-secondary uppercase tracking-wider mb-0.5">
                    Emergency Line
                  </p>
                  <p className="font-semibold">(780) 555-0199</p>
                  <p className="text-xs text-yeg-text-secondary/70 mt-0.5">
                    We answer every call live — no voicemail.
                  </p>
                </div>
              </a>

              <a
                href="mailto:help@yegrestoration.ca"
                className="flex items-center gap-4 text-yeg-text hover:text-yeg-amber transition-colors group"
              >
                <div className="w-10 h-10 rounded-full bg-yeg-bg-light border border-white/10 flex items-center justify-center group-hover:border-yeg-amber/50 transition-colors">
                  <Mail className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xs text-yeg-text-secondary uppercase tracking-wider mb-0.5">
                    Email
                  </p>
                  <p className="font-semibold">help@yegrestoration.ca</p>
                </div>
              </a>

              <div className="flex items-center gap-4 text-yeg-text">
                <div className="w-10 h-10 rounded-full bg-yeg-bg-light border border-white/10 flex items-center justify-center">
                  <Clock className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xs text-yeg-text-secondary uppercase tracking-wider mb-0.5">
                    Hours
                  </p>
                  <p className="font-semibold">Open 24/7 — including holidays</p>
                </div>
              </div>

              <div className="flex items-center gap-4 text-yeg-text">
                <div className="w-10 h-10 rounded-full bg-yeg-bg-light border border-white/10 flex items-center justify-center">
                  <MapPin className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xs text-yeg-text-secondary uppercase tracking-wider mb-0.5">
                    Service Area
                  </p>
                  <p className="font-semibold">Edmonton & Surrounding Areas</p>
                </div>
              </div>
            </div>

            {/* Trust Line */}
            <div className="flex items-center gap-4 text-xs text-yeg-text-secondary">
              <div className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-yeg-amber" />
                <span>IICRC certified</span>
              </div>
              <span>•</span>
              <div className="flex items-center gap-1.5">
                <Star className="w-3.5 h-3.5 text-yeg-amber fill-yeg-amber" />
                <span>Local</span>
              </div>
              <span>•</span>
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-yeg-amber" />
                <span>24/7</span>
              </div>
            </div>
          </div>

          {/* Right Column - Form */}
          <div
            ref={formCardRef}
            className="w-full lg:w-[50%] lg:ml-auto opacity-0"
            style={{ perspective: '1000px' }}
          >
            <div className="bg-yeg-bg-light border border-white/10 rounded-xl p-6 lg:p-10">
              {submitted ? (
                <div className="text-center py-12">
                  <div className="w-16 h-16 rounded-full bg-yeg-amber/20 flex items-center justify-center mx-auto mb-6">
                    <Send className="w-8 h-8 text-yeg-amber" />
                  </div>
                  <h3 className="font-display font-bold text-2xl text-yeg-text mb-2">
                    Request Sent!
                  </h3>
                  <p className="text-yeg-text-secondary">
                    We'll call you within 15 minutes.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit}>
                  <div ref={formFieldsRef} className="space-y-5">
                    <div className="form-field opacity-0">
                      <label className="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
                        Name
                      </label>
                      <input
                        type="text"
                        name="name"
                        value={formData.name}
                        onChange={handleChange}
                        required
                        className="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors"
                        placeholder="Your name"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      <div className="form-field opacity-0">
                        <label className="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
                          Phone
                        </label>
                        <input
                          type="tel"
                          name="phone"
                          value={formData.phone}
                          onChange={handleChange}
                          required
                          className="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors"
                          placeholder="(780) 555-0199"
                        />
                      </div>

                      <div className="form-field opacity-0">
                        <label className="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
                          Email
                        </label>
                        <input
                          type="email"
                          name="email"
                          value={formData.email}
                          onChange={handleChange}
                          className="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors"
                          placeholder="you@email.com"
                        />
                      </div>
                    </div>

                    <div className="form-field opacity-0">
                      <label className="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
                        Service Needed
                      </label>
                      <select
                        name="service"
                        value={formData.service}
                        onChange={handleChange}
                        required
                        className="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text focus:outline-none focus:border-yeg-amber/50 transition-colors appearance-none cursor-pointer"
                      >
                        <option value="">Select a service</option>
                        <option value="water">Water Damage Restoration</option>
                        <option value="fire">Fire Damage Restoration</option>
                        <option value="mold">Mold Removal</option>
                        <option value="storm">Storm Damage Repair</option>
                        <option value="construction">Construction Services</option>
                        <option value="contents">Contents Restoration</option>
                        <option value="biohazard">Biohazard Cleaning</option>
                        <option value="asbestos">Asbestos Abatement</option>
                        <option value="other">Other Emergency</option>
                      </select>
                    </div>

                    <div className="form-field opacity-0">
                      <label className="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
                        Message
                      </label>
                      <textarea
                        name="message"
                        value={formData.message}
                        onChange={handleChange}
                        rows={4}
                        className="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors resize-none"
                        placeholder="Describe the emergency..."
                      />
                    </div>

                    <div className="form-field opacity-0 pt-2">
                      <button type="submit" className="cta-primary w-full justify-center">
                        <Send className="w-4 h-4" />
                        <span>Send Request</span>
                      </button>
                    </div>

                    <p className="form-field opacity-0 text-xs text-yeg-text-secondary text-center">
                      We never share your info. Emergency calls always prioritized.
                    </p>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
