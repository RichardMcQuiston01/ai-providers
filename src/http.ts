import { describeUnknownError, err, ok, type Result } from './result.js';
import type { FetchLike } from './port.js';

/** Default limit for one AI call; local GPUs and image models can be slow. */
export const DEFAULT_AI_TIMEOUT_MS = 120_000;

/**
 * One HTTP call to an AI provider, with a timeout (combined with the
 * caller's signal) and errors that name the provider, what was being done,
 * the HTTP status and the provider's own message.
 */
export async function callProvider(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Result<Response>> {
  const timeout: AbortSignal = AbortSignal.timeout(timeoutMs);
  const combined: AbortSignal =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: combined });
  } catch (cause: unknown) {
    if (timeout.aborted) {
      return err(
        `${what} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`
      );
    }
    if (signal?.aborted === true) return err(`${what} was cancelled`);
    return err(
      `Could not reach ${what} at ${new URL(url).origin}: ${describeUnknownError(cause)}. Is it running?`,
      cause
    );
  }
  if (!response.ok) {
    const text: string = await response.text().catch(() => '');
    return err(
      `${what} failed (HTTP ${response.status}): ${providerMessage(text)}`
    );
  }
  return ok(response);
}

/** The useful part of an error body: `error`/`message` from JSON, else the text, shortened. */
export function providerMessage(body: string): string {
  const trimmed: string = body.trim();
  if (trimmed === '') return 'no details';
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: unknown;
      message?: unknown;
      detail?: unknown;
    };
    const error: unknown = parsed.error;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
      const message: unknown = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
    // Replicate: {"title":"Unauthenticated","detail":"...","status":401}.
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    // Not JSON; use the text.
  }
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** Reads a JSON body, naming the call when it isn't JSON. */
export async function readJson(
  response: Response,
  what: string
): Promise<Result<unknown>> {
  const text: string = await response.text().catch(() => '');
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return err(
      `${what} returned something that isn't JSON: ${providerMessage(text)}`
    );
  }
}

/** Bytes → base64 without Buffer, so it runs in browsers too. */
export function toBase64(data: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let start = 0; start < data.length; start += chunkSize) {
    binary += String.fromCharCode(...data.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

/** Base64 → bytes without Buffer; null when the text isn't valid base64. */
export function fromBase64(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
