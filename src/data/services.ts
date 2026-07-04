/**
 * Single source of truth for business identity and service content.
 * Powers the homepage sections, per-service landing pages, schema.org
 * markup, nav/footer links, and the contact form's service dropdown.
 *
 * Service `id` values MUST match SERVICE_LABELS keys in src/lib/db.ts —
 * they are stored on leads and mapped back to labels in the admin panel.
 */

export const BUSINESS = {
  name: 'YEG Restoration',
  phone: '(780) 479-3285',
  phoneHref: 'tel:+17804793285',
  phoneE164: '+1-780-479-3285',
  email: 'info@yegrestoration.ca',
  url: 'https://yegrestoration.ca',
  city: 'Edmonton',
  region: 'AB',
  foundingYear: 2008,
  // Canonical entity description. Reused verbatim in schema, meta tags, and
  // the about page so search engines and AI assistants see one consistent
  // description of who we are. Edit here, never inline.
  description:
    'YEG Restoration is a 24/7 emergency property restoration company serving Edmonton and surrounding Alberta communities since 2008. IICRC-certified crews handle water damage, fire and smoke damage, mold removal, sewage cleanup, and storm damage repair — with free assessments, a written guarantee, and direct insurance billing.',
} as const;

export interface ServiceFaq {
  /** Phrased the way people actually ask it. */
  question: string;
  /** First sentence answers the question directly; detail follows. */
  answer: string;
}

export interface ServiceStep {
  step: string;
  timing: string;
  title: string;
  copy: string;
}

export interface ServicePageContent {
  slug: string;
  h1: string;
  metaTitle: string;
  metaDescription: string;
  heroTagline: string;
  heroCopy: string;
  process: [ServiceStep, ServiceStep, ServiceStep];
  faqs: ServiceFaq[];
  /** Slugs of related service pages to cross-link. */
  related: string[];
}

export interface Service {
  /** Form value + lead record key — must exist in SERVICE_LABELS (src/lib/db.ts). */
  id: string;
  /** Label shown in dropdowns and admin — keep identical to SERVICE_LABELS. */
  name: string;
  shortName: string;
  /** primary = full alternating homepage section; additional = bento card. */
  tier: 'primary' | 'additional';
  bgWord: string;
  cardTagline: string;
  cardDescription: string;
  features: string[];
  imageSrc: string;
  imageAlt: string;
  /** Real job photos — drop in when available; gallery renders slots until then. */
  photos?: { src: string; alt: string; caption: string }[];
  /** Present ⇒ the service has its own landing page at /<slug>/. */
  page?: ServicePageContent;
}

