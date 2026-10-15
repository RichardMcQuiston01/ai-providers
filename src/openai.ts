import type OpenAI from 'openai';

import { DEFAULT_AI_TIMEOUT_MS, fromBase64, toBase64 } from './http.js';
import { IMAGE_TYPES, checkImageOutput } from './images.js';
import {
  promptWithInstructions,
  type AiImage,
  type ImageGenerator,
  type ImageRequest,
  type ImageResult,
  type TextGenerator,
  type TextRequest,
  type TextResult,
} from './port.js';
import { describeUnknownError, err, ok, type Result } from './result.js';

/** The optional peer package the OpenAI providers are built on. */
export const OPENAI_PACKAGE = 'openai';
export const DEFAULT_OPENAI_TEXT_MODEL = 'gpt-5.5';
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2';

/**
 * What differs between OpenAI and the OpenAI-compatible APIs (such as xAI's)
 * that are called through the same SDK.
 */
export interface ChatEndpoint {
  /** e.g. 'openai'. */
  readonly provider: string;
  /** For messages, e.g. 'OpenAI'. */
  readonly label: string;
  readonly baseUrl: string;
  readonly defaultTextModel: string;
  /** Finishes "create one at …", for the missing-key and 401 messages. */
  readonly keyHelp: string;
}

export const OPENAI_ENDPOINT: ChatEndpoint = {
  provider: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  defaultTextModel: DEFAULT_OPENAI_TEXT_MODEL,
  keyHelp: 'create one at platform.openai.com',
};

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** The SDK module, as `import('openai')` returns it; inject a fake in tests. */
export type OpenAiModule = typeof import('openai');
export type OpenAiModuleLoader = () => Promise<OpenAiModule>;

export interface OpenAiOptions {
  /** An OpenAI API key (platform.openai.com). Passed in, never read from the environment. */
  readonly apiKey: string;
  /** Defaults to DEFAULT_OPENAI_TEXT_MODEL / DEFAULT_OPENAI_IMAGE_MODEL. */
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Loads the peer package; replace it in tests. */
  readonly loadModule?: OpenAiModuleLoader;
}

export type OpenAiImageQuality = 'low' | 'medium' | 'high' | 'auto';

export interface OpenAiImageOptions extends OpenAiOptions {
  /** Left out, the model's own default applies. */
  readonly quality?: OpenAiImageQuality;
}

const loadOpenAiPackage: OpenAiModuleLoader = () => import('openai');

/**
 * Loads the peer package, or explains how to install it. A failed load is
 * not cached, so installing the package fixes it without a restart.
 */
async function loadModule(
  loader: OpenAiModuleLoader,
  endpoint: ChatEndpoint
): Promise<Result<OpenAiModule>> {
  try {
    return ok(await loader());
  } catch (cause: unknown) {
    return err(
      `The ${endpoint.label} provider needs the optional package ${OPENAI_PACKAGE}; ` +
        `install it (e.g. bun add ${OPENAI_PACKAGE}). Loading it failed: ${describeUnknownError(cause)}`,
      cause
    );
  }
}

function checkKey(apiKey: string, endpoint: ChatEndpoint): Result<string> {
  const key: string = apiKey.trim();
  return key === ''
    ? err(
        `No ${endpoint.label} API key is set; ${endpoint.keyHelp} and pass it as apiKey.`
      )
    : ok(key);
}

/**
 * A client that gets its credentials and endpoint only from the options:
 * the explicit nulls and base URL stop the SDK reading OPENAI_ORG_ID,
 * OPENAI_PROJECT_ID, OPENAI_WEBHOOK_SECRET and OPENAI_BASE_URL.
 */
