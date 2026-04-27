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

export const localBusinessSchema = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'EmergencyService',
      name: 'YEG Restoration',
      url: 'https://yegrestoration.ca',
      telephone: '+1-780-479-3285',
      email: 'info@yegrestoration.ca',
      description:
        "Edmonton's 24/7 emergency restoration team. Water damage, fire & smoke, mold removal, storm repair. IICRC certified.",
      image: 'https://yegrestoration.ca/og-cover.jpg',
      logo: 'https://yegrestoration.ca/images/YEG_Restoration_Logo_RBG.png',
      foundingDate: '2008',
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Edmonton',
        addressRegion: 'AB',
        postalCode: 'T5J 0N3', // PLACEHOLDER
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
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: '4.9',
        reviewCount: '287', // PLACEHOLDER — update with real Google review count before launch
        bestRating: '5',
      },
      sameAs: [
        'https://www.facebook.com/yegrestoration', // PLACEHOLDER — update with real URL
        'https://www.instagram.com/yegrestoration', // PLACEHOLDER — update with real URL
        'https://maps.app.goo.gl/yegrestoration', // PLACEHOLDER — update with real Google Business Profile URL
      ],
    },
    {
      '@type': 'WebSite',
      url: 'https://yegrestoration.ca',
      name: 'YEG Restoration',
    },
  ],
};
