// Property-checks the pure half of the booking form island. No DOM, no
// database, no network.
//
//   npx tsx scripts/verify-booking-form.ts
//
// Exits non-zero on the first failed assertion.
import {
  MAX_FILES_PER_BOOKING,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from '../src/lib/booking-config';
import {
  applyPrefill,
  assembleBookingPayload,
  checkFileAcceptance,
  createDraftSession,
  createSubmitGuard,
  emptyFormValues,
  mapCommitResponse,
  readAvailabilityResponse,
  resolveContentType,
  stepForErrors,
  validateStep,
  type FormValues,
} from '../src/lib/booking-form';
import { parseBookingPayload } from '../src/lib/booking-payload';
import { slotStartsForDate, localDateKey, addDays } from '../src/lib/booking-time';

const SERVICES = new Set([
  'water', 'fire', 'mold', 'storm', 'sewage',
  'construction', 'contents', 'biohazard', 'asbestos', 'other',
]);

let failures = 0;
function check(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failures++;
  }
}

/** A real grid instant, so slot validity is never the reason a case fails. */
const SLOT = slotStartsForDate(addDays(localDateKey(new Date()), 3))[0].toISOString();

function values(overrides: Partial<FormValues> = {}): FormValues {
  return {
    ...emptyFormValues(),
    slotStart: SLOT,
    name: 'Sam Rivers',
    phone: '780-555-0134',
    email: 'sam@example.com',
    service: 'water',
    address: '123 Maple St',
    ...overrides,
  };
}

function fieldsFor(step: 1 | 2 | 3, v: FormValues): string[] {
  return validateStep(step, v, SERVICES).map((e) => e.field);
}

// ---------------------------------------------------------------------------
console.log('Step validation');
// ---------------------------------------------------------------------------
{
  check(fieldsFor(1, values()).length === 0, 'a chosen slot must pass step 1');
  check(
    fieldsFor(1, values({ slotStart: null })).includes('slot_start'),
    'step 1 must require a slot',
  );

  check(fieldsFor(2, values()).length === 0, 'a complete step 2 must pass');
  for (const field of ['name', 'phone', 'address'] as const) {
    check(fieldsFor(2, values({ [field]: '' })).includes(field), `${field} must be required`);
    check(
      fieldsFor(2, values({ [field]: '   ' })).includes(field),
      `${field} must reject whitespace`,
    );
  }
  check(fieldsFor(2, values({ service: '' })).includes('service'), 'service must be required');
  check(
    fieldsFor(2, values({ service: 'teleportation' })).includes('service'),
    'an unlisted service must be rejected',
  );
  check(fieldsFor(2, values({ phone: '123' })).includes('phone'), 'a short phone is rejected');
  check(fieldsFor(2, values({ phone: '1-780-555-0134' })).length === 0, '11-digit phone passes');
  check(fieldsFor(2, values({ email: 'nope' })).includes('email'), 'a bad email is rejected');
  check(fieldsFor(2, values({ email: '' })).length === 0, 'email is optional');

  // Optional fields are optional on the private route; required on insurance.
  check(
    fieldsFor(2, values({ payment_route: 'insurance' })).includes('insurer_name'),
    'insurer_name must be required on the insurance route',
  );
  check(
    fieldsFor(2, values({ payment_route: 'insurance', insurer_name: 'Acme Mutual' })).length === 0,
    'the insurance route passes once the insurer is given',
  );
  check(
    fieldsFor(2, values({ payment_route: 'private', insurer_name: '' })).length === 0,
    'insurer_name must not be required on the private route',
  );

  check(fieldsFor(3, values()).length === 0, 'step 3 must never block on consent');
  check(
    fieldsFor(3, values({ smsConsent: false })).length === 0,
    'a booking without consent must still be submittable',
  );
  console.log('  required, optional, and conditional rules hold');
}

// ---------------------------------------------------------------------------
console.log('\nStep routing for server field errors');
// ---------------------------------------------------------------------------
{
  check(stepForErrors([{ field: 'slot_start', message: 'x' }]) === 1, 'slot_start routes to step 1');
  check(stepForErrors([{ field: 'name', message: 'x' }]) === 2, 'name routes to step 2');
  check(
    stepForErrors([
      { field: 'name', message: 'x' },
      { field: 'slot_start', message: 'x' },
    ]) === 1,
    'the earliest step wins when several are in error',
  );
  check(stepForErrors([{ field: '_', message: 'x' }]) === null, 'an unmapped field routes nowhere');
  check(stepForErrors([]) === null, 'no errors routes nowhere');
  console.log('  earliest mappable step wins, unmapped routes to null');
}

