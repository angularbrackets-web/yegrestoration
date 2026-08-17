// Checks the appointment upload token (BK-34a) — the 72-hour write capability
// an SMS hands to a customer.
//
//   npm run verify:appointment:upload
//
// Needs BOOKING_DRAFT_SECRET and nothing else. No database, no network, no
// Blob credentials: the token functions are pure over the secret.
//
// THE npm SCRIPT BUILDS FIRST, and that is not incidental. The last block reads
// the generated `.vercel/output/config.json` and simulates the deployed route
// table against a real upload link, because the one defect in this feature that
// reached review unnoticed was invisible to every check that does not — see
// that block, and the Known trap in `/CLAUDE.md`.
//
// WHY THE CROSS-TYPE CHECKS ARE THE POINT OF THIS FILE. There are now two token
// types over one HMAC secret, which is where a confused-deputy bug lives: a
// token minted for a 6-hour form session replayed as a 72-hour write capability
// against somebody's appointment, or the reverse. `draft-token.ts` separates
// them three ways — version tag, arity, and the shape of the signed payload —
// and any ONE of those would be sufficient today. That is exactly why they are
// asserted individually rather than through a single "the wrong token is
// rejected" case: a refactor that collapses two of the three would keep this
// file green if it only tested the outcome, and would leave the remaining check
// as the sole thing standing between the two capabilities.

import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `dotenv` is not a dependency of this repo — the other verify scripts hand-roll
// this, and copying them keeps the harness on one mechanism rather than adding a
// package for four lines.
function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const [, key, raw] = m;
    let val = raw.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && val && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv(resolve(root, '.env.local'));
loadEnv(resolve(root, '.env'));

import {
  APPOINTMENT_UPLOAD_TOKEN_PARAM,
  APPOINTMENT_UPLOAD_TTL_HOURS,
  DRAFT_TOKEN_TTL_HOURS,
  appointmentUploadUrl,
} from '../src/lib/booking-config';
import {
  issueAppointmentUploadToken,
  issueDraftToken,
  verifyAppointmentUploadToken,
  verifyDraftToken,
} from '../src/lib/draft-token';

if (!process.env.BOOKING_DRAFT_SECRET) {
  console.error('\n✗ BOOKING_DRAFT_SECRET is not set — cannot sign or verify tokens.\n');
  process.exit(1);
}

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

