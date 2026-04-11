import { Star, MapPin } from 'lucide-react';

export function CommandStrip() {
  return (
    <div className="command-strip fixed bottom-0 left-0 right-0 z-[200] h-[10vh] min-h-[70px] flex items-center px-6 lg:px-12">
      <div className="w-full flex items-center justify-between">
        {/* Location */}
        <div className="hidden md:flex items-center gap-2 text-yeg-text-secondary">
          <MapPin className="w-4 h-4" />
          <span className="text-xs font-medium tracking-wider uppercase">
            Edmonton • Surrounding Areas
          </span>
        </div>

        {/* Trust Signals */}
        <div className="flex items-center gap-6 lg:gap-10">
          <div className="hidden sm:flex trust-badge">
            <Star className="w-4 h-4 text-yeg-amber fill-yeg-amber" />
            <span>5-Star Rated</span>
          </div>
          <div className="hidden lg:flex trust-badge">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span>Locally Owned</span>
          </div>
        </div>

        {/* Right side - empty (removed duplicate Get Free Quote button) */}
        <div className="hidden lg:block" />
      </div>
    </div>
  );
}
