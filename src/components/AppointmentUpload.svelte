<script lang="ts">
  /**
   * The photo uploader for a phone booking (BK-34a).
   *
   * Used on two surfaces, deliberately the same component on both:
   *
   *   - `/upload/<token>/`, the page the customer opens from an SMS;
   *   - the admin appointment detail page, as the fallback for an agent who
   *     already has the photos in their inbox.
   *
   * The admin arm is why there is no multipart proxy anywhere in this feature.
   * Posting a 100 MB video through a serverless function is the shape
   * `booking-files.ts` already rejects on the read side, and it would be a
   * second upload path to keep correct. Instead the admin page mints a token
   * server-side — it is already behind the middleware — and renders this.
   *
   * WRITE-ONLY BY CONSTRUCTION. It never lists what is already attached.
   * Whoever holds the link holds the link, and an upload capability must not
   * become a read capability for the previous customer's damage photos.
   *
   * `upload()` resolving is what "attached" means. `upload_state` is never read
   * here for the reason the booking form documents: `onUploadCompleted` does
   * not fire against localhost, so in dev every row stays 'pending' while the
   * file is genuinely there.
   */
  import { upload } from '@vercel/blob/client';

  import {
    ALLOWED_UPLOAD_TYPES,
    APPOINTMENT_UPLOAD_ENDPOINT,
    MAX_FILES_PER_BOOKING,
    MAX_FILE_BYTES,
  } from '../lib/booking-config';
  import { buildUploadPathname, formatBytes } from '../lib/booking-uploads';
  import { checkFileAcceptance, SUPPORT_PHONE } from '../lib/booking-form';

  type Props = {
    /** The signed appointment upload token. The whole authorization. */
    token: string;
    /** The draft id inside that token — the prefix every file here lands under. */
    draftId: string;
    /** Muted chrome on the admin surface, full instructions on the customer's. */
    variant?: 'customer' | 'admin';
  };

  const { token, draftId, variant = 'customer' }: Props = $props();

  /** Above this, a dropped connection would otherwise restart the whole file. */
  const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024;

  // Both MIME types and extensions: browsers routinely report no type at all
  // for HEIC, and a types-only accept list hides every iPhone photo behind "no
  // files available".
  const ACCEPT = [...ALLOWED_UPLOAD_TYPES, '.heic', '.heif', '.mov'].join(',');

  type Attachment = {
    id: string;
    name: string;
    size: number;
    contentType: string;
    /** Reused on retry — regenerating it would burn a second slot against the quota. */
    pathname: string;
    status: 'uploading' | 'done' | 'failed';
    progress: number;
    message: string;
  };

  let attachments = $state<Attachment[]>([]);
  let notice = $state('');

  const pendingFiles = new Map<string, File>();
  const uploadAborts = new Map<string, AbortController>();

  const doneCount = $derived(attachments.filter((a) => a.status === 'done').length);

  async function onPick(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const chosen = Array.from(input.files ?? []);
    input.value = ''; // so re-picking the same file fires change again
    notice = '';

    for (const file of chosen) {
      // The client's copy of the caps. The server's is the enforcement — but
      // the Blob SDK discards the server's message, so this is the only one
      // anybody reads.
      const verdict = checkFileAcceptance(
        file,
        attachments.map((a) => ({ size: a.size })),
      );
      if (!verdict.ok) {
        notice = `${file.name}: ${verdict.message}`;
        continue;
      }

      const id = crypto.randomUUID();
      pendingFiles.set(id, file);
      attachments = [
        ...attachments,
        {
          id,
          name: file.name,
          size: file.size,
          contentType: verdict.contentType,
          pathname: buildUploadPathname(draftId, verdict.contentType),
          status: 'uploading',
          progress: 0,
          message: '',
        },
      ];
      await send(id);
    }
  }

  async function send(id: string) {
    const file = pendingFiles.get(id);
    const entry = attachments.find((a) => a.id === id);
    if (!file || !entry) return;
    // A second Retry click before the first re-render would otherwise start two
    // concurrent PUTs to one pathname, which `allowOverwrite: false` rejects.
    if (uploadAborts.has(id)) return;

    const controller = new AbortController();
    uploadAborts.set(id, controller);
    entry.status = 'uploading';
    entry.message = '';
    entry.progress = 0;

    try {
      await upload(entry.pathname, file, {
        access: 'private',
        handleUploadUrl: APPOINTMENT_UPLOAD_ENDPOINT,
        contentType: entry.contentType,
        clientPayload: JSON.stringify({
          uploadToken: token,
          size: file.size,
          originalName: file.name,
        }),
        multipart: file.size > MULTIPART_THRESHOLD_BYTES,
        abortSignal: controller.signal,
        onUploadProgress: (e: { percentage: number }) => {
          entry.progress = Math.round(e.percentage);
        },
      });
      entry.status = 'done';
      entry.progress = 100;
    } catch {
      // The SDK throws one fixed string for every server-side rejection and
      // discards the message the route wrote, so there is nothing specific to
      // show. Ours is at least true.
      entry.status = 'failed';
      entry.message = controller.signal.aborted ? 'Skipped.' : "That upload didn't finish.";
    } finally {
      uploadAborts.delete(id);
    }
  }

  function skip(id: string) {
    uploadAborts.get(id)?.abort();
  }

  function remove(id: string) {
    uploadAborts.get(id)?.abort();
    pendingFiles.delete(id);
    attachments = attachments.filter((a) => a.id !== id);
  }