function createClient(
  sdk: OpenAiModule,
  endpoint: ChatEndpoint,
  apiKey: string,
  timeoutMs: number
): OpenAI {
  return new sdk.default({
    apiKey,
    baseURL: endpoint.baseUrl,
    organization: null,
    project: null,
    webhookSecret: null,
    maxRetries: 1,
    timeout: timeoutMs,
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function checkImage(
  image: AiImage,
  label: string,
  endpoint: ChatEndpoint
): Result<AiImage> {
  if (!IMAGE_TYPES.has(image.mimeType)) {
    return err(
      `${label} is ${image.mimeType}; ${endpoint.label} takes PNG, JPEG or WebP.`
    );
  }
  if (image.data.length === 0) return err(`${label} is empty.`);
  return ok(image);
}

/** The SDK prefixes its messages with the status ("400 Bad ..."); the status is already in ours. */
function messageOf(cause: InstanceType<OpenAiModule['APIError']>): string {
  return cause.status === undefined
    ? cause.message
    : cause.message.replace(new RegExp(`^${cause.status} `), '');
}

/** A specific message for an SDK error: the status, the provider's message, and the likely fix. */
function describeApiError(
  sdk: OpenAiModule,
  what: string,
  cause: unknown,
  endpoint: ChatEndpoint
): string {
  const {
    APIError,
    AuthenticationError,
    PermissionDeniedError,
    NotFoundError,
    RateLimitError,
  } = sdk;
  if (cause instanceof AuthenticationError) {
    return `${what} was refused (401): the API key isn't valid; check it, or ${endpoint.keyHelp}.`;
  }
  if (cause instanceof PermissionDeniedError) {
    return `${what} was refused (403): ${messageOf(cause)}`;
  }
  if (cause instanceof NotFoundError) {
    return `${what} failed (404): ${messageOf(cause)}. Check the model name.`;
  }
  if (cause instanceof RateLimitError) {
    return `${what} was rate limited (429): ${messageOf(cause)}. Try again shortly.`;
  }
  if (cause instanceof APIError) {
    return `${what} failed (${cause.status ?? 'no status'}): ${messageOf(cause)}`;
  }
  return `${what} failed: ${describeUnknownError(cause)}`;
}

/** The error for a thrown SDK call: cancelled, timed out, or described by status. */
function describeFailure(
  sdk: OpenAiModule,
  what: string,
  cause: unknown,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  endpoint: ChatEndpoint
): string {
  if (isAborted(signal)) return `${what} was cancelled`;
  if (cause instanceof sdk.APIConnectionTimeoutError) {
    return `${what} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`;
  }
  return describeApiError(sdk, what, cause, endpoint);
}

/**
 * Text through the Chat Completions API, from OpenAI or any API that speaks
 * it (see `ChatEndpoint`). The request's
 * instructions are the system message; images go before the prompt. A
 * refusal from the model is an error carrying its explanation.
 */
export class ChatCompletionsTextGenerator implements TextGenerator {
  readonly provider: string;
  readonly model: string;
  // Runtime-private, so the key stays out of JSON, spreads and logs.
  readonly #endpoint: ChatEndpoint;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #loader: OpenAiModuleLoader;

  constructor(endpoint: ChatEndpoint, options: OpenAiOptions) {
    this.#endpoint = endpoint;
    this.provider = endpoint.provider;
    this.#apiKey = options.apiKey;
    this.model = options.model?.trim() || endpoint.defaultTextModel;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.#loader = options.loadModule ?? loadOpenAiPackage;
  }

  async generateText(request: TextRequest): Promise<Result<TextResult>> {
    const what = `${this.#endpoint.label} (model "${this.model}")`;
    const key = checkKey(this.#apiKey, this.#endpoint);
    if (!key.ok) return key;
    if (isAborted(request.signal)) return err(`${what} was cancelled`);

    const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
    for (const [index, image] of (request.images ?? []).entries()) {
      const checked = checkImage(image, `Image ${index + 1}`, this.#endpoint);
      if (!checked.ok) return checked;
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType};base64,${toBase64(image.data)}`,
        },
      });
    }
    content.push({ type: 'text', text: request.prompt });

    const sdk = await loadModule(this.#loader, this.#endpoint);
    if (!sdk.ok) return sdk;
    const client: OpenAI = createClient(
      sdk.value,
      this.#endpoint,
      key.value,
      this.#timeoutMs
    );
    const instructions: string = request.instructions.trim();
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...(instructions !== ''
        ? [{ role: 'system' as const, content: instructions }]
        : []),
      { role: 'user', content },
    ];

    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await client.chat.completions.create(
        { model: this.model, messages },
        { signal: request.signal ?? null }
      );
    } catch (cause: unknown) {
      return err(
        describeFailure(
          sdk.value,
          what,
          cause,
          this.#timeoutMs,
          request.signal,
          this.#endpoint
        ),
        cause
      );
    }

    const choice = completion.choices[0];
    if (choice === undefined) return err(`${what} returned no choices`);
    const refusal: string | null | undefined = choice.message.refusal;
    if (refusal !== null && refusal !== undefined && refusal !== '') {
      return err(`${what} declined the request: ${refusal}`);
    }
    const text: string = choice.message.content?.trim() ?? '';
    if (text === '') {
      return err(
        `${what} returned no text (finish reason: ${choice.finish_reason})`
      );
    }
    return ok({ text });
  }
}

/** Text from OpenAI through the Chat Completions API. */
export class OpenAiTextGenerator extends ChatCompletionsTextGenerator {
  constructor(options: OpenAiOptions) {
    super(OPENAI_ENDPOINT, options);
  }
}

/**
 * Image edits with OpenAI's GPT Image models, through `images.edit`. The
 * first image is the one edited; the rest are references. There is one
 * mode, named after the model.
 */
export class OpenAiImageGenerator implements ImageGenerator {
  readonly provider = 'openai';
  readonly model: string;
  // Runtime-private, so the key stays out of JSON, spreads and logs.
  readonly #apiKey: string;
  readonly #quality: OpenAiImageQuality | undefined;
  readonly #timeoutMs: number;
  readonly #loader: OpenAiModuleLoader;

  constructor(options: OpenAiImageOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_OPENAI_IMAGE_MODEL;
    this.#quality = options.quality;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.#loader = options.loadModule ?? loadOpenAiPackage;
  }

  listModes(): Promise<Result<readonly string[]>> {
    return Promise.resolve(ok([this.model]));
  }

  async generateImage(request: ImageRequest): Promise<Result<ImageResult>> {
    const what = `OpenAI (model "${this.model}")`;
    const key = checkKey(this.#apiKey, OPENAI_ENDPOINT);
    if (!key.ok) return key;
    if (request.mode !== null && request.mode !== this.model) {
      return err(
        `${what} has no mode "${request.mode}"; its only mode is "${this.model}".`
      );
    }
    if (request.images.length === 0) {
      return err(`${what} needs an image to edit.`);
    }
    if (isAborted(request.signal)) return err(`${what} was cancelled`);
    for (const [index, image] of request.images.entries()) {
      const label: string =
        index === 0 ? 'The image to edit' : `Reference image ${index}`;
      const checked = checkImage(image, label, OPENAI_ENDPOINT);
      if (!checked.ok) return checked;
    }

    const sdk = await loadModule(this.#loader, OPENAI_ENDPOINT);
    if (!sdk.ok) return sdk;
    const files = await Promise.all(
      request.images.map((image, index) =>
        sdk.value.toFile(
          image.data,
          `image-${index + 1}.${IMAGE_EXTENSIONS[image.mimeType] ?? 'png'}`,
          { type: image.mimeType }
        )
      )
    );
    const client: OpenAI = createClient(
      sdk.value,
      OPENAI_ENDPOINT,
      key.value,
      this.#timeoutMs
    );
    // images.edit takes no system prompt, so the rules lead the prompt.
    const prompt: string = promptWithInstructions(
      request.instructions,
      request.prompt
    );

    let response: OpenAI.ImagesResponse;
    try {
      response = await client.images.edit(
        {
          model: this.model,
          image: files,
          prompt,
          n: 1,
          ...(this.#quality !== undefined ? { quality: this.#quality } : {}),
        },
        { signal: request.signal ?? null }
      );
    } catch (cause: unknown) {
      return err(
        describeFailure(
          sdk.value,
          what,
          cause,
          this.#timeoutMs,
          request.signal,
          OPENAI_ENDPOINT
        ),
        cause
      );
    }

    const encoded: string | undefined = response.data?.[0]?.b64_json;
    if (encoded === undefined || encoded === '') {
      return err(`${what} returned no image data`);
    }
    const data: Uint8Array | null = fromBase64(encoded);
    if (data === null || data.length === 0) {
      return err(`${what} returned image data that isn't valid base64`);
    }
    const output = checkImageOutput(data, what);
    if (!output.ok) return output;
    return ok({ image: output.value, notes: null });
  }
}