export const services: Service[] = [
  {
    id: 'water',
    name: 'Water Damage Restoration',
    shortName: 'Water Damage',
    tier: 'primary',
    bgWord: 'FLOOD',
    cardTagline: 'Stop the damage before it spreads.',
    cardDescription:
      'Rapid extraction, drying, and structural protection. We stop the spread and prevent secondary damage.',
    features: [
      "24/7 extraction — we're on-site within 60 minutes",
      'Industrial drying & dehumidification',
      'Complete moisture mapping for your insurance claim',
    ],
    imageSrc: '/hero-water.jpg',
    imageAlt: 'Water damage restoration in Edmonton',
    page: {
      slug: 'water-damage-restoration',
      h1: 'Water Damage Restoration in Edmonton',
      metaTitle: '24/7 Water Damage Restoration Edmonton | YEG Restoration',
      metaDescription:
        'Flooded basement or burst pipe? A crew is at your door in about 60 minutes, 24/7. Free assessment, direct insurance billing. Call (780) 479-3285.',
      heroTagline: 'On-site in about 60 minutes — any hour, any day',
      heroCopy:
        'Every hour water sits, it soaks deeper into your floors, walls, and framing. Call now and an IICRC-certified crew starts extraction today — free assessment, written guarantee, and we bill your insurance directly.',
      process: [
        {
          step: '01',
          timing: 'Within 60 minutes',
          title: 'Call — a specialist answers',
          copy: 'No voicemail, no call centre. We dispatch a crew while you’re still on the phone and tell you exactly what to do until they arrive.',
        },
        {
          step: '02',
          timing: 'Same day',
          title: 'Extract, dry, protect',
          copy: 'Industrial pumps and dryers pull the water out before it becomes structural damage or mold. Every reading is moisture-mapped for your insurance claim.',
        },
        {
          step: '03',
          timing: 'Final walkthrough',
          title: 'Restore and sign off',
          copy: 'We verify dryness with meters — not guesswork — repair what was damaged, and hand you the documentation your insurer needs. Backed by our written guarantee.',
        },
      ],
      faqs: [
        {
          question: 'How fast can you get to my home in Edmonton?',
          answer:
            'Our response target is about 60 minutes anywhere in the Edmonton metro area, 24 hours a day. A live specialist answers your call and dispatches a crew immediately — and tells you what to shut off and move while they’re on the way.',
        },
        {
          question: 'Does home insurance cover water damage in Alberta?',
          answer:
            'Usually yes, if the damage is sudden and accidental — a burst pipe, a failed appliance, an overflowing tub. Gradual damage like slow seepage is typically not covered, and sewer backup or overland flooding each need their own endorsement on your policy. We document everything with moisture mapping and photos, and we bill your insurer directly, so a covered claim usually costs you only your deductible.',
        },
        {
          question: 'What should I do while I wait for your crew?',
          answer:
            'Shut off the water at the main valve if the source is inside your home, and turn off power to the affected area only if you can reach the panel safely. Move what you can to higher, dry ground. Don’t use a household vacuum on standing water, and stay out of the water entirely if it might be from a sewer line.',
        },
        {
          question: 'How long does drying take?',
          answer:
            'Most homes dry in two to four days with industrial dehumidifiers and air movers, depending on how long the water sat and what materials got wet. We don’t guess — we take moisture readings daily and only remove equipment when the numbers say your structure is actually dry.',
        },
        {
          question: 'Do you bill my insurance company directly?',
          answer:
            'Yes. We work with your adjuster, supply the documentation the claim needs, and invoice your insurer directly. For a covered loss, your out-of-pocket cost is typically just your deductible.',
        },
      ],
      related: ['sewage-cleanup', 'mold-removal'],
    },
  },
  {
    id: 'fire',
    name: 'Fire Damage Restoration',
    shortName: 'Fire & Smoke',
    tier: 'primary',
    bgWord: 'BURN',
    cardTagline: 'Every trace of the fire, gone.',
    cardDescription:
      'Soot removal, odor neutralization, and structural cleanup—fast, safe, and thorough.',
    features: [
      'Emergency board-up & securing',
      'Soot & residue cleaning',
      'Thermal fogging & deodorization',
    ],
    imageSrc: '/hero-fire.jpg',
    imageAlt: 'Fire damage restoration in Edmonton',
    page: {
      slug: 'fire-smoke-damage',
      h1: 'Fire & Smoke Damage Restoration in Edmonton',
      metaTitle: 'Fire & Smoke Damage Restoration Edmonton | YEG Restoration',
      metaDescription:
        'After the fire truck leaves, call us. 24/7 board-up, soot removal & odour elimination. Free assessment, direct insurance billing. (780) 479-3285.',
      heroTagline: 'The fire is out. Now get your home back.',
      heroCopy:
        'Soot keeps corroding surfaces and smoke keeps sinking into walls long after the flames are out. Our IICRC-certified crew secures your home today, then removes every trace — the damage, the residue, and the smell — while we handle your insurance claim directly. Free assessment, written guarantee.',
      process: [
        {
          step: '01',
          timing: 'Within 60 minutes',
          title: 'Secure the property',
          copy: 'Emergency board-up, roof tarps, and structural checks so nothing gets worse overnight — no weather, no intruders, no further loss for your claim.',
        },
        {
          step: '02',
          timing: 'Days 1–3',
          title: 'Remove soot and smoke',
          copy: 'Soot turns acidic and permanently stains within days. We clean every affected surface, scrub the air with HEPA filtration, and neutralize odour at the source with thermal fogging — not cover it up.',
        },
        {
          step: '03',
          timing: 'Rebuild',
          title: 'Repair and restore',
          copy: 'The same team rebuilds what the fire took, from drywall to finishing. One crew, one point of contact, fully documented for your insurer — with a written guarantee.',
        },
      ],
      faqs: [
        {
          question: 'What should I do first after a house fire in Edmonton?',
          answer:
            'Once the fire department clears the scene, call a restoration company before you re-enter or start cleaning. Don’t wipe soot off walls or run the furnace — wiping grinds acidic residue into surfaces and the HVAC system spreads contamination through the whole house. We board up, document the damage for your insurer, and start controlled cleanup the same day.',
        },
        {
          question: 'Will the smoke smell ever come out of my house?',
          answer:
            'Yes — if it’s treated at the source. Smoke odour lives in particles embedded in drywall, insulation, and ducts, so surface cleaning and air fresheners only mask it. We remove contaminated materials that can’t be saved, clean everything that can, and use thermal fogging that penetrates exactly the way the smoke did. That’s how the smell leaves for good.',
        },
        {
          question: 'Does insurance cover fire and smoke damage?',
          answer:
            'Fire is a core covered peril on virtually every Alberta home policy, including smoke damage and often additional living expenses if you can’t stay in the home. We photograph and inventory everything before touching it, work with your adjuster, and bill your insurer directly — so you can focus on your family, not the paperwork.',
        },
        {
          question: 'Can I stay in my home during fire restoration?',
          answer:
            'It depends on the extent of the damage. Small, contained fires often allow you to stay while we work; significant smoke contamination or structural damage usually means a temporary move — which your policy’s additional living expense coverage typically pays for. We give you a straight answer at the free assessment, not a sales pitch.',
        },
        {
          question: 'How long does fire damage restoration take?',
          answer:
            'Cleanup and deodorization typically take days; rebuilding takes weeks, depending on how far the fire and smoke reached. You get a written scope with timelines before work starts, and one crew carries the job from board-up to final walkthrough.',
        },
      ],
      related: ['water-damage-restoration', 'mold-removal'],
    },
  },
  {
    id: 'mold',
    name: 'Mold Removal',
    shortName: 'Mold Removal',
    tier: 'primary',
    bgWord: 'MOLD',
    cardTagline: 'Safely removed. Not just masked.',
    cardDescription:
      'Containment, removal, and prevention—built around safety and air quality.',
    features: [
      'Containment & negative air setup',
      'HEPA filtration & removal',
      'Prevention plan & moisture control',
    ],
    imageSrc: '/hero-mold.jpg',
    imageAlt: 'Mold remediation in Edmonton',
    page: {
      slug: 'mold-removal',
      h1: 'Mold Removal in Edmonton',
      metaTitle: 'Mold Removal & Remediation Edmonton | YEG Restoration',
      metaDescription:
        'Certified mold removal in Edmonton — containment, HEPA filtration, and the moisture fix that stops it coming back. Free assessment: (780) 479-3285.',
      heroTagline: 'Removed at the root — not painted over',
      heroCopy:
        'Mold you can see is usually a fraction of what’s growing behind the wall. Our IICRC-certified crew contains it, removes it safely, and fixes the moisture problem that caused it — so it doesn’t come back. Free assessment, written guarantee.',
      process: [
        {
          step: '01',
          timing: 'Free assessment',
          title: 'Find all of it',
          copy: 'Moisture meters and inspection find the full extent — including growth inside walls and under floors that surface cleaning misses. You get a written scope before any work starts.',
        },
        {
          step: '02',
          timing: 'Days 1–3',
          title: 'Contain and remove',
          copy: 'Negative air pressure and sealed containment keep spores out of the rest of your home while we remove contaminated materials and scrub the air with HEPA filtration.',
        },
        {
          step: '03',
          timing: 'Prevention',
          title: 'Fix the moisture source',
          copy: 'Mold is a moisture problem wearing a disguise. We correct the leak, condensation, or drainage issue that fed it, and back the work with a written guarantee.',
        },
      ],
      faqs: [
        {
          question: 'Is mold in my house dangerous to my family?',
          answer:
            'It can be — mold exposure commonly triggers allergy symptoms, congestion, and breathing irritation, and it’s a bigger risk for children, seniors, asthmatics, and anyone immunocompromised. Health Canada recommends removing any indoor mold growth regardless of the type. If you can see or smell mold, it’s worth a free assessment to find out how far it actually goes.',
        },
        {
          question: 'Can I remove mold myself?',
          answer:
            'A patch smaller than a square metre on a hard, non-porous surface — like bathroom tile — is usually a safe DIY job with detergent and gloves. Anything larger, anything on drywall or wood, or anything you can smell but not see needs professional containment. Scrubbing a large colony without negative air pressure blasts spores through your whole house and turns one problem room into five.',
        },
        {
          question: 'How much does mold removal cost in Edmonton?',
          answer:
            'It depends on how far the growth extends and what has to be removed — which is exactly why we start with a free assessment and a written scope, so you know the cost before any work begins. If the mold was caused by a sudden covered water loss, your insurance may cover remediation, and we bill the insurer directly.',
        },
        {
          question: 'Will the mold come back after removal?',
          answer:
            'Not if the moisture source is fixed — and that’s the part most cleanups skip. Mold cannot grow on dry material, so we don’t just remove the growth: we correct the leak, condensation, or drainage problem behind it and confirm dryness with meter readings. Our written guarantee covers the work.',
        },
        {
          question: 'Does insurance cover mold removal in Alberta?',
          answer:
            'Usually only when the mold resulted from a sudden, covered water event — like a burst pipe you dealt with promptly. Mold from long-term humidity, slow leaks, or deferred maintenance is typically excluded. We document the cause during assessment and tell you honestly whether a claim is worth filing before you pay a deductible.',
        },
      ],
      related: ['water-damage-restoration', 'sewage-cleanup'],
    },
  },
  {
    id: 'storm',
    name: 'Storm Damage Repair',
    shortName: 'Storm Damage',
    tier: 'primary',
    bgWord: 'STORM',
    cardTagline: 'Emergency response, same day.',
    cardDescription:
      'Roof tarps, debris removal, and structural stabilization when the weather strikes.',
    features: [
      'Emergency roof tarps & patching',
      'Debris removal & tree impact',
      'Structural stabilization',
    ],
    imageSrc: '/hero-storm.jpg',
    imageAlt: 'Storm damage repair in Edmonton',
    // No landing page (by decision) — homepage section only; CTAs go to contact.
  },
  {
    id: 'sewage',
    name: 'Sewage Cleanup',
    shortName: 'Sewage Cleanup',
    tier: 'additional',
    bgWord: 'SEWAGE',
    cardTagline: 'A health hazard, not a mess.',
    cardDescription:
      'Sewage backup is Category 3 water — certified extraction, disinfection, and safe disposal, fast.',
    features: [
      'Category 3 water extraction',
      'Hospital-grade disinfection',
      'Safe removal of contaminated materials',
    ],
    imageSrc: '/hero-water.jpg', // TODO: replace with real sewage-job photo when available
    imageAlt: 'Sewage backup cleanup in Edmonton',
    page: {
      slug: 'sewage-cleanup',
      h1: 'Sewage Cleanup in Edmonton',
      metaTitle: 'Sewage Backup Cleanup Edmonton | 24/7 | YEG Restoration',
      metaDescription:
        'Sewage backup? It’s Category 3 water — keep your family away. Certified 24/7 cleanup, free assessment, direct insurance billing. (780) 479-3285.',
      heroTagline: 'Don’t touch it. Call us.',
      heroCopy:
        'Sewage backup is Category 3 “black water” — it carries bacteria and viruses that make it a health hazard, not a cleanup chore. Our certified crew extracts it, disinfects everything it touched, and disposes of what can’t be saved. On-site in about 60 minutes, and we bill your insurance directly.',
      process: [
        {
          step: '01',
          timing: 'Within 60 minutes',
          title: 'Contain the hazard',
          copy: 'We seal off the affected area, stop the backflow where possible, and keep contamination from spreading to the rest of your home.',
        },
        {
          step: '02',
          timing: 'Same day',
          title: 'Extract and disinfect',
          copy: 'Full extraction, removal of contaminated porous materials, and hospital-grade disinfection of every surface the water touched — documented for your insurance claim.',
        },
        {
          step: '03',
          timing: 'Verify & restore',
          title: 'Dry, test, rebuild',
          copy: 'Industrial drying, verification that the space is safe again, and repair of what was removed. Written guarantee on the work.',
        },
      ],
      faqs: [
        {
          question: 'Is sewage backup dangerous?',
          answer:
            'Yes. Sewage is Category 3 water — it carries bacteria, viruses, and parasites that cause serious illness on contact. Keep children and pets away from the area, don’t run fans that spread contaminated droplets, and never use a household vacuum on it. This is one cleanup that genuinely isn’t safe to do yourself.',
        },
        {
          question: 'Is sewage backup covered by insurance in Alberta?',
          answer:
            'Only if your policy includes a sewer backup endorsement — it’s a common add-on in Alberta, not part of standard coverage, so check your policy or call your broker. If you have the endorsement, we document the loss, work with your adjuster, and bill your insurer directly, so a covered claim usually costs you just your deductible.',
        },
        {
          question: 'What causes sewer backup in Edmonton?',
          answer:
            'The usual culprits are spring snowmelt and heavy summer rain overwhelming the lines, tree roots growing into older sewer laterals, and grease or debris blockages. Homes in older Edmonton neighbourhoods with original clay lines are at higher risk. A backwater valve is the best prevention — many insurers offer discounts for installing one.',
        },
        {
          question: 'Can I clean up a small sewage spill myself?',
          answer:
            'We don’t recommend it. Even a small backup contaminates porous materials — carpet, drywall, insulation — that look fine after wiping but hold bacteria inside. Proper cleanup means removing those materials and disinfecting with the right agents and protective equipment. Our assessment is free, so it costs nothing to find out what the spill actually touched.',
        },
        {
          question: 'How fast can you get here?',
          answer:
            'Our response target is about 60 minutes in the Edmonton metro area, any hour of the day. A live specialist answers your call, tells you how to keep your family safe until we arrive, and dispatches the crew immediately.',
        },
      ],
      related: ['water-damage-restoration', 'mold-removal'],
    },
  },
  {
    id: 'construction',
    name: 'Construction Services',
    shortName: 'Construction',
    tier: 'additional',
    bgWord: 'BUILD',
    cardTagline: 'One team, start to finish.',
    cardDescription:
      'Full rebuild and repair after damage. From structural work to finishing — one team, start to finish.',
    features: [],
    imageSrc: '',
    imageAlt: '',
  },
  {
    id: 'contents',
    name: 'Contents Restoration',
    shortName: 'Contents',
    tier: 'additional',
    bgWord: 'SAVE',
    cardTagline: 'The things that matter, saved.',
    cardDescription:
      'Salvaging and restoring furniture, documents, electronics, and belongings that matter to you.',
    features: [],
    imageSrc: '',
    imageAlt: '',
  },
  {
    id: 'biohazard',
    name: 'Biohazard Cleaning',
    shortName: 'Biohazard',
    tier: 'additional',
    bgWord: 'CLEAN',
    cardTagline: 'Safe, discreet, thorough.',
    cardDescription:
      'Safe, discreet decontamination and disposal for trauma and hazardous material events.',
    features: [],
    imageSrc: '',
    imageAlt: '',
  },
  {
    id: 'asbestos',
    name: 'Asbestos Abatement',
    shortName: 'Asbestos',
    tier: 'additional',
    bgWord: 'ABATE',
    cardTagline: 'Certified removal, done right.',
    cardDescription:
      'Certified identification, containment, and full removal of asbestos-containing materials.',
    features: [],
    imageSrc: '',
    imageAlt: '',
  },
];

export const primaryServices = services.filter((s) => s.tier === 'primary');
export const additionalServices = services.filter((s) => s.tier === 'additional');
export const pagedServices = services.filter(
  (s): s is Service & { page: ServicePageContent } => Boolean(s.page),
);

export const getServiceBySlug = (slug: string) =>
  pagedServices.find((s) => s.page.slug === slug);

/** Where a service's card/link should point: its page if it has one, else contact. */
export const servicePath = (s: Service) => (s.page ? `/${s.page.slug}/` : '/contact/');
