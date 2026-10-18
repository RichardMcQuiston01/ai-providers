import {
  DEFAULT_AI_TIMEOUT_MS,
  callProvider,
  downloadImage,
  fromBase64,
  isAborted,
  pollClock,
  pollPause,
  readJson,
  toBase64,
  type PollClock,
} from './http.js';
import { checkImageInput, checkImageOutput } from './images.js';
import {
  promptWithInstructions,
  type AiImage,
  type FetchLike,
  type ImageGenerator,
  type ImageRequest,
  type ImageResult,
} from './port.js';
import { err, ok, type Result } from './result.js';

export const FAL_QUEUE_URL = 'https://queue.fal.run';
/** An image-editing model that takes `prompt` and `image_url`. */
export const DEFAULT_FAL_IMAGE_MODEL = 'fal-ai/flux-pro/kontext';

/** How long one request may run before it is cancelled. */
const FAL_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
/** Where fal serves output files from, besides anything in `outputHosts`. */
const FAL_OUTPUT_HOSTS: readonly string[] = ['fal.media', 'fal.run'];

export interface FalImageOptions {
  /** A fal API key. Passed in, never read from the environment. */
  readonly apiKey: string;
  /** The endpoint id, e.g. `fal-ai/flux-pro/kontext`. Defaults to DEFAULT_FAL_IMAGE_MODEL. */
  readonly model?: string;
  /** The model's input name for the image to edit. Default `image_url`. */
  readonly imageInput?: string;
  /** The model's input name for the prompt. Default `prompt`. */
  readonly promptInput?: string;
  /**
   * The model's input name for extra reference images (a list of data URIs).
   * Left out, a request with more than one image is refused.
   */
  readonly referenceImagesInput?: string;
  /** Other inputs sent with every request, e.g. `{ output_format: 'png' }`. */
  readonly input?: Readonly<Record<string, unknown>>;
  /**
   * Extra hosts output files may be downloaded from, besides fal.media and
   * fal.run and their subdomains. A leading `*.` is not needed.
   */
  readonly outputHosts?: readonly string[];
  /** How long one request may run. Default 5 minutes. */
  readonly runTimeoutMs?: number;
  /** Limit for each HTTP call. Default 120 s. */
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
  /** For tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface QueuedRequest {
  readonly statusUrl: string;
  readonly responseUrl: string;
  readonly cancelUrl: string;
}

function toDataUri(image: AiImage, label: string): Result<string> {
  const checked: Result<AiImage> = checkImageInput(image, label, 'fal');
  if (!checked.ok) return checked;
  return ok(`data:${image.mimeType};base64,${toBase64(image.data)}`);
}

/** `owner/app` or `owner/app/variant`: path pieces of letters, digits, `.`, `_` and `-`. */
function validModelId(model: string): boolean {
  return /^[\w.-]+(\/[\w.-]+)+$/.test(model);
}

/** A URL fal told us to call must be HTTPS on queue.fal.run, so the key never goes elsewhere. */
function checkQueueUrl(
  value: unknown,
  field: string,
  what: string
): Result<string> {
  if (typeof value !== 'string' || value === '') {
    return err(`${what} didn't return a ${field}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return err(`${what} returned a ${field} that isn't a URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'queue.fal.run') {
    return err(
      `${what} returned a ${field} on ${parsed.origin}, which isn't queue.fal.run; it was not called, so the API key was not sent there.`
    );
  }
  return ok(parsed.toString());
}

function hostMatches(host: string, allowed: string): boolean {
  const name: string = allowed.trim().toLowerCase().replace(/^\*\./, '');
  return name !== '' && (host === name || host.endsWith(`.${name}`));
}

/** The first image URL in a result: `images[0].url` or `image.url`. */
function firstImageUrl(output: unknown): string | null {
  if (typeof output !== 'object' || output === null) return null;
  const record = output as Record<string, unknown>;
  const images: unknown = record['images'];
  const first: unknown = Array.isArray(images) ? images[0] : record['image'];
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null) {
    const url: unknown = (first as Record<string, unknown>)['url'];
    if (typeof url === 'string' && url !== '') return url;
  }
  return null;
}

/**
 * Image edits with a fal model. It submits the request to fal's queue,
 * polls its status until it completes, reads the result, then downloads the
 * image; a request abandoned by the caller or run past `runTimeoutMs` is
 * cancelled on fal too. The first image is the one edited. Models differ in
 * their input names, so the image and prompt inputs are options. There is
 * one mode, named after the endpoint.
 */
export class FalImageGenerator implements ImageGenerator {
  readonly provider = 'fal';
  readonly model: string;
  // Runtime-private, so the key stays out of JSON, spreads and logs.
  readonly #apiKey: string;
  readonly #imageInput: string;
  readonly #promptInput: string;
  readonly #referenceImagesInput: string | undefined;
  readonly #input: Readonly<Record<string, unknown>>;
  readonly #outputHosts: readonly string[];
  readonly #runTimeoutMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #clock: PollClock;

