/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_GA4_ID?: string;
  readonly PUBLIC_AW_ID?: string;
  readonly PUBLIC_AW_CALL_LABEL?: string;
  readonly PUBLIC_AW_FORM_LABEL?: string;
  /** Booked assessments — its own action, so bookings stay biddable apart from leads. */
  readonly PUBLIC_AW_BOOKING_LABEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  gtag?: (...args: unknown[]) => void;
}