</script>

<div class={variant === 'admin' ? 'text-sm' : ''}>
  <label
    class="inline-flex items-center gap-2 cursor-pointer rounded-lg px-4 py-2.5 font-semibold transition-colors
      {variant === 'admin'
      ? 'bg-zinc-800 hover:bg-zinc-700 text-white text-sm'
      : 'bg-amber-500 hover:bg-amber-400 text-zinc-950'}"
  >
    <input type="file" accept={ACCEPT} multiple class="sr-only" onchange={onPick} />
    Choose photos or video
  </label>

  <p class={variant === 'admin' ? 'text-zinc-600 text-xs mt-2' : 'text-zinc-400 text-sm mt-3'}>
    Up to {MAX_FILES_PER_BOOKING} files, {formatBytes(MAX_FILE_BYTES)} each.
  </p>

  {#if notice}
    <p class="text-amber-400 text-sm mt-3">{notice}</p>
  {/if}

  {#if attachments.length > 0}
    <ul class="mt-4 divide-y divide-zinc-800/60 text-sm">
      {#each attachments as file (file.id)}
        <li class="py-2.5 flex items-center justify-between gap-4">
          <span class="min-w-0">
            <span class="block truncate text-white">{file.name}</span>
            <span class="block text-xs text-zinc-500">
              {formatBytes(file.size)}
              {#if file.status === 'uploading'}· {file.progress}%{/if}
              {#if file.status === 'done'}· sent{/if}
              {#if file.status === 'failed'}· {file.message}{/if}
            </span>
          </span>
          <span class="shrink-0 flex items-center gap-3 text-xs">
            {#if file.status === 'uploading'}
              <button type="button" class="text-zinc-500 hover:text-zinc-300" onclick={() => skip(file.id)}>
                Skip
              </button>
            {:else if file.status === 'failed'}
              <button type="button" class="text-amber-400 hover:text-amber-300" onclick={() => send(file.id)}>
                Retry
              </button>
              <button type="button" class="text-zinc-500 hover:text-zinc-300" onclick={() => remove(file.id)}>
                Remove
              </button>
            {:else}
              <span class="text-emerald-400">✓</span>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if doneCount > 0 && variant === 'customer'}
    <!--
      The only completion signal there is. There is no submit button on this
      page: a file is attached the moment `upload()` resolves, so a "done"
      button would either be a no-op or would imply the earlier files were not
      really sent.
    -->
    <p class="mt-5 rounded-lg bg-emerald-950/40 border border-emerald-900/60 px-4 py-3 text-emerald-300">
      Got them — {doneCount}
      {doneCount === 1 ? 'file is' : 'files are'} with our office. You can close this page, or add more
      above. Questions? Call or text {SUPPORT_PHONE}.
    </p>
  {/if}
</div>
