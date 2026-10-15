import {
  DEFAULT_AI_TIMEOUT_MS,
  callProvider,
  fromBase64,
  readJson,
  toBase64,
} from './http.js';
import {
  ChatCompletionsTextGenerator,
  type ChatEndpoint,
  type OpenAiOptions,
} from './openai.js';
import {
  promptWithInstructions,
  type AiImage,
  type FetchLike,
  type ImageGenerator,
  type ImageRequest,
  type ImageResult,
} from './port.js';
import { err, ok, type Result } from './result.js';

export const GROK_API_URL = 'https://api.x.ai/v1';
export const DEFAULT_GROK_TEXT_MODEL = 'grok-4';
export const DEFAULT_GROK_IMAGE_MODEL = 'grok-imagine-image';

/** xAI's API speaks the OpenAI chat protocol, so text goes through the `openai` SDK. */
export const GROK_ENDPOINT: ChatEndpoint = {
  provider: 'grok',
  label: 'Grok',
  baseUrl: GROK_API_URL,
  defaultTextModel: DEFAULT_GROK_TEXT_MODEL,
  keyHelp: 'create one at console.x.ai',
};

const GROK_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export type GrokOptions = OpenAiOptions;

/**
 * Text from Grok (xAI) through the Chat Completions API, using the optional
 * peer package `openai` pointed at api.x.ai. Instructions are the system
 * message; images go before the prompt.
 */
export class GrokTextGenerator extends ChatCompletionsTextGenerator {
  constructor(options: GrokOptions) {
    super(GROK_ENDPOINT, options);
  }
}

export interface GrokImageOptions {
  /** An xAI API key (console.x.ai). Passed in, never read from the environment. */
  readonly apiKey: string;
  /** Defaults to DEFAULT_GROK_IMAGE_MODEL. */
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

/** The image type from the file's first bytes; the API returns bare base64. */
function sniffImageType(data: Uint8Array): string | null {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e) {
    return 'image/png';
  }
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[8] === 0x57 &&
    data[9] === 0x45
  ) {
    return 'image/webp';
  }
  return null;
}

function toDataUri(image: AiImage): Result<string> {
  if (!GROK_IMAGE_TYPES.has(image.mimeType)) {
    return err(
      `The image to edit is ${image.mimeType}; Grok takes PNG, JPEG or WebP.`
    );
  }
  if (image.data.length === 0) return err('The image to edit is empty.');
  return ok(`data:${image.mimeType};base64,${toBase64(image.data)}`);
}

/**
 * Image edits with Grok Imagine (xAI), over plain `fetch`: `POST
 * /v1/images/edits` with a JSON body. (The `openai` SDK's `images.edit`
 * sends multipart form data, which xAI doesn't accept.) It edits one
 * image, so a request with references is refused. There is one mode, named
 * after the model.
 */
export class GrokImageGenerator implements ImageGenerator {
  readonly provider = 'grok';
  readonly model: string;
  // Runtime-private, so the key stays out of JSON, spreads and logs.
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: GrokImageOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_GROK_IMAGE_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  listModes(): Promise<Result<readonly string[]>> {
    return Promise.resolve(ok([this.model]));
  }

  async generateImage(request: ImageRequest): Promise<Result<ImageResult>> {
    const what = `Grok (model "${this.model}")`;
    const apiKey: string = this.#apiKey.trim();
    if (apiKey === '') {
      return err(
        'No Grok API key is set; create one at console.x.ai and pass it as apiKey.'
      );
    }
    if (request.mode !== null && request.mode !== this.model) {
      return err(
        `${what} has no mode "${request.mode}"; its only mode is "${this.model}".`
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
    const image = toDataUri(first);
    if (!image.ok) return image;
    // The edit endpoint has no system prompt, so the rules lead the prompt.
    const prompt: string = promptWithInstructions(
      request.instructions,
      request.prompt
    );

    const response = await callProvider(
      this.#fetch,
      `${GROK_API_URL}/images/edits`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt,
          image: { url: image.value, type: 'image_url' },
          response_format: 'b64_json',
          n: 1,
        }),
      },
      what,
      this.#timeoutMs,
      request.signal
    );
    if (!response.ok) return response;
    const body = await readJson(response.value, what);
    if (!body.ok) return body;
    const encoded: unknown = (
      body.value as { data?: Array<{ b64_json?: unknown }> }
    ).data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || encoded === '') {
      return err(`${what} returned no image data`);
    }
    const data: Uint8Array | null = fromBase64(encoded);
    if (data === null || data.length === 0) {
      return err(`${what} returned image data that isn't valid base64`);
    }
    const mimeType: string | null = sniffImageType(data);
    if (mimeType === null) {
      return err(`${what} returned data that isn't a PNG, JPEG or WebP image`);
    }
    return ok({ image: { mimeType, data }, notes: null });
  }
}
