<script lang="ts">
  /**
   * The message form.
   *
   * BK-10 demoted this from the site's quote path to its question path: every
   * CTA labelled quote or assessment now goes to `/book/`, and this form is
   * what is left for "I have a question". It renders on `/contact/` and
   * nowhere else. Two consequences are load-bearing:
   *
   *   - `service` is OPTIONAL and `message` is REQUIRED — the inverse of what
   *     a quote form wants, and it must stay in step with `contact-message.ts`
   *     and migration 004.
   *   - The Google Ads `conversion` event is GONE. Bidding optimizes toward
   *     booked assessments now (the account-side action is demoted to
   *     Secondary, never deleted). GA4's `generate_lead` stays, under its old
   *     name, so existing reports keep working; a GA4 annotation marks the
   *     semantic change.
   */
  import { onMount } from 'svelte';
  import { z } from 'zod';
  import { services } from '../data/services';

  /**
   * Mirrors `contactSchema` in `../lib/contact-message`, which is what the
   * endpoint actually runs. Re-typed rather than imported because that module
   * pulls in the Resend adapter; the rule is that this copy may be no
   * *stricter* than the server's, or the form rejects what the API accepts.
   */
  const schema = z.object({
    name: z.string().trim().min(2, 'Please enter your name'),
    phone: z.string().trim().min(7, 'Please enter a valid phone number'),
    email: z.email('Invalid email').optional().or(z.literal('')),
    service: z.string().optional().or(z.literal('')),
    message: z.string().trim().min(1, 'Please tell us what you need'),
  });

  let formData = $state({
    name: '',
    phone: '',
    email: '',
    service: '',
    message: '',
  });

  let errors = $state<Record<string, string>>({});
  let submitted = $state(false);
  let submitting = $state(false);
  let serverError = $state('');
  // Disabled until hydration — a pre-hydration submit would do a native GET
  // navigation (no onsubmit attached yet) and silently drop the lead.
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    errors = {};
    serverError = '';

    const result = schema.safeParse(formData);
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      Object.entries(flat).forEach(([key, msgs]) => {
        if (msgs) errors[key] = msgs[0];
      });
      return;
    }

    submitting = true;
    try {
      // Slashed. `trailingSlash: 'always'` applies to API routes, so the
      // unslashed spelling this used to carry ate a 308 on every submit.
      const res = await fetch('/api/contact/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      if (res.ok) {
        submitted = true;
        if (typeof window.gtag === 'function') {
          // GA4 only. The Ads form conversion retired with the cutover — see
          // the header. `service` is omitted rather than sent empty when the
          // visitor did not pick one.
          window.gtag(
            'event',
            'generate_lead',
            formData.service ? { service: formData.service } : {},
          );
        }
      } else {
        const data = await res.json().catch(() => ({}));
        serverError = data.error ?? 'Something went wrong. Please try again.';
      }
    } catch {
      serverError = 'Network error. Please check your connection and try again.';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="bg-white border border-black/10 rounded-xl p-6 lg:p-10 shadow-[0_4px_24px_rgba(0,0,0,0.06)]">
  {#if submitted}
    <div class="text-center py-12 animate-fade-in">
      <div
        class="w-16 h-16 rounded-full bg-yeg-amber/20 flex items-center justify-center mx-auto mb-6"
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-yeg-amber-deep" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
      </div>
      <h3 class="font-display font-bold text-2xl text-yeg-text mb-2">Message sent</h3>
      <p class="text-yeg-text-secondary">We'll get back to you the same business day.</p>
      <p class="text-yeg-text-secondary text-sm mt-3">
        Emergency? Call
        <a class="text-yeg-amber-deep font-semibold whitespace-nowrap" href="tel:+17804793285">
          (780) 479-3285
        </a> — we answer live, 24/7.
      </p>
    </div>
  {:else}
    <form onsubmit={handleSubmit}>
      <div class="form-field mb-6">
        <h3 class="font-display font-bold text-xl text-yeg-text mb-1">
          Have a question or want a quote? Send us a message
        </h3>
        <p class="text-sm text-yeg-text-secondary">
          We answer every message the same business day. Ready to book a free on-site assessment
          instead? <a class="text-yeg-amber-deep font-semibold" href="/book/">Pick a time</a>.
        </p>
      </div>

      <div class="space-y-5">
        <!-- Name -->
        <div class="form-field">
          <label for="cf-name" class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
            Name
          </label>
          <input
            id="cf-name"
            type="text"
            name="name"
            bind:value={formData.name}
            required
            class="w-full bg-yeg-bg border border-black/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors"
            class:border-red-500={errors.name}
            placeholder="Your name"
          />
          {#if errors.name}
            <p class="text-red-400 text-xs mt-1">{errors.name}</p>
          {/if}
        </div>

        <!-- Phone + Email row -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div class="form-field">
            <label for="cf-phone" class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
              Phone
            </label>
            <input
              id="cf-phone"
              type="tel"
              name="phone"
              bind:value={formData.phone}
              required
              class="w-full bg-yeg-bg border border-black/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors"
              class:border-red-500={errors.phone}
              placeholder="(780) 479-3285"
            />
            {#if errors.phone}
              <p class="text-red-400 text-xs mt-1">{errors.phone}</p>
            {/if}
          </div>

          <div class="form-field">
            <label for="cf-email" class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
              Email
            </label>
            <input
              id="cf-email"
              type="email"
              name="email"
              bind:value={formData.email}
              class="w-full bg-yeg-bg border border-black/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors"
              class:border-red-500={errors.email}
              placeholder="you@email.com"
            />
            {#if errors.email}
              <p class="text-red-400 text-xs mt-1">{errors.email}</p>
            {/if}
          </div>
        </div>

        <!-- Service select — optional since the cutover -->
        <div class="form-field">
          <label for="cf-service" class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
            Service <span class="normal-case">(optional)</span>
          </label>
          <select
            id="cf-service"
            name="service"
            bind:value={formData.service}
            class="w-full bg-yeg-bg border border-black/10 rounded-lg px-4 py-3 text-yeg-text focus:outline-none focus:border-yeg-amber/50 transition-colors appearance-none cursor-pointer"
          >
            <option value="">Not sure / just a question</option>
            {#each services as s (s.id)}
              <option value={s.id}>{s.name}</option>
            {/each}
            <option value="other">Other / not sure</option>
          </select>
        </div>

        <!-- Message — required since the cutover -->
        <div class="form-field">
          <label for="cf-message" class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
            Message
          </label>
          <textarea
            id="cf-message"
            name="message"
            bind:value={formData.message}
            rows={4}
            required
            class="w-full bg-yeg-bg border border-black/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors resize-none"
            class:border-red-500={errors.message}
            placeholder="What's going on, or what would you like to know?"
          ></textarea>
          {#if errors.message}
            <p class="text-red-400 text-xs mt-1">{errors.message}</p>
          {/if}
        </div>

        <!-- Submit -->
        {#if serverError}
          <p class="text-red-400 text-sm text-center">{serverError}</p>
        {/if}
        <div class="form-field pt-2">
          <button
            type="submit"
            disabled={submitting || !hydrated}
            class="cta-primary w-full justify-center disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            <span>{submitting ? 'Sending…' : 'Send Message'}</span>
          </button>
        </div>

        <p class="form-field text-xs text-yeg-text-secondary text-center">
          We never share your info. Emergency calls always prioritized.
        </p>
      </div>
    </form>
  {/if}
</div>
