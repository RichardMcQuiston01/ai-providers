import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import * as realSdk from '@anthropic-ai/sdk';

import {
  ClaudeTextGenerator,
  DEFAULT_CLAUDE_TEXT_MODEL,
  type ClaudeModule,
} from '../src/claude.js';

const KEY = 'sk-ant-api03-test-key-1234567890';

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/**
 * The real SDK, with every client's HTTP going to a fake fetch, so the
 * request the provider builds and the SDK's error classes are both real.
 */
function sdkWith(
  respond: (
    seen: Seen,
    signal: AbortSignal | null
  ) => Response | Promise<Response>
): {
  load: () => Promise<ClaudeModule>;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const RealClient = realSdk.default;
  class FakeClient extends RealClient {
    constructor(options: ConstructorParameters<typeof RealClient>[0]) {
      super({
        ...options,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const entry: Seen = {
            url: String(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          };
          seen.push(entry);
          return respond(entry, init?.signal ?? null);
        },
      });
    }
  }
  const module = { ...realSdk, default: FakeClient } as unknown as ClaudeModule;
  return { load: async () => module, seen };
}

function message(
  overrides: Record<string, unknown> = {},
  text = '  A fresh caption  '
): Response {
  return Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_CLAUDE_TEXT_MODEL,
    content: [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  });
}

void describe('ClaudeTextGenerator', () => {
  void it('sends the rules as system, the key as x-api-key, and opts into the refusal fallback', async () => {
    const fake = sdkWith(() => message());
    const generator = new ClaudeTextGenerator({
      apiKey: ` ${KEY} `,
      effort: 'low',
      loadModule: fake.load,
    });
    const result = await generator.generateText({
      instructions: 'RULES',
      prompt: 'PROMPT',
    });
    assert.deepEqual(result, { ok: true, value: { text: 'A fresh caption' } });
    const request = fake.seen[0];
    assert.ok(request);
    assert.match(request.url, /\/v1\/messages\?beta=true$/);
    assert.equal(request.headers.get('x-api-key'), KEY);
    assert.equal(request.headers.get('authorization'), null);
    assert.match(
      request.headers.get('anthropic-beta') ?? '',
      /server-side-fallback-2026-07-01/
    );
    assert.deepEqual(request.body, {
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'RULES',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'PROMPT' }] }],
      output_config: { effort: 'low' },
      fallbacks: 'default',
    });
  });

  void it('sends no fallback for a model without one, or when turned off, and puts images first', async () => {
    const fake = sdkWith(() => message());
    await new ClaudeTextGenerator({
      apiKey: KEY,
      model: 'claude-haiku-5-5',
      loadModule: fake.load,
    }).generateText({
      instructions: '',
      prompt: 'P',
      images: [{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }],
    });
    await new ClaudeTextGenerator({
      apiKey: KEY,
      refusalFallback: false,
      loadModule: fake.load,
    }).generateText({ instructions: 'R', prompt: 'P' });
    const [haiku, off] = fake.seen;
    assert.equal(haiku?.body['fallbacks'], undefined);
    assert.equal(haiku?.body['system'], undefined);
    assert.deepEqual(haiku?.body['messages'], [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
          },
          { type: 'text', text: 'P' },
        ],
      },
    ]);
    assert.equal(off?.body['fallbacks'], undefined);
    assert.equal(off?.headers.get('anthropic-beta'), null);
  });

  void it('reports a refusal with its category', async () => {
    const fake = sdkWith(() =>
      message(
        {
          stop_reason: 'refusal',
          stop_details: {
            type: 'refusal',
            category: 'cyber',
            explanation: 'x',
          },
        },
        ''
      )
    );
    const result = await new ClaudeTextGenerator({
      apiKey: KEY,
      loadModule: fake.load,
    }).generateText({ instructions: 'R', prompt: 'P' });
    assert.deepEqual(
      result.ok ? '' : result.error,
      'Claude (model "claude-opus-5-5") declined the request (cyber), and so did the fallback model.'
    );
  });

  void it('turns API errors into specific messages without the key', async () => {
    const cases: [number, RegExp][] = [
      [401, /401\): the API key isn't valid/],
      [404, /404\): .*Check the model name/],
      [400, /\(400\): /],
    ];
    for (const [status, expected] of cases) {
      const fake = sdkWith(() =>
        Response.json(
          { type: 'error', error: { type: 'x', message: `boom ${status}` } },
          { status }
        )
      );
      const result = await new ClaudeTextGenerator({
        apiKey: KEY,
        loadModule: fake.load,
      }).generateText({ instructions: 'R', prompt: 'P' });
      const error = result.ok ? '' : result.error;
      assert.match(error, expected);
      assert.doesNotMatch(error, /test-key/);
    }
  });

  void it('refuses a missing key, bad images and a cancelled signal before calling', async () => {
    const fake = sdkWith(() => message());
    const noKey = await new ClaudeTextGenerator({
      apiKey: ' ',
      loadModule: fake.load,
    }).generateText({ instructions: 'R', prompt: 'P' });
    assert.match(noKey.ok ? '' : noKey.error, /No Anthropic API key/);

    const generator = new ClaudeTextGenerator({
      apiKey: KEY,
      loadModule: fake.load,
    });
    const tiff = await generator.generateText({
      instructions: 'R',
      prompt: 'P',
      images: [{ mimeType: 'image/tiff', data: new Uint8Array([1]) }],
    });
    assert.match(tiff.ok ? '' : tiff.error, /Image 1 is image\/tiff/);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await generator.generateText({
      instructions: 'R',
      prompt: 'P',
      signal: controller.signal,
    });
    assert.match(cancelled.ok ? '' : cancelled.error, /was cancelled/);
    assert.equal(fake.seen.length, 0);
  });

  void it('stops a call that takes too long', async () => {
    // Never answers; like real fetch, it gives up when the SDK aborts.
    const fake = sdkWith(
      (_seen, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        })
    );
    const result = await new ClaudeTextGenerator({
      apiKey: KEY,
      timeoutMs: 20,
      loadModule: fake.load,
    }).generateText({ instructions: 'R', prompt: 'P' });
    assert.match(
      result.ok ? '' : result.error,
      /took longer than 0 s and was stopped/
    );
  });

  void it('names the package when it is not installed', async () => {
    const result = await new ClaudeTextGenerator({
      apiKey: KEY,
      loadModule: () => Promise.reject(new Error('Cannot find module')),
    }).generateText({ instructions: 'R', prompt: 'P' });
    assert.match(
      result.ok ? '' : result.error,
      /needs the optional package @anthropic-ai\/sdk;.*Cannot find module/
    );
  });

  void it('keeps the key out of JSON, spreads and inspect output', () => {
    const generator = new ClaudeTextGenerator({ apiKey: KEY });
    assert.doesNotMatch(JSON.stringify(generator), /test-key/);
    assert.doesNotMatch(JSON.stringify({ ...generator }), /test-key/);
    assert.doesNotMatch(
      inspect(generator, { showHidden: true, depth: 5 }),
      /test-key/
    );
  });
});
