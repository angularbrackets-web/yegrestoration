import { Hammer, Package, ShieldAlert, Wind } from 'lucide-react';

const additionalServices = [
  {
    icon: Hammer,
    title: 'Construction Services',
    description:
      'Full rebuild and repair after damage. From structural work to finishing — one team, start to finish.',
  },
  {
    icon: Package,
    title: 'Contents Restoration',
    description:
      'Salvaging and restoring furniture, documents, electronics, and belongings that matter to you.',
  },
  {
    icon: ShieldAlert,
    title: 'Biohazard Cleaning',
    description:
      'Safe, discreet decontamination and disposal for trauma, sewage, and hazardous material events.',
  },
  {
    icon: Wind,
    title: 'Asbestos Abatement',
    description:
      'Certified identification, containment, and full removal of asbestos-containing materials.',
  },
];

export function AdditionalServicesSection() {
  return (
    <section className="relative bg-[#0B0F17] border-y border-white/[0.06] py-24 px-6 lg:px-[8vw] overflow-hidden">
      {/* Ambient background glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-yeg-amber/[0.03] rounded-full blur-[120px] pointer-events-none" />

      <div className="max-w-7xl mx-auto relative z-10">
        {/* Header */}
        <div className="mb-14">
          <p className="text-xs font-medium text-yeg-amber/60 uppercase tracking-widest mb-3">
            Full Scope of Services
          </p>
          <h2 className="font-display font-extrabold text-display-lg text-yeg-text mb-4">
            More Services We Offer
          </h2>
          <p className="text-yeg-text-secondary text-lg max-w-xl">
            Beyond emergency response — specialized expertise for every stage of recovery.
          </p>
        </div>

        {/* Bento Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6">
          {additionalServices.map(({ icon: Icon, title, description }, index) => {
            const isLarge = index === 0 || index === 3;
            return (
              <div
                key={title}
                className={`relative group bg-[#0F141E] rounded-2xl p-8 border border-white/[0.04] flex flex-col gap-6 overflow-hidden transition-all duration-500 hover:-translate-y-1.5 hover:border-white/[0.08] hover:shadow-[0_16px_40px_rgba(0,0,0,0.5)] ${
                  isLarge ? 'md:col-span-2' : 'md:col-span-1'
                }`}
              >
                {/* Abstract Background Texture/Glow on Hover */}
                <div className="absolute inset-0 bg-gradient-to-br from-yeg-amber/[0.03] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
                
                {/* Subtle top edge gloss */}
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/[0.1] to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

                {/* Content container */}
                <div className="relative z-10 flex flex-col h-full">
                  {/* Icon */}
                  <div className="w-14 h-14 rounded-xl bg-[#151B28] border border-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] flex items-center justify-center relative overflow-hidden mb-4 group-hover:border-white/[0.12] transition-colors duration-500">
                    <div className="absolute inset-0 bg-yeg-amber/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                    <Icon className="w-6 h-6 text-yeg-amber relative z-10" />
                  </div>

                  {/* Text */}
                  <div className="flex-1">
                    <h3 className="font-display font-bold text-2xl text-white mb-3 tracking-wide group-hover:text-yeg-amber transition-colors duration-500">
                      {title}
                    </h3>
                    <p className="text-base text-yeg-text-secondary leading-relaxed sm:max-w-md">
                      {description}
                    </p>
                  </div>

                  {/* CTA */}
                  <div className="mt-8 pt-6 border-t border-white/[0.04]">
                    <a
                      href="#contact"
                      onClick={(e) => {
                        e.preventDefault();
                        const el = document.getElementById('contact');
                        if (el) window.scrollTo({ top: el.offsetTop, behavior: 'smooth' });
                      }}
                      className="inline-flex items-center gap-2 text-sm text-yeg-amber/70 hover:text-yeg-amber transition-colors group/cta"
                    >
                      <span className="font-semibold tracking-wider uppercase text-[11px]">Get a quote</span>
                      <span className="transition-transform duration-300 group-hover/cta:translate-x-1.5">→</span>
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
