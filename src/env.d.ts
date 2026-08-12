/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_GA4_ID?: string;
  readonly PUBLIC_AW_ID?: string;
  readonly PUBLIC_AW_CALL_LABEL?: string;
  // PUBLIC_AW_FORM_LABEL retired with the BK-10 cutover: the contact form is a
  // message channel now and reports no Ads conversion. The account-side action
  // was demoted to Secondary, never deleted, so its history survives.
  /** Booked assessments — its own action, so bookings stay biddable apart from leads. */
  readonly PUBLIC_AW_BOOKING_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  gtag?: (...args: unknown[]) => void;
}