// ---------------------------------------------------------------------------
console.log('\nPayload assembly');
// ---------------------------------------------------------------------------
{
  const payload = assembleBookingPayload(values(), null);

  // Key ABSENCE, not falsiness: booking-payload.ts 422s on draft_token: null.
  check(!('draft_token' in payload), 'draft_token must be absent, not null, with no draft');
  check(
    'draft_token' in assembleBookingPayload(values(), 'v1.a.b.c'),
    'draft_token must be present when a draft exists',
  );
  check(typeof payload.sms_consent === 'boolean', 'sms_consent must always be a boolean');
  check(payload.slot_start === SLOT, 'slot_start must be posted back verbatim');

  const priv = assembleBookingPayload(
    values({
      payment_route: 'private',
      insurer_name: 'Acme Mutual',
      policy_number: 'POL-1',
      claim_number: 'CLM-1',
    }),
    null,
  );
  for (const key of ['insurer_name', 'policy_number', 'claim_number']) {
    check(!(key in priv), `${key} must be dropped on the private route`);
  }

  const ins = assembleBookingPayload(
    values({
      payment_route: 'insurance',
      insurer_name: 'Acme Mutual',
      policy_number: 'POL-1',
      claim_number: 'CLM-1',
    }),
    null,
  );
  check(ins.insurer_name === 'Acme Mutual', 'insurer_name must survive the insurance route');
  check(ins.policy_number === 'POL-1', 'policy_number must survive the insurance route');

  check(!('email' in assembleBookingPayload(values({ email: '' }), null)), 'a blank email is omitted');
  check(!('email' in assembleBookingPayload(values({ email: '  ' }), null)), 'a blank email is trimmed then omitted');

  // No server-owned key may ever be assembled: they are 422s by design.
  for (const key of ['draft_id', 'draftId', 'id', 'status', 'pipeline_stage', 'source']) {
    check(!(key in ins), `${key} must never be assembled into the payload`);
  }
  console.log('  omission, trimming, and insurance dropping hold');
}

// ---------------------------------------------------------------------------
console.log('\nAssembled payloads survive the real server validator');
// ---------------------------------------------------------------------------
{
  // The strongest available check without a database: run what the island would
  // POST through the exact function the endpoint runs. A client that assembles
  // a shape the server rejects is the failure this whole module exists to stop.
  const opts = { allowedServices: SERVICES };

  const plain = parseBookingPayload(assembleBookingPayload(values(), null), opts);
  check(plain.ok, `a private-route payload must parse server-side (got ${JSON.stringify(plain.ok ? [] : plain.errors)})`);
  check(plain.ok && plain.payload.draftToken === null, 'an omitted draft_token reads as null server-side');
  check(plain.ok && plain.payload.smsConsent === false, 'consent must arrive false');

  const consented = parseBookingPayload(
    assembleBookingPayload(values({ smsConsent: true }), 'v1.a.b.c'),
    opts,
  );
  check(consented.ok && consented.payload.smsConsent === true, 'consent must arrive true');
  check(
    consented.ok && consented.payload.draftToken === 'v1.a.b.c',
    'the draft token must reach the server unchanged',
  );

  const insured = parseBookingPayload(
    assembleBookingPayload(
      values({ payment_route: 'insurance', insurer_name: 'Acme', policy_number: 'POL-1' }),
      null,
    ),
    opts,
  );
  check(insured.ok, 'an insurance payload must parse server-side');
  check(insured.ok && insured.payload.policy_number === 'POL-1', 'policy number must round-trip');

  const cityless = parseBookingPayload(assembleBookingPayload(values({ city: '' }), null), opts);
  check(cityless.ok && cityless.payload.city === 'Edmonton', 'an omitted city defaults server-side');
  console.log('  client output is accepted by the server validator');
}

// ---------------------------------------------------------------------------
console.log('\nContent-type resolution');
// ---------------------------------------------------------------------------
{
  check(
    resolveContentType({ name: 'a.jpg', type: 'image/jpeg', size: 1 }) === 'image/jpeg',
    'a declared allowed type is used',
  );
  // The iPhone case: browsers report '' for HEIC and the extension is all there is.
  check(
    resolveContentType({ name: 'IMG_0042.HEIC', type: '', size: 1 }) === 'image/heic',
    'an empty file.type must fall back to the extension (the iPhone case)',
  );
  check(
    resolveContentType({ name: 'clip.MOV', type: '', size: 1 }) === 'video/quicktime',
    'extension matching must be case-insensitive',
  );
  check(
    resolveContentType({ name: 'notes.pdf', type: 'application/pdf', size: 1 }) === null,
    'an unsupported type is refused',
  );
  check(
    resolveContentType({ name: 'noextension', type: '', size: 1 }) === null,
    'a file with no extension and no type is refused',
  );
  check(
    resolveContentType({ name: 'a.jpg', type: 'application/octet-stream', size: 1 }) === 'image/jpeg',
    'a junk declared type still falls back to the extension',
  );
  console.log('  declared type, extension fallback, and refusals hold');
}

