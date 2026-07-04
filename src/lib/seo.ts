import { BUSINESS } from '../data/services';
import type { Service, ServicePageContent, ServiceFaq } from '../data/services';

export interface BlogArticleSchemaProps {
  title: string;
  description: string;
  publishDate: Date;
  updatedDate?: Date;
  slug: string;
  heroImage?: string;
}

export function blogArticleSchema({
  title,
  description,
  publishDate,
  updatedDate,
  slug,
  heroImage,
}: BlogArticleSchemaProps) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    description,
    datePublished: publishDate.toISOString(),
    dateModified: (updatedDate ?? publishDate).toISOString(),
    image: heroImage ?? 'https://yegrestoration.ca/og-cover.jpg',
    url: `https://yegrestoration.ca/blog/${slug}/`,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `https://yegrestoration.ca/blog/${slug}/`,
    },
    author: {
      '@type': 'Organization',
      name: 'YEG Restoration',
      url: 'https://yegrestoration.ca',
    },
    publisher: {
      '@type': 'Organization',
      name: 'YEG Restoration',
      logo: {
        '@type': 'ImageObject',
        url: 'https://yegrestoration.ca/images/YEG_Restoration_Logo_RBG.png',
      },
    },
  };
}

export const BUSINESS_ID = 'https://yegrestoration.ca/#business';

export const localBusinessSchema = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'EmergencyService',
      '@id': BUSINESS_ID,
      name: BUSINESS.name,
      url: BUSINESS.url,
      telephone: BUSINESS.phoneE164,
      email: BUSINESS.email,
      description: BUSINESS.description,
      image: 'https://yegrestoration.ca/og-cover.jpg',
      logo: 'https://yegrestoration.ca/images/YEG_Restoration_Logo_RBG.png',
      foundingDate: '2008',
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Edmonton',
        addressRegion: 'AB',
        postalCode: 'T5J 0N3', // PLACEHOLDER — LAUNCH BLOCKER: replace with real postal code before launch
        addressCountry: 'CA',
      },
      geo: {
        '@type': 'GeoCoordinates',
        latitude: 53.5461,
        longitude: -113.4938,
      },
      openingHoursSpecification: {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        opens: '00:00',
        closes: '23:59',
      },
      areaServed: [
        { '@type': 'City', name: 'Edmonton' },
        { '@type': 'City', name: 'St. Albert' },
        { '@type': 'City', name: 'Sherwood Park' },
        { '@type': 'City', name: 'Spruce Grove' },
        { '@type': 'City', name: 'Stony Plain' },
        { '@type': 'City', name: 'Leduc' },
        { '@type': 'City', name: 'Beaumont' },
        { '@type': 'City', name: 'Fort Saskatchewan' },
        { '@type': 'City', name: 'Devon' },
        { '@type': 'City', name: 'Morinville' },
        { '@type': 'City', name: 'Bon Accord' },
        { '@type': 'City', name: 'Gibbons' },
        { '@type': 'City', name: 'Legal' },
        { '@type': 'City', name: 'Redwater' },
        { '@type': 'City', name: 'Lamont' },
        { '@type': 'City', name: 'Tofield' },
        { '@type': 'City', name: 'Vegreville' },
        { '@type': 'City', name: 'Camrose' },
        { '@type': 'City', name: 'Wetaskiwin' },
        { '@type': 'City', name: 'Ponoka' },
        { '@type': 'City', name: 'Lacombe' },
        { '@type': 'City', name: 'Red Deer' },
        { '@type': 'City', name: 'Barrhead' },
        { '@type': 'City', name: 'Westlock' },
        { '@type': 'City', name: 'Athabasca' },
        { '@type': 'City', name: 'Smoky Lake' },
        { '@type': 'City', name: 'Mundare' },
        { '@type': 'City', name: 'Viking' },
        { '@type': 'City', name: 'Vermilion' },
        { '@type': 'City', name: 'Whitecourt' },
        { '@type': 'City', name: 'Drayton Valley' },
        { '@type': 'City', name: 'Rocky Mountain House' },
      ],
      hasOfferCatalog: {
        '@type': 'OfferCatalog',
        name: 'Restoration Services',
        itemListElement: [
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Water Damage Restoration' } },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Fire & Smoke Damage Restoration' } },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Mold Remediation' } },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Storm Damage Repair' } },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Construction Services' } },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Contents Restoration' } },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Biohazard Cleaning' } },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Asbestos Abatement' } },
        ],
      },
      // NOTE: no aggregateRating until real Google reviews exist — fabricated
      // review markup risks a manual action. Re-add with real values later.
      // TODO — LAUNCH BLOCKER: add sameAs (Facebook/Instagram/GBP) when real profile URLs are provided.
      // Cross-web entity consistency (same NAP + description on GBP/socials) is a
      // primary trust signal for both Google and AI answer engines.
    },
    {
      '@type': 'WebSite',
      url: 'https://yegrestoration.ca',
      name: 'YEG Restoration',
    },
  ],
};

/** Service schema for a service landing page. `provider` references the
 *  EmergencyService node injected by Layout on every page. */
export function serviceSchema(s: Service & { page: ServicePageContent }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: s.name,
    serviceType: s.name,
    description: s.page.metaDescription,
    url: `${BUSINESS.url}/${s.page.slug}/`,
    provider: { '@id': BUSINESS_ID },
    areaServed: { '@type': 'City', name: 'Edmonton' },
  };
}

export function faqPageSchema(faqs: ServiceFaq[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  };
}

export interface BlogIndexPost {
  title: string;
  slug: string;
}

/** Blog schema for the blog index page — lists posts so crawlers and AI
 *  engines see the full article inventory from one node. */
export function blogIndexSchema(posts: BlogIndexPost[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    url: `${BUSINESS.url}/blog/`,
    name: 'Restoration Insights — YEG Restoration Blog',
    publisher: { '@id': BUSINESS_ID },
    blogPost: posts.map((p) => ({
      '@type': 'BlogPosting',
      headline: p.title,
      url: `${BUSINESS.url}/blog/${p.slug}/`,
    })),
  };
}

export interface BreadcrumbItem {
  name: string;
  /** Absolute URL. Omit on the final (current-page) item. */
  url?: string;
}

export function breadcrumbSchema(items: BreadcrumbItem[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      ...(item.url ? { item: item.url } : {}),
    })),
  };
}
