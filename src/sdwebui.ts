import { checkProviderHost } from './hosts.js';
import {
  DEFAULT_AI_TIMEOUT_MS,
  callProvider,
  fromBase64,
  readBytes,
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

export const DEFAULT_SDWEBUI_HOST = 'http://127.0.0.1:7860';
export const DEFAULT_SDWEBUI_DENOISING_STRENGTH = 0.6;

/** The reply carries images as base64 JSON, so the cap is above one image's own size. */
const MAX_REPLY_BYTES: number = 80 * 1024 * 1024;

/** `img2img` redraws the whole image; `inpaint` redraws the white part of a mask (the second image). */
const MODES: readonly string[] = ['img2img', 'inpaint'];
const DEFAULT_MODE = 'img2img';

/** Payload fields the generator sets itself; `input` can't override them. */
const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'init_images',
  'prompt',
  'mask',
  'denoising_strength',
  'width',
  'height',
  'send_images',
  'save_images',
  'override_settings',
]);

export interface SdWebUiOptions {
  /**
   * Base URL of the AUTOMATIC1111 / Forge web UI (started with `--api`),
   * checked with checkProviderHost: this machine unless the host is in
   * `allowedHosts`. Default 127.0.0.1:7860. A bad host makes generateImage
   * return an error.
   */
  readonly host?: string;
  /** Hosts allowed besides loopback (see parseAllowedHosts). */
  readonly allowedHosts?: readonly string[];
  /** What to call the allow list in messages, e.g. an env variable name. */
  readonly allowedHostsLabel?: string;
  /** A checkpoint to switch to for the call (`sd_model_checkpoint`); default: whatever is loaded. */
  readonly model?: string;
  /** How far the result may depart from the image, 0 to 1 (default 0.6). */
  readonly denoisingStrength?: number;
  /**
   * The output size. Without them a PNG input keeps its own size; any other
   * input falls back to the web UI's default (512 x 512).
   */
  readonly width?: number;
  readonly height?: number;
  /** Extra payload fields, e.g. `negative_prompt`, `steps`, `cfg_scale`, `sampler_name`, `seed`. */
  readonly input?: Readonly<Record<string, string | number | boolean>>;
  readonly timeoutMs?: number;
  /** For tests. */
  readonly fetch?: FetchLike;
}

/** Width and height from a PNG's header, or null when the bytes aren't a PNG. */
function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24 || data[1] !== 0x50 || data[2] !== 0x4e) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width: number = view.getUint32(16);
  const height: number = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Image edits with a local Stable Diffusion web UI (AUTOMATIC1111 or
 * Forge): `POST /sdapi/v1/img2img` with a JSON body and base64 images. The
 * host check is the same as ComfyUI's. The call is one request and one
 * reply with no job id, and the API's interrupt is global, so a timeout or
 * abort stops waiting but leaves the web UI running the job.
 */
export class SdWebUiImageGenerator implements ImageGenerator {
  readonly provider = 'sdwebui';
  readonly model: string;
  readonly #checkpoint: string;
  readonly #hostCheck: Result<string>;
  readonly #denoisingStrength: number;
  readonly #width: number | undefined;
  readonly #height: number | undefined;
  readonly #input: Readonly<Record<string, string | number | boolean>>;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: SdWebUiOptions) {
    this.#checkpoint = options.model?.trim() ?? '';
    this.model = this.#checkpoint || 'loaded checkpoint';
    this.#hostCheck = checkProviderHost(
      'The Stable Diffusion web UI host',
      options.host?.trim() || DEFAULT_SDWEBUI_HOST,
      {
        ...(options.allowedHosts !== undefined
          ? { allowedHosts: options.allowedHosts }
          : {}),
        ...(options.allowedHostsLabel !== undefined
          ? { allowedHostsLabel: options.allowedHostsLabel }
          : {}),
      }
    );
    this.#denoisingStrength =
      options.denoisingStrength ?? DEFAULT_SDWEBUI_DENOISING_STRENGTH;
    this.#width = options.width;
    this.#height = options.height;
    this.#input = options.input ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  listModes(): Promise<Result<readonly string[]>> {
    return Promise.resolve(ok(MODES));
  }

  async generateImage(request: ImageRequest): Promise<Result<ImageResult>> {
    const mode: string = request.mode ?? DEFAULT_MODE;
    const what = `Stable Diffusion web UI (${mode}, ${this.model})`;
    if (!this.#hostCheck.ok) return this.#hostCheck;
    if (!MODES.includes(mode)) {
      return err(
        `${what} has no mode "${mode}"; its modes are ${MODES.join(', ')}.`
      );
    }
    const [first, second, ...rest] = request.images;
    if (first === undefined) return err(`${what} needs an image to edit.`);
    if (mode === 'inpaint' && second === undefined) {
      return err(
        `${what} needs a mask as the second image (white = redraw, black = keep).`
      );
    }
    if (mode === 'img2img' && second !== undefined) {
      return err(
        `${what} edits one image; it was given ${request.images.length}. Use the inpaint mode to pass a mask.`
      );
    }
    if (rest.length > 0) {
      return err(
        `${what} takes an image and a mask; it was given ${request.images.length} images.`
      );
    }
    if (request.signal?.aborted === true) return err(`${what} was cancelled`);
    const image: Result<AiImage> = checkImageInput(
      first,
      'The image to edit',
      'The web UI'
    );
    if (!image.ok) return image;
    if (second !== undefined) {
      const mask: Result<AiImage> = checkImageInput(
        second,
        'The mask',
        'The web UI'
      );
      if (!mask.ok) return mask;
    }

    const size = pngSize(first.data);
    const payload: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(this.#input)) {
      if (RESERVED_FIELDS.has(field)) {
        return err(
          `${what}: input can't set "${field}"; the generator sets it itself.`
        );
      }
      payload[field] = value;
    }
    payload['init_images'] = [toBase64(first.data)];
    // The web UI has no system prompt, so the rules lead the prompt.
    payload['prompt'] = promptWithInstructions(
      request.instructions,
      request.prompt
    );
    payload['denoising_strength'] = this.#denoisingStrength;
    payload['send_images'] = true;
    payload['save_images'] = false;
    const width: number | undefined = this.#width ?? size?.width;
    const height: number | undefined = this.#height ?? size?.height;
    if (width !== undefined) payload['width'] = width;
    if (height !== undefined) payload['height'] = height;
    if (second !== undefined) payload['mask'] = toBase64(second.data);
    if (this.#checkpoint !== '') {
      payload['override_settings'] = { sd_model_checkpoint: this.#checkpoint };
    }

    const response = await callProvider(
      this.#fetch,
      `${this.#hostCheck.value}/sdapi/v1/img2img`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      what,
      this.#timeoutMs,
      request.signal
    );
    if (!response.ok) return response;
    const bytes = await readBytes(response.value, what, MAX_REPLY_BYTES);
    if (!bytes.ok) return bytes;
    let body: { images?: unknown; info?: unknown };
    try {
      body = JSON.parse(new TextDecoder().decode(bytes.value)) as typeof body;
    } catch {
      return err(`${what} returned something that isn't JSON`);
    }
    const encoded: unknown = Array.isArray(body.images)
      ? (body.images as unknown[])[0]
      : undefined;
    if (typeof encoded !== 'string' || encoded === '') {
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