// ---------------------------------------------------------------------------
console.log('\nFile acceptance limits');
// ---------------------------------------------------------------------------
{
  const ok = (f: { name?: string; type?: string; size: number }, attached: { size: number }[] = []) =>
    checkFileAcceptance(
      { name: f.name ?? 'a.jpg', type: f.type ?? 'image/jpeg', size: f.size },
      attached,
    );

  check(ok({ size: 1024 }).ok, 'a small file is accepted');
  check(ok({ size: MAX_FILE_BYTES }).ok, 'a file exactly at the per-file limit is accepted');
  check(!ok({ size: MAX_FILE_BYTES + 1 }).ok, 'a file one byte over the per-file limit is refused');

  const full = Array.from({ length: MAX_FILES_PER_BOOKING }, () => ({ size: 1 }));
  check(!ok({ size: 1 }, full).ok, `file ${MAX_FILES_PER_BOOKING + 1} is refused`);
  check(ok({ size: 1 }, full.slice(0, -1)).ok, `file ${MAX_FILES_PER_BOOKING} is accepted`);

  const nearlyFull = [{ size: MAX_TOTAL_BYTES - 100 }];
  check(ok({ size: 100 }, nearlyFull).ok, 'a total exactly at the cap is accepted');
  check(!ok({ size: 101 }, nearlyFull).ok, 'a total one byte over the cap is refused');

  check(!ok({ size: 0 }).ok, 'an empty file is refused');
  check(!ok({ size: 1, name: 'x.pdf', type: 'application/pdf' }).ok, 'an unsupported type is refused');

  const refused = ok({ size: MAX_FILE_BYTES + 1 });
  check(!refused.ok && refused.message.includes('100'), 'the per-file message names the limit');
  console.log('  count, per-file, total, and type boundaries hold');
}

// ---------------------------------------------------------------------------
console.log('\nAvailability response handling');
// ---------------------------------------------------------------------------
{
  check(readAvailabilityResponse(200, { dates: [] }).ok, 'a 200 with dates is a load');
  const empty = readAvailabilityResponse(200, { dates: [] });
  check(empty.ok && empty.dates.length === 0, 'an empty but present dates array is still a load');

  // The BK-01 distinction: a DB failure carries no dates key at all.
  check(
    !readAvailabilityResponse(500, { error: 'Could not load availability.' }).ok,
    'a 500 must be a load failure',
  );
  check(
    !readAvailabilityResponse(200, { error: 'weird' }).ok,
    'a 200 with no dates array must be a load failure, not an empty calendar',
  );
  check(!readAvailabilityResponse(200, null).ok, 'a null body must not throw');
  check(!readAvailabilityResponse(200, { dates: 'nope' }).ok, 'a non-array dates must be a failure');

  const failed = readAvailabilityResponse(500, {});
  check(!failed.ok && failed.message.includes('call us'), 'the failure message offers the phone');
  console.log('  failure and empty-calendar are distinguished');
}