  constructor(options: FalImageOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_FAL_IMAGE_MODEL;
    this.#imageInput = options.imageInput ?? 'image_url';
    this.#promptInput = options.promptInput ?? 'prompt';
    this.#referenceImagesInput = options.referenceImagesInput;
    this.#input = options.input ?? {};
    this.#outputHosts = [...FAL_OUTPUT_HOSTS, ...(options.outputHosts ?? [])];
    this.#runTimeoutMs = options.runTimeoutMs ?? FAL_RUN_TIMEOUT_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#clock = pollClock(options);
  }

  listModes(): Promise<Result<readonly string[]>> {
    return Promise.resolve(ok([this.model]));
  }

  async generateImage(request: ImageRequest): Promise<Result<ImageResult>> {
    const what = `fal (model "${this.model}")`;
    const apiKey: string = this.#apiKey.trim();
    if (apiKey === '') {
      return err(
        'No fal API key is set; create one at fal.ai/dashboard/keys and pass it as apiKey.'
      );
    }
    if (request.mode !== null && request.mode !== this.model) {
      return err(
        `${what} has no mode "${request.mode}"; its only mode is "${this.model}".`
      );
    }
    if (!validModelId(this.model)) {
      return err(
        `fal model "${this.model}" isn't valid; use an endpoint id such as "fal-ai/flux-pro/kontext".`
      );
    }
    const [first, ...rest] = request.images;
    if (first === undefined) return err(`${what} needs an image to edit.`);
    if (rest.length > 0 && this.#referenceImagesInput === undefined) {
      return err(
        `${what} was given ${request.images.length} images, but no referenceImagesInput is set to say where this model takes extra images.`
      );
    }
    if (isAborted(request.signal)) return err(`${what} was cancelled`);

    const image = toDataUri(first, 'The image to edit');
    if (!image.ok) return image;
    const references: string[] = [];
    for (const [index, reference] of rest.entries()) {
      const uri = toDataUri(reference, `Reference image ${index + 1}`);
      if (!uri.ok) return uri;
      references.push(uri.value);
    }

    // The run's clock starts before the submit request.
    const deadline: number = this.#clock.now() + this.#runTimeoutMs;
    const queued = await this.#submit(
      {
        ...this.#input,
        // fal models take no system prompt, so the rules lead the prompt.
        [this.#promptInput]: promptWithInstructions(
          request.instructions,
          request.prompt
        ),
        [this.#imageInput]: image.value,
        ...(this.#referenceImagesInput !== undefined && references.length > 0
          ? { [this.#referenceImagesInput]: references }
          : {}),
      },
      apiKey,
      what,
      request.signal
    );
    if (!queued.ok) return queued;
    const finished = await this.#waitUntilComplete(
      queued.value,
      deadline,
      apiKey,
      what,
      request.signal
    );
    if (!finished.ok) return finished;
    const result = await this.#readResult(
      queued.value,
      apiKey,
      what,
      request.signal
    );
    if (!result.ok) return result;

    const url: string | null = firstImageUrl(result.value);
    if (url === null) return err(`${what} finished without an output image`);
    const downloaded = await this.#fetchImage(url, what, request.signal);
    if (!downloaded.ok) return downloaded;
    return ok({ image: downloaded.value, notes: null });
  }

  #headers(apiKey: string): Record<string, string> {
    return {
      authorization: `Key ${apiKey}`,
      'content-type': 'application/json',
    };
  }

