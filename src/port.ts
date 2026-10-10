import type { Result } from './result.js';

/**
 * The provider-neutral interfaces. A provider turns a request into text or
 * an image and nothing else: prompt rules, output checks and the decision
 * to use a result stay with the caller, so swapping one provider for
 * another can't weaken them.
 *
 * A provider can implement either interface or both.
 */

export interface AiImage {
  /** e.g. image/png, image/jpeg, image/webp. */
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export interface TextRequest {
  /** Fixed rules, sent as the system prompt. */
  readonly instructions: string;
  /** The user's prompt. */
  readonly prompt: string;
  /** Optional images, for vision models. */
  readonly images?: readonly AiImage[];
  readonly signal?: AbortSignal;
}

export interface TextResult {
  readonly text: string;
}

export interface TextGenerator {
  /** e.g. 'ollama'. */
  readonly provider: string;
  /** The model name, for display and logs. */
  readonly model: string;
  generateText(request: TextRequest): Promise<Result<TextResult>>;
}

export interface ImageRequest {
  /** Fixed rules; providers that take no system prompt add them to the prompt. */
  readonly instructions: string;
  readonly prompt: string;
  /** The image to edit first, then any references. */
  readonly images: readonly AiImage[];
  /** Which of the provider's modes to run (see listModes); null = its default. */
  readonly mode: string | null;
  readonly signal?: AbortSignal;
}

export interface ImageResult {
  readonly image: AiImage;
  /** e.g. which workflow ran; null when there's nothing to say. */
  readonly notes: string | null;
}

export interface ImageGenerator {
  readonly provider: string;
  /** The model, or a label such as a workflows folder. */
  readonly model: string;
  /** The modes a user can choose between, e.g. ComfyUI workflow names. */
  listModes(): Promise<Result<readonly string[]>>;
  generateImage(request: ImageRequest): Promise<Result<ImageResult>>;
}

/** The part of `fetch` providers use; inject a fake in tests. */
export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;
