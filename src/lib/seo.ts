export const localBusinessSchema = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'EmergencyService',
      name: 'YEG Restoration',
      url: 'https://yegrestoration.ca',
      telephone: '+1-780-000-0000', // PLACEHOLDER — replace before launch
      email: 'help@yegrestoration.ca',
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
        { '@type': 'City', name: 'Sherwood Park' },
        { '@type': 'City', name: 'St. Albert' },
        { '@type': 'City', name: 'Leduc' },
        { '@type': 'City', name: 'Spruce Grove' },
        { '@type': 'City', name: 'Fort Saskatchewan' },
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
        // PLACEHOLDER — add Google Business Profile URL, Facebook, etc.
      ],
    },
    {
      '@type': 'WebSite',
      url: 'https://yegrestoration.ca',
      name: 'YEG Restoration',
    },
  ],
};
