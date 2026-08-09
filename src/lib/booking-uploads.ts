/**
 * Upload pathname rules, shared by the browser and the server.
 *
 * Deliberately free of any `@vercel/blob` import so it can be pulled into a
 * Svelte island without dragging the SDK into the client bundle.
 *
 * Vercel Blob lets the *client* choose the pathname it uploads to, so the
 * server must not trust it. Every pathname has to sit under the prefix of a
 * draft the server signed, and the extension has to be one we accept. The
 * extension then determines the single content type the token permits, which
 * Blob itself enforces against the real upload.
 */

import { ALLOWED_UPLOAD_TYPES, UPLOAD_EXTENSIONS } from './booking-config';

export const UPLOAD_ROOT = 'bookings';

/**
 * Reverse of `UPLOAD_EXTENSIONS`. Exported because the browser needs it too:
 * some browsers report `file.type` as `''` for HEIC, and the island falls back
 * to the filename extension rather than telling an iPhone owner their photo is
 * unsupported.
 */
export const EXTENSION_TO_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(UPLOAD_EXTENSIONS).map(([type, ext]) => [ext, type]),
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isAllowedContentType(contentType: string): boolean {
  return ALLOWED_UPLOAD_TYPES.includes(contentType);
}

export function draftPrefix(draftId: string): string {
  return `${UPLOAD_ROOT}/${draftId}/`;
}

/**
 * Pathname for a new upload. Called in the browser; `addRandomSuffix` is off
 * so the value the server records at token-mint time is the final one.
 */
export function buildUploadPathname(draftId: string, contentType: string): string {
  const ext = UPLOAD_EXTENSIONS[contentType];
  if (!ext) throw new Error(`Unsupported content type: ${contentType}`);
  return `${draftPrefix(draftId)}${crypto.randomUUID()}.${ext}`;
}

export type ParsedUploadPathname = {
  draftId: string;
  fileId: string;
  extension: string;
  contentType: string;
};

/**
 * Validate a client-supplied pathname against a draft id the server has
 * already verified. Returns null on anything unexpected — an unknown
 * extension, a mismatched draft, path traversal, extra nesting.
 */
export function parseUploadPathname(
  pathname: unknown,
  draftId: string,
): ParsedUploadPathname | null {
  if (typeof pathname !== 'string') return null;
  if (pathname.includes('..') || pathname.includes('//')) return null;

  const prefix = draftPrefix(draftId);
  if (!pathname.startsWith(prefix)) return null;

  const filename = pathname.slice(prefix.length);
  if (filename.includes('/')) return null;

  const dot = filename.lastIndexOf('.');
  if (dot < 1) return null;

  const fileId = filename.slice(0, dot);
  const extension = filename.slice(dot + 1).toLowerCase();
  if (!UUID_RE.test(fileId)) return null;

  const contentType = EXTENSION_TO_TYPE[extension];
  if (!contentType) return null;

  return { draftId, fileId, extension, contentType };
}

/** Human-readable size, for form validation messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
