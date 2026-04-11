<script lang="ts">
  import { Send } from 'lucide-svelte';
  import { z } from 'zod';

  const schema = z.object({
    name: z.string().min(2, 'Please enter your name'),
    phone: z.string().min(7, 'Please enter a valid phone number'),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    service: z.string().min(1, 'Please select a service'),
    message: z.string().optional(),
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

  function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    errors = {};

    const result = schema.safeParse(formData);
    if (!result.success) {
      const flat = result.error.flatten().fieldErrors;
      Object.entries(flat).forEach(([key, msgs]) => {
        if (msgs) errors[key] = msgs[0];
      });
      return;
    }

    // TODO: wire up actual form submission (email service, webhook, etc.)
    submitted = true;
    setTimeout(() => (submitted = false), 4000);
  }
</script>

<div class="bg-yeg-bg-light border border-white/10 rounded-xl p-6 lg:p-10">
  {#if submitted}
    <div class="text-center py-12">
      <div
        class="w-16 h-16 rounded-full bg-yeg-amber/20 flex items-center justify-center mx-auto mb-6"
      >
        <Send size={32} class="text-yeg-amber" />
      </div>
      <h3 class="font-display font-bold text-2xl text-yeg-text mb-2">Request Sent!</h3>
      <p class="text-yeg-text-secondary">We'll call you within 15 minutes.</p>
    </div>
  {:else}
    <form onsubmit={handleSubmit}>
      <div class="space-y-5">
        <!-- Name -->
        <div class="form-field opacity-0">
          <label class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
            Name
          </label>
          <input
            type="text"
            name="name"
            bind:value={formData.name}
            required
            class="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors"
            class:border-red-500={errors.name}
            placeholder="Your name"
          />
          {#if errors.name}
            <p class="text-red-400 text-xs mt-1">{errors.name}</p>
          {/if}
        </div>

        <!-- Phone + Email row -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div class="form-field opacity-0">
            <label class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
              Phone
            </label>
            <input
              type="tel"
              name="phone"
              bind:value={formData.phone}
              required
              class="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors"
              class:border-red-500={errors.phone}
              placeholder="(780) 555-0199"
            />
            {#if errors.phone}
              <p class="text-red-400 text-xs mt-1">{errors.phone}</p>
            {/if}
          </div>

          <div class="form-field opacity-0">
            <label class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
              Email
            </label>
            <input
              type="email"
              name="email"
              bind:value={formData.email}
              class="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors"
              class:border-red-500={errors.email}
              placeholder="you@email.com"
            />
            {#if errors.email}
              <p class="text-red-400 text-xs mt-1">{errors.email}</p>
            {/if}
          </div>
        </div>

        <!-- Service select -->
        <div class="form-field opacity-0">
          <label class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
            Service Needed
          </label>
          <select
            name="service"
            bind:value={formData.service}
            required
            class="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text focus:outline-none focus:border-yeg-amber/50 transition-colors appearance-none cursor-pointer"
            class:border-red-500={errors.service}
          >
            <option value="">Select a service</option>
            <option value="water">Water Damage Restoration</option>
            <option value="fire">Fire Damage Restoration</option>
            <option value="mold">Mold Removal</option>
            <option value="storm">Storm Damage Repair</option>
            <option value="construction">Construction Services</option>
            <option value="contents">Contents Restoration</option>
            <option value="biohazard">Biohazard Cleaning</option>
            <option value="asbestos">Asbestos Abatement</option>
            <option value="other">Other Emergency</option>
          </select>
          {#if errors.service}
            <p class="text-red-400 text-xs mt-1">{errors.service}</p>
          {/if}
        </div>

        <!-- Message -->
        <div class="form-field opacity-0">
          <label class="block text-xs text-yeg-text-secondary uppercase tracking-wider mb-2">
            Message
          </label>
          <textarea
            name="message"
            bind:value={formData.message}
            rows={4}
            class="w-full bg-yeg-bg border border-white/10 rounded-lg px-4 py-3 text-yeg-text placeholder-yeg-text-secondary/50 focus:outline-none focus:border-yeg-amber/50 transition-colors resize-none"
            placeholder="Describe the emergency..."
          ></textarea>
        </div>

        <!-- Submit -->
        <div class="form-field opacity-0 pt-2">
          <button type="submit" class="cta-primary w-full justify-center">
            <Send size={16} />
            <span>Send Request</span>
          </button>
        </div>

        <p class="form-field opacity-0 text-xs text-yeg-text-secondary text-center">
          We never share your info. Emergency calls always prioritized.
        </p>
      </div>
    </form>
  {/if}
</div>
