import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import { BUSINESS, services, pagedServices } from '../data/services';

/**
 * /llms.txt — machine-readable site guide per https://llmstxt.org.
 * Built from the same data that powers the pages so it can't drift.
 * Read by AI agents/assistants; robots.txt points here.
 */
export async function GET(context: APIContext) {
  const site = context.site!.href.replace(/\/$/, '');
  const posts = (await getCollection('blog', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime()
  );

  const serviceLines = pagedServices.map(
    (s) => `- [${s.name}](${site}/${s.page!.slug}/): ${s.page!.metaDescription}`
  );
  const otherServices = services
    .filter((s) => !s.page)
    .map((s) => `- ${s.name}: ${s.cardDescription} (request via ${site}/contact/)`);

  const postLines = posts.map(
    (p) => `- [${p.data.title}](${site}/blog/${p.id}/): ${p.data.description}`
  );

  const body = `# ${BUSINESS.name}

> ${BUSINESS.description}

Key facts:

- 24/7 emergency response, on-site in Edmonton in about 60 minutes
- Serving Edmonton and surrounding Alberta communities (St. Albert, Sherwood Park, Spruce Grove, Leduc, Fort Saskatchewan, and more) since ${BUSINESS.foundingYear}
- IICRC-certified crews, free assessments, written guarantee
- Direct insurance billing — we work with all major Canadian insurers
- Phone: ${BUSINESS.phone} · Email: ${BUSINESS.email}

## Services

${serviceLines.join('\n')}

Additional services (no dedicated page yet):

${otherServices.join('\n')}

## Key Pages

- [Insurance Claims Guide](${site}/insurance-claims/): How the insurance claim process works with restoration, and how direct billing removes the paperwork burden.
- [About](${site}/about/): Who we are, certifications, and how we work.
- [Contact](${site}/contact/): Request a free assessment or emergency dispatch.

## Blog

${postLines.join('\n')}

- [RSS feed](${site}/rss.xml)

## Contact

- Emergency line (24/7): ${BUSINESS.phone} (${BUSINESS.phoneE164})
- Email: ${BUSINESS.email}
- Location: ${BUSINESS.city}, ${BUSINESS.region}, Canada
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
