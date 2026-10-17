import { describeUnknownError, err, ok, type Result } from './result.js';
import type { FetchLike } from './port.js';

/** Default limit for one AI call; local GPUs and image models can be slow. */
export const DEFAULT_AI_TIMEOUT_MS = 120_000;

/** The longest an error body or JSON reply may be before reading stops. */
export const MAX_TEXT_BYTES: number = 8 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** The most redirects followed when a caller allows any. */
const MAX_REDIRECTS = 3;

export interface CallProviderOptions {
  /**
   * Redirects are not followed by default: a redirect would carry the
   * request body (prompts, images) to wherever `Location` points. A caller
   * that expects one passes a check that gets the absolute target and
   * returns the URL to follow, or an error; every hop goes through it.
   * Only for requests without a body.
   */
  readonly followRedirect?: (target: string) => Result<string>;
}

/** `https://host:port` for a message, or a fallback when `url` isn't absolute. */
function describeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'the configured address';
  }
}

function isRedirect(response: Response): boolean {
  return (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  );
}

/**
 * One HTTP call to an AI provider, with a timeout (combined with the
 * caller's signal) and errors that name the provider, what was being done,
 * the HTTP status and the provider's own message. A bad `timeoutMs` or URL
 * is an error, not an exception, and redirects are refused (see
 * CallProviderOptions).
 */
export async function callProvider(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs: number,
  signal?: AbortSignal,
  options: CallProviderOptions = {}
): Promise<Result<Response>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2 ** 31 - 1) {
    return err(
      `${what}: timeoutMs must be a number of milliseconds from 0 to ${2 ** 31 - 1}, not ${timeoutMs}`
    );
  }
  const timeout: AbortSignal = AbortSignal.timeout(timeoutMs);
  const combined: AbortSignal =
    signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let target: string = url;
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(target, {
        ...init,
        redirect: 'manual',
        signal: combined,
      });
    } catch (cause: unknown) {
      if (timeout.aborted) {
        return err(
          `${what} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`
        );
      }
      if (signal?.aborted === true) return err(`${what} was cancelled`);
      return err(
        `Could not reach ${what} at ${describeOrigin(target)}: ${describeUnknownError(cause)}. Is it running?`,
        cause
      );
    }
    if (isRedirect(response)) {
      await response.body?.cancel().catch(() => undefined);
      const rawLocation: string | null = response.headers.get('location');
      let next: string | null = null;
      if (rawLocation !== null) {
        try {
          next = new URL(rawLocation, target).toString();
        } catch {
          next = null;
        }
      }
      const status: string =
        response.type === 'opaqueredirect'
          ? 'a redirect'
          : `HTTP ${response.status}`;
      if (options.followRedirect === undefined || next === null) {
        return err(
          `${what} answered with a redirect (${status})${next === null ? '' : ` to ${describeOrigin(next)}`}; redirects aren't followed, so check the address.`
        );
      }
      if (hop >= MAX_REDIRECTS) {
        return err(`${what} redirected more than ${MAX_REDIRECTS} times`);
      }
      const allowed = options.followRedirect(next);
      if (!allowed.ok) return allowed;
      target = allowed.value;
      continue;
    }
    if (!response.ok) {
      const text = await readText(response, what, MAX_ERROR_BODY_BYTES, true);
      return err(
        `${what} failed (HTTP ${response.status}): ${providerMessage(text.ok ? text.value : '')}`
      );
    }
    return ok(response);
  }
}

/**
 * Reads at most `maxBytes` of a body, then stops and cancels the rest, so a
 * huge or endless reply can't fill memory. A read that fails (cancelled,
 * cut off) is an error. With `truncate`, going over the cap returns what
 * was read instead of an error.
 */
