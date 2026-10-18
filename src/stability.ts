import {
  DEFAULT_AI_TIMEOUT_MS,
  callProvider,
  fromBase64,
  readJson,
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

export const STABILITY_API_URL = 'https://api.stability.ai/v2beta';
export const DEFAULT_STABILITY_IMAGE_MODEL = 'sd3.5-large';
export const DEFAULT_STABILITY_STRENGTH = 0.6;

/** A JSON reply carries the image as base64, so the cap is above the image's own. */
const MAX_REPLY_BYTES: number = 40 * 1024 * 1024;

/** The edit modes, named after Stability's endpoints. */
export type StabilityMode =
  | 'image-to-image'
  | 'structure'
  | 'search-and-replace'
  | 'search-and-recolor'
  | 'remove-background';

interface ModeSpec {
  readonly path: string;
  /** Whether the call takes a prompt (remove-background doesn't). */
  readonly usesPrompt: boolean;
}

const MODES: ReadonlyMap<string, ModeSpec> = new Map([
  ['image-to-image', { path: 'stable-image/generate/sd3', usesPrompt: true }],
  ['structure', { path: 'stable-image/control/structure', usesPrompt: true }],
  [
    'search-and-replace',
    { path: 'stable-image/edit/search-and-replace', usesPrompt: true },
  ],
  [
    'search-and-recolor',
    { path: 'stable-image/edit/search-and-recolor', usesPrompt: true },
  ],
  [
    'remove-background',
    { path: 'stable-image/edit/remove-background', usesPrompt: false },
  ],
]);

const DEFAULT_MODE: StabilityMode = 'image-to-image';

/** Form fields the generator sets itself; `input` can't override them. */
const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'image',
  'prompt',
  'mode',
  'model',
  'output_format',
  'search_prompt',
  'select_prompt',
  'strength',
]);

export interface StabilityOptions {
  readonly apiKey: string;
  /** The model for `image-to-image` (sd3.5-large, sd3.5-medium, ...); other modes pick their own. */
  readonly model?: string;
  /** How far `image-to-image` may depart from the image, 0 to 1 (default 0.6). */
  readonly strength?: number;
  /** For `search-and-replace`: what to find in the image; the prompt is what replaces it. */
  readonly searchPrompt?: string;
  /** For `search-and-recolor`: what to recolor; the prompt describes the new colors. */
  readonly selectPrompt?: string;
  /** Extra form fields for every call, e.g. `negative_prompt`, `seed`, `style_preset`. */
  readonly input?: Readonly<Record<string, string | number | boolean>>;
  readonly timeoutMs?: number;
  /** For tests. */
  readonly fetch?: FetchLike;
}

function describeFinishReason(reason: string, what: string): string {
  return reason === 'CONTENT_FILTERED'
    ? `${what} filtered the result (CONTENT_FILTERED); try a different image or prompt.`
    : `${what} finished with "${reason}" instead of SUCCESS.`;
}

/**
 * Image edits with Stability AI's Stable Image API, over plain `fetch`
 * (multipart form data, JSON reply). The API key only goes to
 * `api.stability.ai`. It edits one image, so a request with references is
 * refused. The calls are synchronous, so there is no job to cancel; a
 * timeout or abort drops the connection.
 */
