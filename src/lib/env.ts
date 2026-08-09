/**
 * Reading server environment variables from whichever store the current
 * runtime actually has.
 *
 * Two stores exist and both are genuinely needed:
 *
 *   - `process.env` — Vercel functions, plain Node, and every CLI script.
 *   - `import.meta.env` — `astro dev`. Vite loads `.env` files into this and
 *     never into `process.env`, so under the dev server the process store is
 *     empty for exactly these keys.
 *
 * The obvious spelling, `process.env.X ?? import.meta.env.X`, is a trap.
 * `import.meta.env` is *undefined* outside Vite, and `??` only short-circuits
 * when the left side is null/undefined — which is precisely the case where the
 * right side then gets evaluated. So when `X` is unset under plain Node you get
 * `Cannot read properties of undefined (reading 'X')` instead of the
 * deliberate "not configured" error the caller wrote. It fires only in the
 * unset case, which is how it survived unnoticed: every environment that works
 * never reaches the second operand.
 *
 * The empty string counts as unset. `vercel env pull` writes sensitive
 * variables back as `""`, and both `loadEnv` implementations under `scripts/`
 * already skip empty values — this makes all three readers agree, and lets an
 * `X=""` in `.env.local` fall through to a real value in `import.meta.env`
 * rather than short-circuiting on nothing.
 */

/** The Vite env object, or undefined when there is no Vite. */
function viteEnv(): Record<string, string | undefined> | undefined {
  // The cast is the whole point: TypeScript believes `import.meta.env` always
  // exists (astro/client types say so), and under `tsx` it does not.
  const meta = import.meta as unknown as {
    env?: Record<string, string | undefined>;
  };
  return meta.env;
}

/**
 * The value of `name`, or undefined if it is unset or empty in both stores.
 * Never throws — deciding what a missing variable means is the caller's job.
 */
export function readEnv(name: string): string | undefined {
  const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;

  const fromVite = viteEnv()?.[name];
  if (fromVite !== undefined && fromVite !== '') return fromVite;

  return undefined;
}
