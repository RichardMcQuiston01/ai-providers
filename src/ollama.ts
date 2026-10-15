import { checkProviderHost } from './hosts.js';
import {
  DEFAULT_AI_TIMEOUT_MS,
  callProvider,
  readJson,
  toBase64,
} from './http.js';
import type {
  FetchLike,
  TextGenerator,
  TextRequest,
  TextResult,
} from './port.js';
import { err, ok, type Result } from './result.js';

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

export interface OllamaTextOptions {
  /** The model, as `ollama list` shows it, e.g. llama3.2. */
  readonly model: string;
  /**
   * Base URL, checked with checkProviderHost: this machine unless the host
   * is in `allowedHosts`. Default 127.0.0.1:11434. A bad host makes
   * generateText return an error.
   */
  readonly host?: string;
  /** Hosts allowed besides loopback (see parseAllowedHosts). */
  readonly allowedHosts?: readonly string[];
  /** What to call the allow list in messages, e.g. an env variable name. */
  readonly allowedHostsLabel?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Text from a local Ollama model (`POST /api/chat`, not streamed). Images,
 * when given, go to the user message for vision models. A reasoning model's
 * `<think>` block is removed from the reply.
 */
export class OllamaTextGenerator implements TextGenerator {
  readonly provider = 'ollama';
  readonly model: string;
  private readonly host: string;
  private readonly hostCheck: Result<string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: OllamaTextOptions) {
    this.model = options.model;
    this.hostCheck = checkProviderHost(
      'The Ollama host',
      options.host?.trim() || DEFAULT_OLLAMA_HOST,
      {
        ...(options.allowedHosts !== undefined
          ? { allowedHosts: options.allowedHosts }
          : {}),
        ...(options.allowedHostsLabel !== undefined
          ? { allowedHostsLabel: options.allowedHostsLabel }
          : {}),
      }
    );
    this.host = this.hostCheck.ok ? this.hostCheck.value : '';
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  }

  async generateText(request: TextRequest): Promise<Result<TextResult>> {
    const what = `Ollama (model "${this.model}")`;
    if (!this.hostCheck.ok) return this.hostCheck;
    if (this.model.trim() === '') {
      return err(
        'No Ollama model is set; use one you have pulled (`ollama list`).'
      );
    }
    const response = await callProvider(
      this.fetchImpl,
      `${this.host}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: 'system', content: request.instructions },
            {
              role: 'user',
              content: request.prompt,
              ...(request.images !== undefined && request.images.length > 0
                ? {
                    images: request.images.map((image) => toBase64(image.data)),
                  }
                : {}),
            },
          ],
        }),
      },
      what,
      this.timeoutMs,
      request.signal
    );
    if (!response.ok) return response;
    const body = await readJson(response.value, what);
    if (!body.ok) return body;
    const content: unknown = (body.value as { message?: { content?: unknown } })
      .message?.content;
    if (typeof content !== 'string') {
      return err(`${what} returned no message text`);
    }
    const text: string = stripThinking(content);
    if (text === '') return err(`${what} returned an empty reply`);
    return ok({ text });
  }
}

/** Drops a reasoning model's `<think>…</think>` block and surrounding space. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