const NOW = new Date('2026-08-16T18:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const APPOINTMENT_ID = 4271;

// ---------------------------------------------------------------------------
console.log('\nRound trip');

const minted = await issueAppointmentUploadToken(APPOINTMENT_ID, NOW);
const claims = await verifyAppointmentUploadToken(minted.token, NOW);

check(claims !== null, 'a freshly minted token verifies');
check(claims?.appointmentId === APPOINTMENT_ID, 'the appointment id survives the round trip');
check(claims?.draftId === minted.draftId, 'the draft id survives the round trip');

// The id must come out of the SIGNATURE. A route that read it from the URL
// beside the token would be trusting the unsigned half of the request, so the
// claim is that the verifier is the only source of it.
check(
  typeof claims?.appointmentId === 'number' && Number.isInteger(claims.appointmentId),
  'the verified appointment id is an integer, not a string off the wire',
);

// A fresh draft id per mint is what makes an old link unable to overwrite a
// file uploaded through a newer one.
const second = await issueAppointmentUploadToken(APPOINTMENT_ID, NOW);
check(second.draftId !== minted.draftId, 'each mint gets its own draft id');

// ---------------------------------------------------------------------------
console.log('\nCross-type rejection — the confused-deputy guard');

const draft = await issueDraftToken(NOW);

check(
  (await verifyAppointmentUploadToken(draft.token, NOW)) === null,
  'a DRAFT token is rejected by the appointment verifier',
);
check(
  (await verifyDraftToken(minted.token, NOW)) === null,
  'an APPOINTMENT token is rejected by the draft verifier',
);

// Barrier 1: the version tag, on its own. Same arity, same payload shape,
// only the tag swapped — so this goes red if the tag check is dropped even
// while arity and payload still differ.
const [, ...appointmentRest] = minted.token.split('.');
check(
  (await verifyAppointmentUploadToken(['v1', ...appointmentRest].join('.'), NOW)) === null,
  'barrier 1: an appointment token wearing the draft version tag is rejected',
);

// Barrier 2: arity, on its own.
//
// THE OBVIOUS SPELLING OF THIS CHECK DOES NOT TEST ARITY, and red-first is what
// showed it. Handing the draft verifier a re-tagged five-part appointment token
// looks like an arity case, but it is caught further down — by the version tag,
// or by `Number('<uuid>')` being NaN — so loosening `parts.length !== 4` to
// `< 4` left it green.
//
// A VALID draft token with data appended is the case that isolates arity: every
// downstream check passes, the signature covers the untouched first four parts,
// and only the length test stands between the verifier and accepting a token
// with arbitrary trailing content.
check(
  (await verifyDraftToken(`${draft.token}.extra`, NOW)) === null,
  'barrier 2: a VALID draft token with data appended is rejected on arity',
);
// The SAME trap on the appointment verifier, and it was live until
// implementation review: this assertion used to read
// `a1.<uuid>.<ms>.<sig>` — a four-part token wearing the appointment tag —
// and called itself an arity case. It is not one. `parts[1]` there is a UUID,
// so with `parts.length !== 5` disabled it is still rejected by the id regex,
// and loosening the arity check left the line green. Mirroring the draft case
// above is what actually isolates it: a VALID appointment token with data
// appended destructures to the same first five parts, so every downstream
// check passes and the signature verifies against the untouched payload.
check(
  (await verifyAppointmentUploadToken(`${minted.token}.extra`, NOW)) === null,
  'barrier 2: a VALID appointment token with data appended is rejected on arity',
);

// Barrier 3: the signed payload shape. Both barriers above satisfied, and the
// signature still does not verify, because the HMAC covers
// `<appointmentId>.<draftId>.<issuedAt>` and not `<draftId>.<issuedAt>`.
const [, dId, dIssued, dSig] = draft.token.split('.');
check(
  (await verifyAppointmentUploadToken(`a1.1.${dId}.${dIssued}.${dSig}`, NOW)) === null,
  'barrier 3: a draft signature re-shaped as an appointment token does not verify',
);

// ---------------------------------------------------------------------------
console.log('\nProvenance is inside the signature (BK-40)');
// ---------------------------------------------------------------------------
//
// `appointment_files.source` is written from `claims.origin` and from nothing
// else, so every one of these is the question "can a customer's upload be
// recorded as the office's, or the reverse". Provenance the caller can choose
// is worse than none, because the office would believe it.
{
  const office = await issueAppointmentUploadToken(APPOINTMENT_ID, NOW, 'office');

  const linkClaims = await verifyAppointmentUploadToken(minted.token, NOW);
  const officeClaims = await verifyAppointmentUploadToken(office.token, NOW);

  check(linkClaims?.origin === 'link', 'the texted link token claims origin "link"');
  check(officeClaims?.origin === 'office', "the office's own token claims origin \"office\"");
  check(
    officeClaims?.appointmentId === APPOINTMENT_ID,
    'and it still names the appointment it was minted for',
  );
  check(office.origin === 'office', 'the mint reports the origin it signed');
  check(
    office.draftId !== minted.draftId,
    'the two tokens carry different prefixes, so neither can overwrite the other',
  );

  // THE ATTACK THIS EXISTS FOR. The version tag is NOT part of the signed
  // payload — the HMAC is taken before it is prepended — so if `a1` and `a2`
  // shared a payload shape, rewriting one leading byte of a customer's link
  // would relabel their photos as the office's and still verify.
  const [, ...linkRest] = minted.token.split('.');
  check(
    (await verifyAppointmentUploadToken(['a2', ...linkRest].join('.'), NOW)) === null,
    'a LINK token re-tagged a2 is rejected — the origin cannot be flipped by editing the tag',
  );
  const [, ...officeRest] = office.token.split('.');
  check(
    (await verifyAppointmentUploadToken(['a1', ...officeRest].join('.'), NOW)) === null,
    'an OFFICE token re-tagged a1 is rejected',
  );

  // The same attack carried out properly: build a well-formed 6-part `a2`
  // token out of the link token's parts by inserting the origin segment. Every
  // shape check now passes, and only the signed payload differing
  // (`<id>.<draft>.<issued>` vs `<id>.<draft>.<issued>.office`) stands between
  // this and a forged claim of office provenance.
  const [, lid, ldraft, lissued, lsig] = minted.token.split('.');
  check(
    (await verifyAppointmentUploadToken(`a2.${lid}.${ldraft}.${lissued}.office.${lsig}`, NOW)) ===
      null,
    "a link signature re-shaped as an office token does not verify — the origin is signed",
  );
  // And the reverse: strip the origin segment off an office token and re-tag it.
  const [, oid, odraft, oissued, , osig] = office.token.split('.');
  check(
    (await verifyAppointmentUploadToken(`a1.${oid}.${odraft}.${oissued}.${osig}`, NOW)) === null,
    'an office signature re-shaped as a link token does not verify either',
  );

  // The origin segment itself is not free text. An unrecognised value must be
  // refused outright rather than defaulted to one of the two — a default is how
  // a future third origin gets silently recorded as an existing one.
  for (const bogus of ['link', 'admin', '', 'OFFICE', 'office ']) {
    check(
      (await verifyAppointmentUploadToken(
        `a2.${oid}.${odraft}.${oissued}.${bogus}.${osig}`,
        NOW,
      )) === null,
      `an office token carrying origin ${JSON.stringify(bogus)} is rejected`,
    );
  }

  // Arity for the two-shape verifier, and THIS IS THE THIRD TIME THE OBVIOUS
  // SPELLING OF THIS CHECK HAS BEEN WRONG IN THIS FILE. `${office.token}.extra`
  // is seven parts, which is not six, so the arity/version agreement rejects it
  // — and widening `length !== 5 && length !== 6` to `length < 5` left that
  // assertion GREEN. It was testing the version tag while claiming to test
  // arity.
  //
  // What isolates it: `sigHex` is read from the LAST part, so a token that
  // keeps the real signature in final position and pads the MIDDLE has every
  // downstream check pass. Seven parts keeps `isOffice` false, so the `a1` tag
  // is correct; the first four parts destructure to the real values; the
  // signature verifies against the untouched payload. Only the length test
  // stands between the verifier and a token with arbitrary interior content.
  check(
    (await verifyAppointmentUploadToken(
      `a1.${lid}.${ldraft}.${lissued}.junk.junk2.${lsig}`,
      NOW,
    )) === null,
    'a token padded in the MIDDLE with its real signature last is rejected on arity',
  );
  // Kept as well, because it is a real string somebody might send — but labelled
  // for what it actually exercises rather than for what it looks like.
  check(
    (await verifyAppointmentUploadToken(`${office.token}.extra`, NOW)) === null,
    'and a valid office token with data appended is rejected (by arity/version agreement)',
  );

  // The office token is still an appointment token, so it must not be a draft.
  check(
    (await verifyDraftToken(office.token, NOW)) === null,
    'an office token is rejected by the draft verifier',
  );

  // `origin` defaults to the customer's link, which is what keeps every BK-34a
  // call site — and every link already sitting in a customer's messages —
  // working unchanged.
  check(
    (await issueAppointmentUploadToken(APPOINTMENT_ID, NOW)).token.startsWith('a1.'),
    'the default mint is still a link token',
  );
}

// ---------------------------------------------------------------------------
console.log('\nTampering');

const [ver, idPart, draftPart, issuedPart, sigPart] = minted.token.split('.');

check(
  (await verifyAppointmentUploadToken(
    [ver, String(APPOINTMENT_ID + 1), draftPart, issuedPart, sigPart].join('.'),
    NOW,
  )) === null,
  'a swapped appointment id fails the signature — this is the whole capability',
);
check(
  (await verifyAppointmentUploadToken(
    [ver, idPart, '00000000-0000-4000-8000-000000000000', issuedPart, sigPart].join('.'),
    NOW,
  )) === null,
  'a swapped draft id fails the signature',
);
check(
  (await verifyAppointmentUploadToken(
    [ver, idPart, draftPart, String(Number(issuedPart) + 1), sigPart].join('.'),
    NOW,
  )) === null,
  'a nudged issued-at fails the signature',
);

// Leading zeros: `/admin/appointments/0000000012/` is rejected as a second URL
// for one row, and the token must not become the way around that.
check(
  (await verifyAppointmentUploadToken(
    [ver, `0${idPart}`, draftPart, issuedPart, sigPart].join('.'),
    NOW,
  )) === null,
  'a leading-zero appointment id is rejected before it reaches the signature',
);

// `${minted.token}.extra` is NOT in this list — it is the barrier-2 assertion
// above, where its label says what it isolates. Here it would read as one more
// malformed string and the arity claim would be invisible again.
for (const bad of [null, undefined, 42, '', 'a1', 'a1.1.2.3']) {
  check(
    (await verifyAppointmentUploadToken(bad as unknown, NOW)) === null,
    `a malformed token is rejected: ${JSON.stringify(bad)}`,
  );
}

// ---------------------------------------------------------------------------
console.log('\nExpiry');

const justInside = new Date(NOW.getTime() + APPOINTMENT_UPLOAD_TTL_HOURS * HOUR - 1000);
const justOutside = new Date(NOW.getTime() + APPOINTMENT_UPLOAD_TTL_HOURS * HOUR + 1000);

check(
  (await verifyAppointmentUploadToken(minted.token, justInside)) !== null,
  `a token one second inside ${APPOINTMENT_UPLOAD_TTL_HOURS}h still verifies`,
);
check(
  (await verifyAppointmentUploadToken(minted.token, justOutside)) === null,
  `a token one second past ${APPOINTMENT_UPLOAD_TTL_HOURS}h is rejected`,
);

// A clock that has gone backwards is rejected rather than treated as fresh —
// the same posture `verifyDraftToken` takes with its `ageMs < 0`.
check(
  (await verifyAppointmentUploadToken(minted.token, new Date(NOW.getTime() - 1000))) === null,
  'a token issued in the future is rejected',
);

// The two TTLs are different on purpose (6h vs 72h), and that difference is
// what justifies the rate limit on the appointment route that the draft route
// does not have. If someone equalises them, the comment explaining the rate
// limit stops being true.
check(
  APPOINTMENT_UPLOAD_TTL_HOURS > DRAFT_TOKEN_TTL_HOURS,
  'the appointment TTL is longer than the draft TTL — the premise of its rate limit',
);

// BK-37: `expiresAt` is a DEADLINE THE OFFICE READS OUT TO A CUSTOMER, so it
// has to be the same instant the verifier enforces — not merely close to it.
// Pinned against `verifyAppointmentUploadToken` itself rather than against a
// recomputation of the constant, because a recomputation is the second copy
// this assertion exists to forbid: it would agree with a drifted `expiresAt`
// for exactly the same reason the drifted value was wrong.
check(
  (await verifyAppointmentUploadToken(
    minted.token,
    new Date(minted.expiresAt.getTime() - 1000),
  )) !== null,
  'the stated expiry has not yet passed one second before it',
);
check(
  (await verifyAppointmentUploadToken(
    minted.token,
    new Date(minted.expiresAt.getTime() + 1000),
  )) === null,
  'the stated expiry has passed one second after it — the office is quoting the real deadline',
);

// ---------------------------------------------------------------------------
console.log('\nMinting guards');

for (const bad of [0, -1, 1.5, Number.NaN]) {
  let threw = false;
  try {
    await issueAppointmentUploadToken(bad, NOW);
  } catch {
    threw = true;
  }
  check(threw, `minting refuses a non-positive-integer id: ${bad}`);
}

// ---------------------------------------------------------------------------
console.log('\nThe deployed route table — the check that would have caught BK-34a B1');
// ---------------------------------------------------------------------------
//
// A LINK THAT DOES NOT RESOLVE ON VERCEL IS A BROKEN FEATURE NO MATTER HOW WELL
// THE TOKEN VERIFIES. The first cut of this page took the token as a path
// segment, and `trailingSlash: 'always'` makes the adapter emit a
// PRE-FILESYSTEM route that strips the trailing slash from any path whose last
// segment contains a dot. Every token ends in `.<64 hex>`, so every link 308'd
// to a form no route matched and fell through to `/404.html` — 100% of them.
//
// `astro dev` has no route table, so typecheck, build, this suite and a live
// dev-server smoke test were ALL green across it. It was found by simulating
// the generated table, which is what this block now does on every run.
{
  const configPath = resolve(root, '.vercel/output/config.json');
  if (!existsSync(configPath)) {
    console.error(`  ✗ ${configPath} is missing — run \`npm run build\` before this suite`);
    failures++;
  } else {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      routes: { src?: string; status?: number; headers?: { Location?: string }; handle?: string; dest?: string }[];
    };

    // The real link, built by the real helper — not a hand-written string that
    // could drift from what the office actually copies.
    const link = new URL(appointmentUploadUrl(minted.token), 'https://yegrestoration.ca');
    let path = link.pathname;

    // Phase 1: pre-filesystem routes, following redirects the way Vercel does.
    const hops: string[] = [];
    for (const route of config.routes) {
      if (route.handle) break;
      if (!route.src) continue;
      const re = new RegExp(route.src);
      if (!re.test(path)) continue;
      if (route.status && route.headers?.Location) {
        path = path.replace(re, route.headers.Location);
        hops.push(`${route.status} → ${path}`);
      }
    }

    check(
      hops.length === 0,
      `the upload link survives the pre-filesystem phase without a redirect${
        hops.length ? ` (got ${hops.join(', ')})` : ''
      }`,
    );

    // Phase 2: does anything actually serve it?
    const served = config.routes.find((r) => !r.handle && r.src && r.dest && new RegExp(r.src).test(path));
    check(
      served?.dest === '_render',
      `the upload link reaches the SSR function, not the 404 (matched ${JSON.stringify(
        served?.dest ?? null,
      )})`,
    );

    // The specific rule that broke it, named so a regression reads as itself
    // rather than as "the link 404s for some reason".
    const dotStripper = config.routes.find(
      (r) => r.status === 308 && r.src?.includes('\\.\\w+') && !r.handle,
    );
    check(
      dotStripper !== undefined,
      'the trailing-slash-stripping 308 is still in the table (if it is gone, this guard can relax)',
    );
    if (dotStripper?.src) {
      check(
        !new RegExp(dotStripper.src).test(link.pathname),
        'and the upload link path does not match it — no dot in any path segment',
      );
    }

    // The token must be in the query string for the above to hold. Asserted
    // directly so the reason survives even if the route table changes shape.
    check(
      link.searchParams.get(APPOINTMENT_UPLOAD_TOKEN_PARAM) === minted.token,
      'the token travels in the query string, intact',
    );
    check(
      !link.pathname.includes('.'),
      'and no part of the path carries it — that is what makes it immune to the rule above',
    );
  }
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('\n✓ appointment upload token checks passed\n');