export async function readBytes(
  response: Response,
  what: string,
  maxBytes: number,
  truncate = false
): Promise<Result<Uint8Array>> {
  const declared: number = Number(response.headers.get('content-length'));
  if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return err(tooLarge(what, declared, maxBytes));
  }
  if (response.body === null) return ok(new Uint8Array());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) {
        if (truncate) {
          chunks.push(value.subarray(0, maxBytes - total));
          total = maxBytes;
          break;
        }
        return err(tooLarge(what, total + value.length, maxBytes));
      }
      chunks.push(value);
      total += value.length;
    }
  } catch (cause: unknown) {
    return err(
      `${what}: reading the reply failed: ${describeUnknownError(cause)}`,
      cause
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return ok(bytes);
}

function tooLarge(what: string, size: number, maxBytes: number): string {
  return `${what}: the reply is ${(size / 1024 / 1024).toFixed(1)} MB or more; the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`;
}

/** A body as text, read with the same cap as readBytes. */
async function readText(
  response: Response,
  what: string,
  maxBytes: number,
  truncate = false
): Promise<Result<string>> {
  const bytes = await readBytes(response, what, maxBytes, truncate);
  return bytes.ok ? ok(new TextDecoder().decode(bytes.value)) : bytes;
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
      errors?: unknown;
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
    // Stability AI: {"name":"...","errors":["..."]}.
    if (Array.isArray(parsed.errors)) {
      const messages: string[] = parsed.errors.filter(
        (entry: unknown): entry is string => typeof entry === 'string'
      );
      if (messages.length > 0) return messages.join('; ');
    }
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
  const read = await readText(response, what, MAX_TEXT_BYTES);
  if (!read.ok) return read;
  const text: string = read.value;
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

/** True once the caller's signal has fired. */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Loads an optional peer package, or explains how to install it. A failed
 * load is not cached, so installing the package fixes it without a restart.
 * `needs` names the provider and package ("The Claude provider needs the
 * optional package @anthropic-ai/sdk").
 */
export async function loadOptionalPackage<T>(
  loader: () => Promise<T>,
  providerLabel: string,
  packageName: string,
  versionNote: string = ''
): Promise<Result<T>> {
  try {
    return ok(await loader());
  } catch (cause: unknown) {
    return err(
      `The ${providerLabel} provider needs the optional package ${packageName}${versionNote}; ` +
        `install it (e.g. bun add ${packageName}). Loading it failed: ${describeUnknownError(cause)}`,
      cause
    );
  }
}

type ErrorClass = abstract new (...args: never[]) => Error;

/** The error classes an SDK (`openai`, `@anthropic-ai/sdk`) throws, by name. */
export interface SdkErrorClasses {
  readonly APIError: ErrorClass;
  readonly AuthenticationError: ErrorClass;
  readonly PermissionDeniedError: ErrorClass;
  readonly NotFoundError: ErrorClass;
  readonly RateLimitError: ErrorClass;
}

/** The SDKs prefix their messages with the status ("400 Bad ..."); the status is already in ours. */
function messageWithoutStatus(cause: Error): string {
  const status: unknown = (cause as { status?: unknown }).status;
  return typeof status === 'number'
    ? cause.message.replace(new RegExp(`^${status} `), '')
    : cause.message;
}

/**
 * A specific message for an SDK error: the status, the provider's message,
 * and the likely fix. `keyHelp` finishes the sentence for a rejected key.
 */
export function describeSdkError(
  classes: SdkErrorClasses,
  what: string,
  cause: unknown,
  keyHelp: string
): string {
  if (cause instanceof classes.AuthenticationError) {
    return `${what} was refused (401): the API key isn't valid; ${keyHelp}.`;
  }
  if (cause instanceof classes.PermissionDeniedError) {
    return `${what} was refused (403): ${messageWithoutStatus(cause)}`;
  }
  if (cause instanceof classes.NotFoundError) {
    return `${what} failed (404): ${messageWithoutStatus(cause)}. Check the model name.`;
  }
  if (cause instanceof classes.RateLimitError) {
    return `${what} was rate limited (429): ${messageWithoutStatus(cause)}. Try again shortly.`;
  }
  if (cause instanceof classes.APIError) {
    const status: unknown = (cause as { status?: unknown }).status;
    return `${what} failed (${typeof status === 'number' ? status : 'no status'}): ${messageWithoutStatus(cause)}`;
  }
  return `${what} failed: ${describeUnknownError(cause)}`;
}