// ---------------------------------------------------------------------------
console.log('\nCommit response mapping');
// ---------------------------------------------------------------------------
{
  const booked = mapCommitResponse(201, { id: 7, slotLabel: 'Tue, Aug 11 · 1:30 PM', filesAttached: 2 });
  check(booked.kind === 'booked', '201 maps to booked');
  check(booked.kind === 'booked' && booked.id === 7, 'the appointment id is carried');
  check(booked.kind === 'booked' && booked.filesAttached === 2, 'filesAttached is carried');

  // emailSent decides whether the confirmation page tells the visitor to check
  // their inbox, so only a literal `true` may produce `true`. Everything else —
  // absent (a build that predates BK-05), a string, a truthy non-boolean — must
  // read as false: promising an email that never arrives is a support call.
  check(booked.kind === 'booked' && booked.emailSent === false, 'emailSent defaults to false when absent');
  check(
    mapCommitResponse(201, { id: 7, emailSent: true }).kind === 'booked' &&
      (mapCommitResponse(201, { id: 7, emailSent: true }) as { emailSent: boolean }).emailSent === true,
    'emailSent is carried when the server says true',
  );
  for (const value of ['true', 1, {}, null] as const) {
    const outcome = mapCommitResponse(201, { id: 7, emailSent: value }) as { emailSent: boolean };
    check(outcome.emailSent === false, `emailSent of ${JSON.stringify(value)} does not read as true`);
  }

  const fields = mapCommitResponse(422, {
    error: 'Please check the highlighted fields.',
    fields: [{ field: 'phone', message: 'Enter a 10-digit phone number.' }],
  });
  check(fields.kind === 'fields', '422 with fields maps to fields');
  check(fields.kind === 'fields' && fields.step === 2, 'it routes to the step holding the field');

  // The shapes that would otherwise throw or dead-end the form.
  check(mapCommitResponse(422, { error: 'Expected a JSON body.' }).kind === 'formError',
    '422 with no fields array maps to a form-level error');
  check(mapCommitResponse(422, { fields: [] }).kind === 'formError',
    '422 with an empty fields array maps to a form-level error');
  check(mapCommitResponse(422, { fields: [{ field: 'draft_token', message: 'x' }] }).kind === 'formError',
    '422 whose only field has no input maps to a form-level error');
  check(mapCommitResponse(422, null).kind === 'formError', '422 with a null body must not throw');

  const taken = mapCommitResponse(409, { error: 'That time was just booked.', code: 'slot_taken' });
  check(taken.kind === 'slotGone' && taken.code === 'slot_taken', '409 slot_taken maps to slotGone');
  const unavailable = mapCommitResponse(409, { error: 'no longer available', code: 'slot_unavailable' });
  check(
    unavailable.kind === 'slotGone' && unavailable.code === 'slot_unavailable',
    '409 slot_unavailable maps to slotGone with its own code',
  );

  check(mapCommitResponse(400, { error: 'Your upload session expired.' }).kind === 'draftExpired',
    '400 maps to draftExpired');
  check(mapCommitResponse(429, { error: 'Too many requests.' }).kind === 'formError',
    '429 maps to a form-level error');
  check(mapCommitResponse(500, { error: 'Something went wrong.' }).kind === 'formError',
    '500 maps to a form-level error');

  console.log('  every status maps, and none of the odd 422 shapes throws');
}

// ---------------------------------------------------------------------------
console.log('\nThe island never renders server prose');
// ---------------------------------------------------------------------------
{
  // Not decoration: passing the server's sentence through is what dropped the
  // phone number from 429/500, told a 400 visitor to "reload the page" (losing
  // everything they had typed), and made every response body an echo channel.
  // Every one of these bodies carries a marker; none of it may survive mapping.
  const MARKER = 'POL-SECRET-ECHO';
  const cases: [number, unknown][] = [
    [400, { error: `expired ${MARKER}` }],
    [409, { error: `taken ${MARKER}`, code: 'slot_taken' }],
    [409, { error: `gone ${MARKER}`, code: 'slot_unavailable' }],
    [422, { error: `bad ${MARKER}` }],
    [429, { error: `slow down ${MARKER}` }],
    [500, { error: `boom ${MARKER}` }],
    [503, { error: `down ${MARKER}` }],
  ];

  for (const [status, body] of cases) {
    const outcome = mapCommitResponse(status, body);
    const rendered = 'message' in outcome ? outcome.message : '';
    check(
      !rendered.includes(MARKER),
      `${status} must not echo the server's message (got "${rendered}")`,
    );
  }

  // And the two that most need the phone number actually carry it.
  const rateLimited = mapCommitResponse(429, { error: 'x' });
  const serverError = mapCommitResponse(500, { error: 'x' });
  check(
    rateLimited.kind === 'formError' && rateLimited.message.includes('479-3285'),
    'a 429 must offer the phone number',
  );
  check(
    serverError.kind === 'formError' && serverError.message.includes('479-3285'),
    'a 500 must offer the phone number',
  );

  // The 400 must not tell the visitor to throw their answers away.
  const expired = mapCommitResponse(400, { error: 'Reload the page and try again.' });
  check(
    expired.kind === 'draftExpired' && !/reload/i.test(expired.message),
    'a 400 must not tell the visitor to reload the page',
  );
  console.log('  no status echoes the body; 429/500 carry the phone; 400 says nothing about reloading');
}

