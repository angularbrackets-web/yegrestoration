export const LOGO_SRC = '/images/YEG_Restoration_Logo_RBG.png';
export const LOGO_ALT = 'YEG Restoration — Restore, Recover, Rebuild';

export function BrandLogo({ className }: { className?: string }) {
  return (
    <img
      src={LOGO_SRC}
      alt={LOGO_ALT}
      width={500}
      height={500}
      decoding="async"
      className={className}
    />
  );
}

type BlobVariant = 'nav' | 'drawer' | 'footer';

/**
 * Logo container wrapper. Rendered as a sharp rectangle with a gold background.
 * The logo inner image is scaled up to read larger without growing the outer shape.
 */
export function BrandLogoGoldBlob({ variant }: { variant: BlobVariant }) {
  const shell =
    variant === 'nav'
      ? 'h-[48px] w-[130px] sm:h-[52px] sm:w-[145px] lg:h-[56px] lg:w-[160px]'
      : variant === 'drawer'
        ? 'h-[52px] w-[150px]'
        : 'h-[60px] w-[160px] sm:h-[64px] sm:w-[175px]';

  const img =
    variant === 'nav'
      ? 'h-[5rem] w-[5rem] sm:h-[5.5rem] sm:w-[5.5rem] lg:h-[6rem] lg:w-[6rem] scale-[1.35] sm:scale-[1.4] lg:scale-[1.45]'
      : variant === 'drawer'
        ? 'h-[6rem] w-[6rem] scale-[1.45]'
        : 'h-[6.5rem] w-[6.5rem] sm:h-[7rem] sm:w-[7rem] scale-[1.35] sm:scale-[1.4]';

  return (
    <span className={`bg-yeg-amber inline-flex items-center justify-center overflow-hidden shrink-0 ${shell}`}>
      <BrandLogo
        className={`${img} object-contain object-center [transform-origin:center] max-w-none`}
      />
    </span>
  );
}
