<script lang="ts">
  // City data with geographic coordinates
  // SVG transform: x = (120 - lon) / 10 * 200,  y = (60 - lat) / 11 * 220
  // viewBox "-10 -8 220 236" adds 10/8 units of padding around the 200×220 space
  const CITIES = [
    { name: 'Edmonton',             lat: 53.5461, lon: 113.4938, featured: true  },
    { name: 'St. Albert',           lat: 53.6303, lon: 113.6281 },
    { name: 'Sherwood Park',        lat: 53.5350, lon: 113.3229 },
    { name: 'Spruce Grove',         lat: 53.5447, lon: 113.9004 },
    { name: 'Stony Plain',          lat: 53.5260, lon: 114.0000 },
    { name: 'Leduc',                lat: 53.2593, lon: 113.5489 },
    { name: 'Beaumont',             lat: 53.3572, lon: 113.4157 },
    { name: 'Fort Saskatchewan',    lat: 53.7127, lon: 113.2110 },
    { name: 'Devon',                lat: 53.3606, lon: 113.7394 },
    { name: 'Morinville',           lat: 53.8025, lon: 113.6500 },
    { name: 'Bon Accord',           lat: 53.8414, lon: 113.4167 },
    { name: 'Gibbons',              lat: 53.8289, lon: 113.3264 },
    { name: 'Legal',                lat: 53.9456, lon: 113.6389 },
    { name: 'Redwater',             lat: 53.9522, lon: 113.1061 },
    { name: 'Lamont',               lat: 53.7631, lon: 112.8031 },
    { name: 'Tofield',              lat: 53.3736, lon: 112.6639 },
    { name: 'Vegreville',           lat: 53.4922, lon: 112.0531 },
    { name: 'Camrose',              lat: 53.0167, lon: 112.8333 },
    { name: 'Wetaskiwin',           lat: 52.9694, lon: 113.3764 },
    { name: 'Ponoka',               lat: 52.6836, lon: 113.5814 },
    { name: 'Lacombe',              lat: 52.4681, lon: 113.7358 },
    { name: 'Red Deer',             lat: 52.2681, lon: 113.8114 },
    { name: 'Barrhead',             lat: 54.1281, lon: 114.4058 },
    { name: 'Westlock',             lat: 54.1522, lon: 113.8556 },
    { name: 'Athabasca',            lat: 54.7178, lon: 113.2839 },
    { name: 'Smoky Lake',           lat: 54.1131, lon: 112.4689 },
    { name: 'Mundare',              lat: 53.5606, lon: 112.3281 },
    { name: 'Viking',               lat: 53.0939, lon: 111.7722 },
    { name: 'Vermilion',            lat: 53.3561, lon: 110.8564 },
    { name: 'Whitecourt',           lat: 54.1439, lon: 115.6839 },
    { name: 'Drayton Valley',       lat: 53.2211, lon: 114.9789 },
    { name: 'Rocky Mountain House', lat: 52.3681, lon: 114.9231 },
  ];

  const W = 200, H = 220;
  const LON_MIN = 110, LON_MAX = 120;
  const LAT_MIN = 49,  LAT_MAX = 60;

  // Precompute SVG pin positions
  const cities = CITIES.map(c => ({
    ...c,
    px: +((LON_MAX - c.lon) / (LON_MAX - LON_MIN) * W).toFixed(1),
    py: +((LAT_MAX - c.lat) / (LAT_MAX - LAT_MIN) * H).toFixed(1),
  }));

  // Simplified Alberta boundary path in 200×220 coordinate space.
  // Key points (lon°W, lat°N) → (svgX, svgY):
  //   NW (120, 60) → (0,0)   NE (110, 60) → (200,0)
  //   SE (110, 49) → (200,220)
  //   SW foot ~(114.07, 49) → (119,220) — where 49th parallel meets mountains
  //   Western/mountain border curves NW via bezier control points
  //   Reaches 120°W at ~55°N → (0,100), then straight to NW corner
  const ALBERTA =
    'M 0,0 L 200,0 L 200,220 L 119,220 ' +
    'C 108,216 88,194 78,170 ' +
    'C 68,147 50,134 20,115 ' +
    'L 0,100 Z';

  let active = $state<string | null>(null);

  function select(name: string) {
    active = active === name ? null : name;
  }

  function labelAnchor(px: number): 'start' | 'middle' | 'end' {
    if (px > 165) return 'end';
    if (px < 35)  return 'start';
    return 'middle';
  }
</script>