// ---------------------------------------------------------------------------
console.log('\nOne draft per session, even for concurrent files');
// ---------------------------------------------------------------------------
{
  // Guarding on the resolved value is not enough: three files chosen at once
  // fire three mints before the first resolves, which burns three of the 20
  // drafts an IP gets per hour AND pairs the last token with pathnames built
  // from an earlier draft id — so the photos silently never attach.
  let mints = 0;
  const session = createDraftSession(async () => {
    mints++;
    await new Promise((r) => setTimeout(r, 10));
    return { draftId: `draft-${mints}`, draftToken: `token-${mints}` };
  });

  const all = await Promise.all([session.get(), session.get(), session.get()]);
  check(mints === 1, `three concurrent files must mint one draft (minted ${mints})`);
  check(
    all.every((d) => d?.draftId === all[0]?.draftId),
    'every concurrent caller must get the same draft',
  );
  check((await session.get())?.draftId === 'draft-1', 'a later file reuses the session draft');
  check(mints === 1, 'reuse must not mint again');

  session.reset();
  check((await session.get())?.draftId === 'draft-2', 'reset must mint a fresh draft');

  // A failed mint is not cached — the next file selection may legitimately retry.
  let attempts = 0;
  const failing = createDraftSession(async () => {
    attempts++;
    return attempts < 2 ? null : { draftId: 'ok', draftToken: 't' };
  });
  check((await failing.get()) === null, 'a failed mint returns null');
  check((await failing.get())?.draftId === 'ok', 'a failed mint is not cached, so a retry can succeed');
  console.log('  one mint for concurrent callers, retryable after failure');
}

// ---------------------------------------------------------------------------
console.log('\nSingle-flight submit guard');
// ---------------------------------------------------------------------------
{
  const guard = createSubmitGuard();
  check(guard.begin() === true, 'the first submit is allowed');
  check(guard.begin() === false, 'a second concurrent submit is refused');
  check(guard.inFlight === true, 'the guard reports itself in flight');
  guard.end();
  check(guard.inFlight === false, 'the guard clears when the request finishes');
  check(guard.begin() === true, 'a later submit is allowed again');
  console.log('  one in-flight submit at a time');
}

// ---------------------------------------------------------------------------
console.log('\nQuery-param prefill trusts nothing (BK-10 AC4)');
// ---------------------------------------------------------------------------
{
  // BK-10 points every service page's CTA at /book/?service=<id> and the
  // insurance page's at /book/?route=insurance, so a visitor who has already
  // declared their intent does not declare it twice.
  const base = emptyFormValues();

  const service = applyPrefill(base, '?service=mold', SERVICES);
  check(service.service === 'mold', `a known service is selected, got "${service.service}"`);
  check(service.payment_route === base.payment_route, 'and nothing else moves');

  const route = applyPrefill(base, '?route=insurance', SERVICES);
  check(route.payment_route === 'insurance', `?route=insurance switches the route, got ${route.payment_route}`);
  check(route.service === '', 'and leaves the service alone');

  const both = applyPrefill(base, '?service=fire&route=insurance', SERVICES);
  check(both.service === 'fire' && both.payment_route === 'insurance', 'both together');

  check(
    applyPrefill(base, '?route=private', SERVICES).payment_route === 'private',
    'the other real route works too',
  );

  // Nothing is trusted. Each of these can only ever select an option the form
  // already offers; anything else leaves the field at its default.
  const IGNORED: [string, string][] = [
    ['?service=garbage', 'an unknown service id'],
    ['?service=', 'an empty service'],
    ['?service=MOLD', 'the wrong case — the ids are the allow-list, verbatim'],
    ['?service=mold%20', 'a trailing space'],
    ['?service=<script>alert(1)</script>', 'an injection attempt'],
    ['?service[]=mold', 'an array-ish parameter name'],
  ];
  for (const [search, label] of IGNORED) {
    const result = applyPrefill(base, search, SERVICES);
    check(result.service === '', `${label} is ignored, got "${result.service}"`);
  }

  for (const search of ['?route=insurances', '?route=INSURANCE', '?route=', '?route=other']) {
    check(
      applyPrefill(base, search, SERVICES).payment_route === 'private',
      `${search} leaves the payment route at its default`,
    );
  }

  check(
    applyPrefill(base, '', SERVICES).service === '' &&
      applyPrefill(base, '?', SERVICES).service === '',
    'an absent query string changes nothing',
  );

  // Pure: the caller's values object is not mutated under it. A Svelte $state
  // proxy mutated in place would work by accident and then not.
  const original = emptyFormValues();
  applyPrefill(original, '?service=mold&route=insurance', SERVICES);
  check(
    original.service === '' && original.payment_route === 'private',
    'the caller\'s values are left untouched',
  );

  console.log('  ?service= and ?route= select only what already exists');
}

if (failures > 0) {
  console.error(`\n✗ ${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\n✓ All booking form checks passed.');
