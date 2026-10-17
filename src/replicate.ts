import {
  DEFAULT_AI_TIMEOUT_MS,
  callProvider,
  isAborted,
  readBytes,
  readJson,
  toBase64,
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

export const REPLICATE_API_URL = 'https://api.replicate.com/v1';
/** An image-editing model that takes `prompt` and `input_image`. */
export const DEFAULT_REPLICATE_IMAGE_MODEL =
  'black-forest-labs/flux-kontext-pro';

/** How long one prediction may run before it is cancelled. */
const REPLICATE_RUN_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
/** Replicate holds the first request open this long, so quick runs need no polling. */
const WAIT_SECONDS = 30;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;

export interface ReplicateImageOptions {
  /** A Replicate API token. Passed in, never read from the environment. */
  readonly apiKey: string;
  /**
   * `owner/name` (the model's latest version) or `owner/name:version`.
   * Defaults to DEFAULT_REPLICATE_IMAGE_MODEL.
   */
  readonly model?: string;
  /** The model's input name for the image to edit. Default `input_image`. */
  readonly imageInput?: string;
  /** The model's input name for the prompt. Default `prompt`. */
  readonly promptInput?: string;
  /**
   * The model's input name for extra reference images (a list). Left out,
   * a request with more than one image is refused.
   */
  readonly referenceImagesInput?: string;
  /** Other inputs sent with every request, e.g. `{ output_format: 'png' }`. */
  readonly input?: Readonly<Record<string, unknown>>;
  /** How long one prediction may run. Default 5 minutes. */
  readonly runTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
  /** For tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface ModelRef {
  /** Path under /v1 that creates the prediction. */
  readonly path: string;
  /** Extra body fields (the version, when one is pinned). */
  readonly body: Readonly<Record<string, unknown>>;
}

function parseModel(model: string): Result<ModelRef> {
  const [name = '', version, ...extra] = model.split(':');
  if (extra.length > 0 || !/^[\w.-]+\/[\w.-]+$/.test(name) || version === '') {
    return err(
      `Replicate model "${model}" isn't valid; use "owner/name" or "owner/name:version".`
    );
  }
  return version === undefined
    ? ok({ path: `/models/${name}/predictions`, body: {} })
    : ok({ path: '/predictions', body: { version } });
}

function toDataUri(image: AiImage, label: string): Result<string> {
  const checked: Result<AiImage> = checkImageInput(image, label, 'Replicate');
  if (!checked.ok) return checked;
  return ok(`data:${image.mimeType};base64,${toBase64(image.data)}`);
}

interface Prediction {
  readonly id: string;
  readonly status: string;
  readonly output: unknown;
  readonly error: string | null;
}

function readPrediction(body: unknown, what: string): Result<Prediction> {
  const record = (body ?? {}) as Record<string, unknown>;
  const { id, status, output, error } = record;
  if (typeof id !== 'string' || id === '' || typeof status !== 'string') {
    return err(`${what} returned a prediction without an id or status`);
  }
  return ok({
    id,
    status,
    output,
    error: typeof error === 'string' && error !== '' ? error : null,
  });
}

/** The first output URL: models return one URL or a list of them. */
function firstOutputUrl(output: unknown): string | null {
  const first: unknown = Array.isArray(output) ? output[0] : output;
  return typeof first === 'string' && first !== '' ? first : null;
}

/** Output files are served over HTTPS from replicate.delivery; nothing else is fetched. */
function checkOutputUrl(url: string, what: string): Result<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return err(`${what} returned an output that isn't a URL: ${url}`);
  }
  const host: string = parsed.hostname;
  if (
    parsed.protocol !== 'https:' ||
    (host !== 'replicate.delivery' && !host.endsWith('.replicate.delivery'))
  ) {
    return err(
      `${what} returned an output URL on ${parsed.origin}, which isn't replicate.delivery; it was not downloaded.`
    );
  }
  return ok(parsed.toString());
}

/**
 * Image edits with a Replicate model. It creates a prediction, polls until
 * it finishes, then downloads the output; a prediction that is cancelled
 * by the caller or runs too long is cancelled on Replicate too. The first
 * image is the one edited. Models differ in their input names, so the
 * image and prompt inputs are options. There is one mode, named after the
 * model.
 */
