import { Phone, Mail, MapPin, Clock, Shield } from 'lucide-react';
import { BrandLogoGoldBlob } from './BrandLogo';

const footerServices = [
  { label: 'Water Damage Restoration', href: '#water' },
  { label: 'Fire Damage Restoration', href: '#fire' },
  { label: 'Mold Removal', href: '#mold' },
  { label: 'Storm Damage Repair', href: '#storm' },
  { label: 'Construction Services', href: '#contact' },
  { label: 'Contents Restoration', href: '#contact' },
  { label: 'Biohazard Cleaning', href: '#contact' },
  { label: 'Asbestos Abatement', href: '#contact' },
];

export function Footer() {
  const scrollTo = (id: string) => {
    const el = document.getElementById(id.replace('#', ''));
    if (el) window.scrollTo({ top: el.offsetTop, behavior: 'smooth' });
  };

  return (
    <footer className="bg-[#080b12] border-t border-white/[0.05]">
      <div className="px-6 lg:px-[8vw] pt-16 pb-8">
        {/* Main Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-8 pb-12 border-b border-white/[0.05]">
          {/* Column 1 — Brand */}
          <div className="md:col-span-2 lg:col-span-1">
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="inline-block mb-5"
            >
              <BrandLogoGoldBlob variant="footer" />
            </a>

            <p className="text-sm text-yeg-text-secondary leading-relaxed mb-6 max-w-xs">
              Edmonton's most trusted emergency restoration team. Available 24/7, 365 days a year — water, fire, mold, storm, and beyond.
            </p>

            {/* Certification badges */}
            <div className="flex flex-wrap gap-2">
              {['IICRC Certified', 'Licensed & Insured', 'BBB Accredited'].map((badge) => (
                <span
                  key={badge}
                  className="inline-flex items-center gap-1.5 border border-white/10 rounded px-2.5 py-1 text-xs text-yeg-text-secondary"
                >
                  <Shield className="w-3 h-3 text-yeg-amber/60" />
                  {badge}
                </span>
              ))}
            </div>
          </div>

          {/* Column 2 — Services */}
          <div>
            <p className="text-xs font-medium text-yeg-amber/50 uppercase tracking-widest mb-5">
              Services
            </p>
            <ul className="space-y-2.5">
              {footerServices.map(({ label, href }) => (
                <li key={label}>
                  <a
                    href={href}
                    onClick={(e) => {
                      e.preventDefault();
                      scrollTo(href);
                    }}
                    className="text-sm text-yeg-text-secondary hover:text-yeg-text transition-colors duration-200"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Column 3 — Contact */}
          <div>
            <p className="text-xs font-medium text-yeg-amber/50 uppercase tracking-widest mb-5">
              Contact
            </p>
            <ul className="space-y-4">
              <li>
                <a
                  href="tel:7805550199"
                  className="flex items-start gap-3 text-sm group"
                >
                  <Phone className="w-4 h-4 text-yeg-amber/60 mt-0.5 shrink-0" />
                  <div>
                    <span className="text-yeg-text group-hover:text-yeg-amber transition-colors font-medium">
                      (780) 555-0199
                    </span>
                    <p className="text-xs text-yeg-text-secondary mt-0.5">Emergency line — live answer</p>
                  </div>
                </a>
              </li>
              <li>
                <a
                  href="mailto:help@yegrestoration.ca"
                  className="flex items-start gap-3 text-sm group"
                >
                  <Mail className="w-4 h-4 text-yeg-amber/60 mt-0.5 shrink-0" />
                  <span className="text-yeg-text-secondary group-hover:text-yeg-text transition-colors">
                    help@yegrestoration.ca
                  </span>
                </a>
              </li>
              <li className="flex items-start gap-3 text-sm">
                <MapPin className="w-4 h-4 text-yeg-amber/60 mt-0.5 shrink-0" />
                <span className="text-yeg-text-secondary">Edmonton, Alberta</span>
              </li>
              <li className="flex items-start gap-3 text-sm">
                <Clock className="w-4 h-4 text-yeg-amber/60 mt-0.5 shrink-0" />
                <span className="text-yeg-text-secondary">24/7 Emergency Response</span>
              </li>
            </ul>
          </div>

          {/* Column 4 — Emergency CTA */}
          <div className="md:col-span-2 lg:col-span-1">
            <p className="text-xs font-medium text-yeg-amber/50 uppercase tracking-widest mb-5">
              Emergency?
            </p>
            <p className="text-sm text-yeg-text-secondary mb-5 leading-relaxed">
              Specialists answer every call — no voicemail, no hold music, no call centres.
            </p>
            <a
              href="tel:7805550199"
              className="cta-primary inline-flex"
            >
              <Phone className="w-4 h-4" />
              <span>(780) 555-0199</span>
            </a>
            <p className="text-xs text-yeg-text-secondary/60 mt-3">
              Or{' '}
              <a
                href="#contact"
                onClick={(e) => {
                  e.preventDefault();
                  scrollTo('contact');
                }}
                className="text-yeg-amber/70 hover:text-yeg-amber transition-colors underline underline-offset-2"
              >
                request a callback
              </a>
            </p>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="flex flex-col sm:flex-row justify-between items-center gap-3 pt-6">
          <p className="text-xs text-yeg-text-secondary/60">
            © {new Date().getFullYear()} YEG Restoration. All rights reserved.
          </p>
          <p className="text-xs text-yeg-text-secondary/60">
            Edmonton, Alberta · IICRC Certified · Licensed &amp; Insured
          </p>
        </div>
      </div>
    </footer>
  );
}
