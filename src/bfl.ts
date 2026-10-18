import {
  DEFAULT_AI_TIMEOUT_MS,
  callProvider,
  downloadImage,
  isAborted,
  pollClock,
  pollPause,
  readJson,
  toBase64,
  type PollClock,
} from './http.js';
import { checkImageInput } from './images.js';
import {
  promptWithInstructions,
  type AiImage,
  type FetchLike,
  type ImageGenerator,
  type ImageRequest,
  type ImageResult,
} from './port.js';
import { err, ok, type Result } from './result.js';

export const BFL_API_URL = 'https://api.bfl.ai/v1';
/** Black Forest Labs' FLUX Kontext editing model; it takes `prompt` and `input_image`. */
export const DEFAULT_BFL_IMAGE_MODEL = 'flux-kontext-pro';

/** How long one task may run before we stop waiting. */
const BFL_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export interface BflImageOptions {
  /** A Black Forest Labs API key. Passed in, never read from the environment. */
  readonly apiKey: string;
  /** The model, e.g. `flux-kontext-pro` or `flux-kontext-max`. Defaults to DEFAULT_BFL_IMAGE_MODEL. */
  readonly model?: string;
  /** The model's input name for the image to edit. Default `input_image`. */
  readonly imageInput?: string;
  /** The model's input name for the prompt. Default `prompt`. */
  readonly promptInput?: string;
  /**
   * The model's input names for extra reference images, one per image, in
   * order (e.g. `['input_image_2', 'input_image_3']`). Left out, a request
   * with more than one image is refused.
   */
  readonly referenceImageInputs?: readonly string[];
  /** Other inputs sent with every request, e.g. `{ output_format: 'png' }`. */
  readonly input?: Readonly<Record<string, unknown>>;
  /**
   * Extra hosts output files may be downloaded from, besides bfl.ai and its
   * subdomains.
   */
  readonly outputHosts?: readonly string[];
  /** How long to wait for one task. Default 5 minutes. */
  readonly runTimeoutMs?: number;
  /** Limit for each HTTP call. Default 120 s. */
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
  /** For tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function toBase64Input(image: AiImage, label: string): Result<string> {
  const checked: Result<AiImage> = checkImageInput(
    image,
    label,
    'Black Forest Labs'
  );
  if (!checked.ok) return checked;
  return ok(toBase64(image.data));
}

function hostMatches(host: string, allowed: string): boolean {
  const name: string = allowed.trim().toLowerCase().replace(/^\*\./, '');
  return name !== '' && (host === name || host.endsWith(`.${name}`));
}

/** The polling URL BFL returns must be HTTPS on bfl.ai (regional hosts included), so the key never goes elsewhere. */
function checkPollingUrl(value: unknown, what: string): Result<string> {
  if (typeof value !== 'string' || value === '') {
    return err(`${what} didn't return a polling_url`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return err(`${what} returned a polling_url that isn't a URL`);
  }
  if (parsed.protocol !== 'https:' || !hostMatches(parsed.hostname, 'bfl.ai')) {
    return err(
      `${what} returned a polling_url on ${parsed.origin}, which isn't bfl.ai; it was not called, so the API key was not sent there.`
    );
  }
  return ok(parsed.toString());
}

/** BFL's own words for the outcomes that end a task without an image. */
function describeFailure(status: string, what: string): string {
  switch (status) {
    case 'Request Moderated':
    case 'Content Moderated':
      return `${what} was declined by Black Forest Labs' moderation (${status}); change the image or prompt.`;
    case 'Task not found':
      return `${what}: Black Forest Labs doesn't know this task (Task not found); it may have expired.`;
    case 'Error':
      return `${what} failed on Black Forest Labs' side (Error).`;
    default:
      return `${what} reported an unexpected status: ${status}`;
  }
}

/**
 * Image edits with Black Forest Labs' FLUX models (FLUX Kontext), straight
 * from the maker. It submits a task, polls its URL until the status is
 * Ready, then downloads the image. The API has no cancel call, so a task
 * we stop waiting for may still run. The first image is the one edited.
 * Models differ in their input names, so the image and prompt inputs are
 * options. There is one mode, named after the model.
 */
export class BflImageGenerator implements ImageGenerator {
  readonly provider = 'bfl';
  readonly model: string;
  // Runtime-private, so the key stays out of JSON, spreads and logs.
  readonly #apiKey: string;
  readonly #imageInput: string;
  readonly #promptInput: string;
  readonly #referenceImageInputs: readonly string[];
  readonly #input: Readonly<Record<string, unknown>>;
  readonly #outputHosts: readonly string[];
  readonly #runTimeoutMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #clock: PollClock;

  constructor(options: BflImageOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_BFL_IMAGE_MODEL;
    this.#imageInput = options.imageInput ?? 'input_image';
    this.#promptInput = options.promptInput ?? 'prompt';
    this.#referenceImageInputs = options.referenceImageInputs ?? [];
    this.#input = options.input ?? {};
    this.#outputHosts = ['bfl.ai', ...(options.outputHosts ?? [])];
    this.#runTimeoutMs = options.runTimeoutMs ?? BFL_RUN_TIMEOUT_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#clock = pollClock(options);
  }

  listModes(): Promise<Result<readonly string[]>> {
    return Promise.resolve(ok([this.model]));
  }

  async generateImage(request: ImageRequest): Promise<Result<ImageResult>> {
    const what = `Black Forest Labs (model "${this.model}")`;
    const apiKey: string = this.#apiKey.trim();
    if (apiKey === '') {
      return err(
        'No Black Forest Labs API key is set; create one at dashboard.bfl.ai and pass it as apiKey.'
      );
    }
    if (request.mode !== null && request.mode !== this.model) {
      return err(
        `${what} has no mode "${request.mode}"; its only mode is "${this.model}".`
      );
    }
    if (!/^[\w.-]+$/.test(this.model)) {
      return err(
        `Black Forest Labs model "${this.model}" isn't valid; use a name such as "flux-kontext-pro".`
      );
    }
    const [first, ...rest] = request.images;
    if (first === undefined) return err(`${what} needs an image to edit.`);
    if (rest.length > this.#referenceImageInputs.length) {
      return err(
        `${what} was given ${request.images.length} images, but referenceImageInputs names ${this.#referenceImageInputs.length} extra input${this.#referenceImageInputs.length === 1 ? '' : 's'}; set it to say where this model takes more images.`
      );
    }
    if (isAborted(request.signal)) return err(`${what} was cancelled`);

    const image = toBase64Input(first, 'The image to edit');
    if (!image.ok) return image;
    const references: Record<string, string> = {};
    for (const [index, reference] of rest.entries()) {
      const encoded = toBase64Input(reference, `Reference image ${index + 1}`);
      if (!encoded.ok) return encoded;
      const name: string | undefined = this.#referenceImageInputs[index];
      if (name !== undefined) references[name] = encoded.value;
    }

    // The run's clock starts before the submit request.
    const deadline: number = this.#clock.now() + this.#runTimeoutMs;
    const pollingUrl = await this.#submit(
      {
        ...this.#input,
        // The API takes no system prompt, so the rules lead the prompt.
        [this.#promptInput]: promptWithInstructions(
          request.instructions,
          request.prompt
        ),
        [this.#imageInput]: image.value,
        ...references,
      },
      apiKey,
      what,
      request.signal
    );
    if (!pollingUrl.ok) return pollingUrl;
    const url = await this.#waitUntilReady(
      pollingUrl.value,
      deadline,
      apiKey,
      what,
      request.signal
    );
    if (!url.ok) return url;
    const downloaded = await this.#download(url.value, what, request.signal);
    if (!downloaded.ok) return downloaded;
    return ok({ image: downloaded.value, notes: null });
  }

  #headers(apiKey: string): Record<string, string> {
    return { 'x-key': apiKey, 'content-type': 'application/json' };
  }

  async #submit(
    input: Record<string, unknown>,
    apiKey: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<string>> {
    const response = await callProvider(
      this.#fetch,
      `${BFL_API_URL}/${this.model}`,
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
    return checkPollingUrl(
      (body.value as { polling_url?: unknown } | null)?.polling_url,
      what
    );
  }

  /** Polls until the task is Ready and returns the image URL from its result. */
  async #waitUntilReady(
    pollingUrl: string,
    deadline: number,
    apiKey: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<string>> {
    for (;;) {
      const response = await callProvider(
        this.#fetch,
        pollingUrl,
        { method: 'GET', headers: this.#headers(apiKey) },
        `Reading ${what}'s progress`,
        this.#timeoutMs,
        signal
      );
      if (!response.ok) return response;
      const body = await readJson(response.value, what);
      if (!body.ok) return body;
      const record = (body.value ?? {}) as {
        status?: unknown;
        result?: { sample?: unknown } | null;
      };
      const status: string =
        typeof record.status === 'string' ? record.status : 'none';
      if (status === 'Ready') {
        const sample: unknown = record.result?.sample;
        return typeof sample === 'string' && sample !== ''
          ? ok(sample)
          : err(`${what} finished without an output image`);
      }
      if (status !== 'Pending') return err(describeFailure(status, what));
      const next = await pollPause(
        this.#clock,
        POLL_INTERVAL_MS,
        deadline,
        signal
      );
      if (next === 'cancelled') return err(`${what} was cancelled`);
      if (next === 'timed out') {
        return err(
          `${what} didn't finish within ${Math.round(this.#runTimeoutMs / 1000)} s; Black Forest Labs has no cancel call, so it may still be running there.`
        );
      }
    }
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
        `${what} returned an output URL on ${parsed.origin}, which isn't bfl.ai (add it to outputHosts if it is yours); it was not downloaded.`
      );
    }
    return ok(parsed.toString());
  }

  async #download(
    url: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<AiImage>> {
    const label = `Downloading ${what}'s output`;
    const checked = this.#checkOutputUrl(url, what);
    if (!checked.ok) return checked;
    // No credentials: the delivery URL is signed. A redirect is followed
    // only to another allowed output host.
    return downloadImage(this.#fetch, checked.value, label, {
      maxBytes: MAX_OUTPUT_BYTES,
      timeoutMs: this.#timeoutMs,
      signal,
      followRedirect: (target) => this.#checkOutputUrl(target, what),
    });
  }
}