  async #submit(
    input: Record<string, unknown>,
    apiKey: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<QueuedRequest>> {
    const response = await callProvider(
      this.#fetch,
      `${FAL_QUEUE_URL}/${this.model}`,
      {
        method: 'POST',
        headers: this.#headers(apiKey),
        body: JSON.stringify(input),
      },
      what,
      this.#timeoutMs,
      signal
    );
    if (!response.ok) return response;
    const body = await readJson(response.value, what);
    if (!body.ok) return body;
    const record = (body.value ?? {}) as Record<string, unknown>;
    const statusUrl = checkQueueUrl(record['status_url'], 'status_url', what);
    if (!statusUrl.ok) return statusUrl;
    const responseUrl = checkQueueUrl(
      record['response_url'],
      'response_url',
      what
    );
    if (!responseUrl.ok) return responseUrl;
    const cancelUrl = checkQueueUrl(record['cancel_url'], 'cancel_url', what);
    if (!cancelUrl.ok) return cancelUrl;
    return ok({
      statusUrl: statusUrl.value,
      responseUrl: responseUrl.value,
      cancelUrl: cancelUrl.value,
    });
  }

  /** Polls the status until COMPLETED; cancels the request on fal if we stop waiting. */
  async #waitUntilComplete(
    queued: QueuedRequest,
    deadline: number,
    apiKey: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<true>> {
    for (;;) {
      const response = await callProvider(
        this.#fetch,
        queued.statusUrl,
        { method: 'GET', headers: this.#headers(apiKey) },
        `Reading ${what}'s progress`,
        this.#timeoutMs,
        signal
      );
      if (!response.ok) {
        if (isAborted(signal)) await this.#cancel(queued, apiKey);
        return response;
      }
      const body = await readJson(response.value, what);
      if (!body.ok) return body;
      const status: unknown = (body.value as { status?: unknown } | null)
        ?.status;
      if (status === 'COMPLETED') return ok(true);
      if (status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') {
        return err(
          `${what} reported an unexpected status: ${typeof status === 'string' ? status : 'none'}`
        );
      }
      const next = await pollPause(
        this.#clock,
        POLL_INTERVAL_MS,
        deadline,
        signal
      );
      if (next === 'cancelled') {
        await this.#cancel(queued, apiKey);
        return err(`${what} was cancelled`);
      }
      if (next === 'timed out') {
        await this.#cancel(queued, apiKey);
        return err(
          `${what} didn't finish within ${Math.round(this.#runTimeoutMs / 1000)} s and was cancelled.`
        );
      }
    }
  }

  /** The result of a completed request; a failed run answers here with an HTTP error. */
  async #readResult(
    queued: QueuedRequest,
    apiKey: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<unknown>> {
    const response = await callProvider(
      this.#fetch,
      queued.responseUrl,
      { method: 'GET', headers: this.#headers(apiKey) },
      what,
      this.#timeoutMs,
      signal
    );
    if (!response.ok) return response;
    return readJson(response.value, what);
  }

  /** Best effort, so an abandoned request stops costing money; the outcome is ignored. */
  async #cancel(queued: QueuedRequest, apiKey: string): Promise<void> {
    await callProvider(
      this.#fetch,
      queued.cancelUrl,
      { method: 'PUT', headers: this.#headers(apiKey) },
      'Cancelling the fal request',
      this.#timeoutMs
    );
  }

  #checkOutputUrl(url: string, what: string): Result<string> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return err(`${what} returned an output that isn't a URL`);
    }
    const host: string = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== 'https:' ||
      !this.#outputHosts.some((allowed) => hostMatches(host, allowed))
    ) {
      return err(
        `${what} returned an output URL on ${parsed.origin}, which isn't fal.media or fal.run (add it to outputHosts if it is yours); it was not downloaded.`
      );
    }
    return ok(parsed.toString());
  }

  /** The image from a result URL: a data URI (sync mode) is decoded, anything else is downloaded. */
  async #fetchImage(
    url: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<AiImage>> {
    const label = `Downloading ${what}'s output`;
    if (url.startsWith('data:')) {
      const encoded: string = url.slice(url.indexOf(',') + 1);
      const data: Uint8Array | null = /;base64,/.test(url)
        ? fromBase64(encoded)
        : null;
      if (data === null || data.length === 0) {
        return err(`${label}: the data URI isn't valid base64`);
      }
      return checkImageOutput(data, label);
    }
    const checked = this.#checkOutputUrl(url, what);
    if (!checked.ok) return checked;
    // No credentials: the output URL is public. A redirect is followed
    // only to another allowed output host.
    return downloadImage(this.#fetch, checked.value, label, {
      maxBytes: MAX_OUTPUT_BYTES,
      timeoutMs: this.#timeoutMs,
      signal,
      followRedirect: (target) => this.#checkOutputUrl(target, what),
    });
  }
}