export class ReplicateImageGenerator implements ImageGenerator {
  readonly provider = 'replicate';
  readonly model: string;
  // Runtime-private, so the key stays out of JSON, spreads and logs.
  readonly #apiKey: string;
  readonly #imageInput: string;
  readonly #promptInput: string;
  readonly #referenceImagesInput: string | undefined;
  readonly #input: Readonly<Record<string, unknown>>;
  readonly #runTimeoutMs: number;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: ReplicateImageOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_REPLICATE_IMAGE_MODEL;
    this.#imageInput = options.imageInput ?? 'input_image';
    this.#promptInput = options.promptInput ?? 'prompt';
    this.#referenceImagesInput = options.referenceImagesInput;
    this.#input = options.input ?? {};
    this.#runTimeoutMs = options.runTimeoutMs ?? REPLICATE_RUN_TIMEOUT_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  listModes(): Promise<Result<readonly string[]>> {
    return Promise.resolve(ok([this.model]));
  }

  async generateImage(request: ImageRequest): Promise<Result<ImageResult>> {
    const what = `Replicate (model "${this.model}")`;
    const apiKey: string = this.#apiKey.trim();
    if (apiKey === '') {
      return err(
        'No Replicate API token is set; create one at replicate.com/account/api-tokens and pass it as apiKey.'
      );
    }
    if (request.mode !== null && request.mode !== this.model) {
      return err(
        `${what} has no mode "${request.mode}"; its only mode is "${this.model}".`
      );
    }
    const model = parseModel(this.model);
    if (!model.ok) return model;
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
    // Replicate models take no system prompt, so the rules lead the prompt.
    const prompt: string = promptWithInstructions(
      request.instructions,
      request.prompt
    );

    // The run's clock starts before the create request, which can itself be
    // held open for up to WAIT_SECONDS.
    const deadline: number = this.#now() + this.#runTimeoutMs;
    const created = await this.#create(
      model.value,
      {
        ...this.#input,
        [this.#promptInput]: prompt,
        [this.#imageInput]: image.value,
        ...(this.#referenceImagesInput !== undefined && references.length > 0
          ? { [this.#referenceImagesInput]: references }
          : {}),
      },
      apiKey,
      what,
      request.signal
    );
    if (!created.ok) return created;
    const finished = await this.#finish(
      created.value,
      deadline,
      apiKey,
      what,
      request.signal
    );
    if (!finished.ok) return finished;

    const url: string | null = firstOutputUrl(finished.value.output);
    if (url === null) return err(`${what} finished without an output image`);
    const checked = checkOutputUrl(url, what);
    if (!checked.ok) return checked;
    const downloaded = await this.#download(
      checked.value,
      what,
      request.signal
    );
    if (!downloaded.ok) return downloaded;
    return ok({ image: downloaded.value, notes: null });
  }

  #headers(apiKey: string): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };
  }

  async #create(
    model: ModelRef,
    input: Record<string, unknown>,
    apiKey: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<Prediction>> {
    const response = await callProvider(
      this.#fetch,
      `${REPLICATE_API_URL}${model.path}`,
      {
        method: 'POST',
        headers: { ...this.#headers(apiKey), prefer: `wait=${WAIT_SECONDS}` },
        body: JSON.stringify({ ...model.body, input }),
      },
      what,
      this.#timeoutMs,
      signal
    );
    if (!response.ok) return response;
    const body = await readJson(response.value, what);
    if (!body.ok) return body;
    return readPrediction(body.value, what);
  }

  /** Polls until the prediction succeeds; cancels it on Replicate if we stop waiting. */
  async #finish(
    created: Prediction,
    deadline: number,
    apiKey: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<Prediction>> {
    let current: Prediction = created;
    for (;;) {
      switch (current.status) {
        case 'succeeded':
          return ok(current);
        case 'failed':
          return err(`${what} failed: ${current.error ?? 'no details'}`);
        case 'canceled':
          return err(`${what} was canceled on Replicate`);
        default:
          break; // starting or processing
      }
      await this.#sleep(POLL_INTERVAL_MS);
      if (isAborted(signal)) {
        await this.#cancel(current.id, apiKey);
        return err(`${what} was cancelled`);
      }
      if (this.#now() >= deadline) {
        await this.#cancel(current.id, apiKey);
        return err(
          `${what} didn't finish within ${Math.round(this.#runTimeoutMs / 1000)} s and was cancelled.`
        );
      }
      const response = await callProvider(
        this.#fetch,
        `${REPLICATE_API_URL}/predictions/${encodeURIComponent(current.id)}`,
        { method: 'GET', headers: this.#headers(apiKey) },
        `Reading ${what}'s progress`,
        this.#timeoutMs,
        signal
      );
      if (!response.ok) {
        if (isAborted(signal)) {
          await this.#cancel(current.id, apiKey);
        }
        return response;
      }
      const body = await readJson(response.value, what);
      if (!body.ok) return body;
      const next = readPrediction(body.value, what);
      if (!next.ok) return next;
      current = next.value;
    }
  }

  /** Best effort, so an abandoned prediction stops costing money; the outcome is ignored. */
  async #cancel(id: string, apiKey: string): Promise<void> {
    await callProvider(
      this.#fetch,
      `${REPLICATE_API_URL}/predictions/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', headers: this.#headers(apiKey) },
      'Cancelling the Replicate prediction',
      this.#timeoutMs
    );
  }

  async #download(
    url: string,
    what: string,
    signal: AbortSignal | undefined
  ): Promise<Result<AiImage>> {
    const label = `Downloading ${what}'s output`;
    // No credentials: the output URL is public.
    const response = await callProvider(
      this.#fetch,
      url,
      { method: 'GET' },
      label,
      this.#timeoutMs,
      signal,
      // A redirect is followed only to another replicate.delivery URL.
      { followRedirect: (target) => checkOutputUrl(target, what) }
    );
    if (!response.ok) return response;
    const bytes = await readBytes(response.value, label, MAX_OUTPUT_BYTES);
    if (!bytes.ok) return bytes;
    const data: Uint8Array = bytes.value;
    if (data.length === 0) return err(`${label}: the image is empty`);
    return checkImageOutput(data, label);
  }
}
