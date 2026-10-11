import { DEFAULT_AI_TIMEOUT_MS, fromBase64, toBase64 } from './http.js';
import type {
  AiImage,
  ImageGenerator,
  ImageRequest,
  ImageResult,
  TextGenerator,
  TextRequest,
  TextResult,
} from './port.js';
import { describeUnknownError, err, ok, type Result } from './result.js';

/** The optional peer package the Gemini providers are built on. */
export const GEMINI_PACKAGE = '@richardmcquiston01/gemini-icon-gen';
export const DEFAULT_GEMINI_TEXT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-2.5-flash-image';

const GEMINI_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

interface GeminiInlineImage {
  data: string;
  mimeType: string;
}

/**
 * The part of `@richardmcquiston01/gemini-icon-gen` (0.3.0 or later) these
 * providers call. Inject a fake through `loadModule` in tests.
 */
export interface GeminiModule {
  generateText(request: {
    input: string;
    instructions?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ success: boolean; text?: string; error?: string }>;
  editImage(request: {
    image: GeminiInlineImage;
    prompt: string;
    instructions?: string;
    referenceImages?: GeminiInlineImage[];
    model?: string;
    apiKey?: string;
  }): Promise<{
    success: boolean;
    imageData?: string;
    mimeType?: string;
    text?: string;
    error?: string;
  }>;
}

export type GeminiModuleLoader = () => Promise<GeminiModule>;

export interface GeminiOptions {
  /** A Gemini API key (Google AI Studio). Passed in, never read from the environment. */
  readonly apiKey: string;
  /** Defaults to DEFAULT_GEMINI_TEXT_MODEL / DEFAULT_GEMINI_IMAGE_MODEL. */
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Loads the peer package; replace it in tests. */
  readonly loadModule?: GeminiModuleLoader;
}

const loadGeminiPackage: GeminiModuleLoader = () =>
  import('@richardmcquiston01/gemini-icon-gen');

/**
 * Loads the peer package, or explains how to install it. A failed load is
 * not cached, so installing the package fixes it without a restart.
 */
async function loadModule(
  loader: GeminiModuleLoader
): Promise<Result<GeminiModule>> {
  try {
    return ok(await loader());
  } catch (cause: unknown) {
    return err(
      `The Gemini provider needs the optional package ${GEMINI_PACKAGE} (0.3.0 or later); ` +
        `install it (e.g. bun add ${GEMINI_PACKAGE}). Loading it failed: ${describeUnknownError(cause)}`,
      cause
    );
  }
}

/**
 * Runs one Gemini call with a timeout and the caller's signal. The SDK call
 * itself can't be aborted, so a stopped call is abandoned, not cancelled.
 */
async function runGemini<T>(
  what: string,
  call: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Result<T>> {
  if (signal?.aborted === true) return err(`${what} was cancelled`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<Result<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve(
        err(
          `${what} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`
        )
      );
    }, timeoutMs);
    onAbort = () => resolve(err(`${what} was cancelled`));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const finished: Promise<Result<T>> = call().then(
    (value) => ok(value),
    (cause: unknown) =>
      err(`${what} failed: ${describeUnknownError(cause)}`, cause)
  );
  try {
    return await Promise.race([finished, stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

function checkKey(apiKey: string): Result<string> {
  const key: string = apiKey.trim();
  return key === ''
    ? err(
        'No Gemini API key is set; create one in Google AI Studio and pass it as apiKey.'
      )
    : ok(key);
}

function toInline(image: AiImage, label: string): Result<GeminiInlineImage> {
  if (!GEMINI_IMAGE_TYPES.has(image.mimeType)) {
    return err(
      `${label} is ${image.mimeType}; Gemini takes PNG, JPEG or WebP.`
    );
  }
  if (image.data.length === 0) return err(`${label} is empty.`);
  return ok({ data: toBase64(image.data), mimeType: image.mimeType });
}

/**
 * Text from Gemini, through gemini-icon-gen's `generateText`. The request's
 * instructions are its system instruction; images aren't supported yet.
 */
export class GeminiTextGenerator implements TextGenerator {
  readonly provider = 'gemini';
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly loader: GeminiModuleLoader;

  constructor(options: GeminiOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_GEMINI_TEXT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.loader = options.loadModule ?? loadGeminiPackage;
  }

  async generateText(request: TextRequest): Promise<Result<TextResult>> {
    const what = `Gemini (model "${this.model}")`;
    const key = checkKey(this.apiKey);
    if (!key.ok) return key;
    if (request.images !== undefined && request.images.length > 0) {
      return err(`${what} text generation doesn't take images yet.`);
    }
    // gemini-icon-gen falls back to its own bundled prompt when the
    // instructions are blank, so refuse rather than send someone else's rules.
    if (request.instructions.trim() === '') {
      return err(`${what} needs instructions (the system prompt).`);
    }
    const gemini = await loadModule(this.loader);
    if (!gemini.ok) return gemini;
    const reply = await runGemini(
      what,
      () =>
        gemini.value.generateText({
          input: request.prompt,
          instructions: request.instructions,
          model: this.model,
          apiKey: key.value,
        }),
      this.timeoutMs,
      request.signal
    );
    if (!reply.ok) return reply;
    if (!reply.value.success) {
      return err(`${what}: ${reply.value.error ?? 'no details'}`);
    }
    const text: string = reply.value.text?.trim() ?? '';
    if (text === '') return err(`${what} returned an empty reply`);
    return ok({ text });
  }
}

/**
 * Photo edits with Gemini's image model, through gemini-icon-gen's
 * `editImage`. The first image is the one edited; the rest are references.
 * There is one mode, named after the model.
 */
export class GeminiImageGenerator implements ImageGenerator {
  readonly provider = 'gemini';
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly loader: GeminiModuleLoader;

  constructor(options: GeminiOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_GEMINI_IMAGE_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.loader = options.loadModule ?? loadGeminiPackage;
  }

  listModes(): Promise<Result<readonly string[]>> {
    return Promise.resolve(ok([this.model]));
  }

  async generateImage(request: ImageRequest): Promise<Result<ImageResult>> {
    const what = `Gemini (model "${this.model}")`;
    const key = checkKey(this.apiKey);
    if (!key.ok) return key;
    if (request.mode !== null && request.mode !== this.model) {
      return err(
        `${what} has no mode "${request.mode}"; its only mode is "${this.model}".`
      );
    }
    const [first, ...rest] = request.images;
    if (first === undefined) return err(`${what} needs an image to edit.`);
    const image = toInline(first, 'The image to edit');
    if (!image.ok) return image;
    const references: GeminiInlineImage[] = [];
    for (const [index, reference] of rest.entries()) {
      const inline = toInline(reference, `Reference image ${index + 1}`);
      if (!inline.ok) return inline;
      references.push(inline.value);
    }
    const gemini = await loadModule(this.loader);
    if (!gemini.ok) return gemini;
    const instructions: string = request.instructions.trim();
    const reply = await runGemini(
      what,
      () =>
        gemini.value.editImage({
          image: image.value,
          prompt: request.prompt,
          ...(instructions !== '' ? { instructions } : {}),
          ...(references.length > 0 ? { referenceImages: references } : {}),
          model: this.model,
          apiKey: key.value,
        }),
      this.timeoutMs,
      request.signal
    );
    if (!reply.ok) return reply;
    const { success, imageData, mimeType, text, error } = reply.value;
    if (!success || imageData === undefined) {
      return err(`${what}: ${error ?? 'no image in the reply'}`);
    }
    const data: Uint8Array | null = fromBase64(imageData);
    if (data === null || data.length === 0) {
      return err(`${what} returned image data that isn't valid base64`);
    }
    return ok({
      image: { mimeType: mimeType ?? 'image/png', data },
      notes: text?.trim() || null,
    });
  }
}