export class StabilityImageGenerator implements ImageGenerator {
  readonly provider = 'stability';
  readonly model: string;
  // Runtime-private, so the key stays out of JSON, spreads and logs.
  readonly #apiKey: string;
  readonly #strength: number;
  readonly #searchPrompt: string;
  readonly #selectPrompt: string;
  readonly #input: Readonly<Record<string, string | number | boolean>>;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: StabilityOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_STABILITY_IMAGE_MODEL;
    this.#strength = options.strength ?? DEFAULT_STABILITY_STRENGTH;
    this.#searchPrompt = options.searchPrompt?.trim() ?? '';
    this.#selectPrompt = options.selectPrompt?.trim() ?? '';
    this.#input = options.input ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  listModes(): Promise<Result<readonly string[]>> {
    return Promise.resolve(ok([...MODES.keys()]));
  }

  async generateImage(request: ImageRequest): Promise<Result<ImageResult>> {
    const modeName: string = request.mode ?? DEFAULT_MODE;
    const what = `Stability AI (${modeName}${modeName === 'image-to-image' ? `, model "${this.model}"` : ''})`;
    const apiKey: string = this.#apiKey.trim();
    if (apiKey === '') {
      return err(
        'No Stability AI API key is set; create one at platform.stability.ai and pass it as apiKey.'
      );
    }
    const spec: ModeSpec | undefined = MODES.get(modeName);
    if (spec === undefined) {
      return err(
        `${what} has no mode "${modeName}"; its modes are ${[...MODES.keys()].join(', ')}.`
      );
    }
    const [first, ...rest] = request.images;
    if (first === undefined) return err(`${what} needs an image to edit.`);
    if (rest.length > 0) {
      return err(
        `${what} edits one image; it was given ${request.images.length}.`
      );
    }
    if (request.signal?.aborted === true) return err(`${what} was cancelled`);
    const checked: Result<AiImage> = checkImageInput(
      first,
      'The image to edit',
      'Stability AI'
    );
    if (!checked.ok) return checked;

    const form = new FormData();
    form.set(
      'image',
      new Blob([first.data as BlobPart], { type: first.mimeType }),
      'image'
    );
    form.set('output_format', 'png');
    if (spec.usesPrompt) {
      // The calls take no system prompt, so the rules lead the prompt.
      form.set(
        'prompt',
        promptWithInstructions(request.instructions, request.prompt)
      );
    }
    if (modeName === 'image-to-image') {
      form.set('mode', 'image-to-image');
      form.set('model', this.model);
      form.set('strength', String(this.#strength));
    }
    if (modeName === 'search-and-replace') {
      if (this.#searchPrompt === '') {
        return err(
          `${what} needs searchPrompt: what to find in the image (the prompt is what replaces it).`
        );
      }
      form.set('search_prompt', this.#searchPrompt);
    }
    if (modeName === 'search-and-recolor') {
      if (this.#selectPrompt === '') {
        return err(
          `${what} needs selectPrompt: what to recolor in the image (the prompt describes the new colors).`
        );
      }
      form.set('select_prompt', this.#selectPrompt);
    }
    for (const [field, value] of Object.entries(this.#input)) {
      if (RESERVED_FIELDS.has(field)) {
        return err(
          `${what}: input can't set "${field}"; the generator sets it itself.`
        );
      }
      form.set(field, String(value));
    }

    // No content-type header: fetch adds the multipart boundary itself.
    const response = await callProvider(
      this.#fetch,
      `${STABILITY_API_URL}/${spec.path}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
        },
        body: form,
      },
      what,
      this.#timeoutMs,
      request.signal
    );
    if (!response.ok) return response;
    const parsed = await readJson(response.value, what, MAX_REPLY_BYTES);
    if (!parsed.ok) return parsed;
    const body = (parsed.value ?? {}) as {
      image?: unknown;
      finish_reason?: unknown;
      seed?: unknown;
    };
    if (
      typeof body.finish_reason === 'string' &&
      body.finish_reason !== 'SUCCESS'
    ) {
      return err(describeFinishReason(body.finish_reason, what));
    }
    if (typeof body.image !== 'string' || body.image === '') {
      return err(`${what} returned no image data`);
    }
    const data: Uint8Array | null = fromBase64(body.image);
    if (data === null || data.length === 0) {
      return err(`${what} returned image data that isn't valid base64`);
    }
    const output = checkImageOutput(data, what);
    if (!output.ok) return output;
    return ok({
      image: output.value,
      notes: typeof body.seed === 'number' ? `seed ${body.seed}` : null,
    });
  }
}