<div class="root">
  <!-- ── Pills (left on desktop, below on mobile) ─────────────────────── -->
  <div class="pills-col">
    {#each cities as city}
      <button
        class="pill"
        class:pill--featured={city.featured}
        class:pill--active={active === city.name}
        aria-pressed={active === city.name}
        onclick={() => select(city.name)}
      >
        {#if city.featured}
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11"
            viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class="pin-icon">
            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
          </svg>
        {/if}
        {city.name}
      </button>
    {/each}
  </div>

  <!-- ── SVG Map (right on desktop, above on mobile) ──────────────────── -->
  <div class="map-col">
    <svg
      viewBox="-10 -8 220 236"
      xmlns="http://www.w3.org/2000/svg"
      class="map-svg"
      role="img"
      aria-label="Map of Alberta showing YEG Restoration service area"
    >
      <!-- Province fill + border -->
      <path
        d={ALBERTA}
        fill="rgba(15,20,25,0.04)"
        stroke="rgba(15,20,25,0.14)"
        stroke-width="0.7"
        stroke-linejoin="round"
      />

      <!-- City pins -->
      {#each cities as city}
        {@const isActive = active === city.name}
        {@const anchor  = labelAnchor(city.px)}

        <g
          transform="translate({city.px},{city.py})"
          onclick={() => select(city.name)}
          onkeydown={(e) => e.key === 'Enter' && select(city.name)}
          role="button"
          tabindex="0"
          aria-label="{city.name}{isActive ? ' (selected)' : ''}"
          class="pin-group"
        >
          <!-- Pulse ring — SVG SMIL animation, no transform-origin issues -->
          {#if isActive}
            <circle cx="0" cy="0" r="6" fill="none" stroke="#f2c94c" stroke-width="1.2">
              <animate attributeName="r"       values="6;20"   dur="1.8s" repeatCount="indefinite"/>
              <animate attributeName="opacity" values="0.7;0"  dur="1.8s" repeatCount="indefinite"/>
            </circle>
          {/if}

          <!-- Pin dot -->
          <circle
            cx="0" cy="0"
            r={isActive ? 5.5 : city.featured ? 4 : 2.8}
            fill={isActive
              ? '#f2c94c'
              : city.featured
                ? 'rgba(242,201,76,0.6)'
                : 'rgba(15,20,25,0.22)'}
            stroke={isActive ? 'rgba(15,20,25,0.2)' : 'none'}
            stroke-width="0.6"
          />

          <!-- City label (paint-order trick: stroke renders before fill for readability) -->
          {#if isActive}
            <text
              x="0"
              y="-10"
              text-anchor={anchor}
              dominant-baseline="auto"
              font-family="Sora, system-ui, sans-serif"
              font-size="7"
              font-weight="700"
              fill="#0F1419"
              stroke="rgba(248,246,243,0.95)"
              stroke-width="3.5"
              stroke-linejoin="round"
              paint-order="stroke fill"
              pointer-events="none"
            >{city.name}</text>
          {/if}
        </g>
      {/each}
    </svg>

    <p class="map-hint">Click any badge or pin to locate it on the map</p>
  </div>
</div>

<style>
  /* ── Layout ─────────────────────────────────────────────────────────── */
  .root {
    display: flex;
    flex-direction: column;
    gap: 2rem;
    align-items: flex-start;
  }

  @media (min-width: 1024px) {
    .root {
      flex-direction: row;
      gap: 3.5rem;
      align-items: flex-start;
    }
    .pills-col {
      order: 1;
      width: 44%;
      flex-shrink: 0;
    }
    .map-col {
      order: 2;
      flex: 1;
    }
  }

  /* ── Pills ───────────────────────────────────────────────────────────── */
  .pills-col {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    order: 2;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.375rem 0.8rem;
    border-radius: 9999px;
    font-size: 0.8125rem;
    font-family: 'Inter', system-ui, sans-serif;
    font-weight: 500;
    line-height: 1;
    border: 1px solid rgba(0,0,0,0.07);
    background: white;
    color: #5A6270;
    cursor: pointer;
    transition: border-color 0.18s, color 0.18s, background 0.18s, transform 0.15s, box-shadow 0.15s;
  }

  .pill:hover {
    border-color: rgba(242,201,76,0.35);
    color: #0F1419;
  }

  .pill--featured {
    background: rgba(242,201,76,0.08);
    border-color: rgba(242,201,76,0.4);
    color: #0F1419;
    font-weight: 600;
  }

  .pill--active {
    background: rgba(242,201,76,0.14) !important;
    border-color: rgba(242,201,76,0.65) !important;
    color: #0F1419 !important;
    transform: scale(1.05);
    box-shadow: 0 0 0 3px rgba(242,201,76,0.12);
  }

  .pin-icon {
    color: #f2c94c;
    flex-shrink: 0;
  }

  /* ── Map ─────────────────────────────────────────────────────────────── */
  .map-col {
    order: 1;
    width: 100%;
  }

  .map-svg {
    width: 100%;
    max-height: 420px;
    display: block;
  }

  .map-hint {
    text-align: center;
    font-size: 0.6875rem;
    color: rgba(90, 98, 112, 0.45);
    margin-top: 0.5rem;
    font-family: 'Inter', system-ui, sans-serif;
    letter-spacing: 0.01em;
  }

  /* ── Pin interactions ────────────────────────────────────────────────── */
  .pin-group {
    outline: none;
  }

  .pin-group:focus-visible circle:last-of-type {
    stroke: #f2c94c;
    stroke-width: 1.5;
  }

  @media (prefers-reduced-motion: reduce) {
    .pin-group circle animate {
      display: none;
    }
  }
</style>
