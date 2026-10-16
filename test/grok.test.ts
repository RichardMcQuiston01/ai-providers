import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import * as realSdk from 'openai';

import {
  DEFAULT_GROK_IMAGE_MODEL,
  DEFAULT_GROK_TEXT_MODEL,
  GrokImageGenerator,
  GrokTextGenerator,
} from '../src/grok.js';
import type { OpenAiModule } from '../src/openai.js';
import type { ImageRequest } from '../src/index.js';
import { fakeFetch, json, PNG_OUTPUT, PNG_OUTPUT_BASE64 } from './helpers.js';

const KEY = 'xai-test-key-1234567890';
const PNG = PNG_OUTPUT;

/** The real SDK with its HTTP going to a fake fetch, recording what it sends. */
function sdkWith(respond: () => Response): {
  load: () => Promise<OpenAiModule>;
  seen: Array<{ url: string; headers: Headers; body: unknown }>;
} {
  const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const RealClient = realSdk.default;
  class FakeClient extends RealClient {
    constructor(options: ConstructorParameters<typeof RealClient>[0]) {
      super({
        ...options,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          seen.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
          });
          return respond();
        },
      });
    }
  }
  const module = { ...realSdk, default: FakeClient } as unknown as OpenAiModule;
  return { load: async () => module, seen };
}

const completion = (): Response =>
  Response.json({
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: DEFAULT_GROK_TEXT_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', refusal: null, content: ' A caption ' },
      },
    ],
  });

void describe('GrokTextGenerator', () => {
  void it('calls api.x.ai with the key, ignoring OpenAI environment settings', async () => {
    const saved = process.env['OPENAI_BASE_URL'];
    process.env['OPENAI_BASE_URL'] = 'https://example.invalid/v1';
    try {
      const fake = sdkWith(completion);
      const generator = new GrokTextGenerator({
        apiKey: ` ${KEY} `,
        loadModule: fake.load,
      });
      assert.equal(generator.provider, 'grok');
      assert.equal(generator.model, 'grok-4');
      const result = await generator.generateText({
        instructions: 'RULES',
        prompt: 'PROMPT',
      });
      assert.deepEqual(result, { ok: true, value: { text: 'A caption' } });
      const request = fake.seen[0];
      assert.equal(request?.url, 'https://api.x.ai/v1/chat/completions');
      assert.equal(request?.headers.get('authorization'), `Bearer ${KEY}`);
      assert.deepEqual(request?.body, {
        model: 'grok-4',
        messages: [
          { role: 'system', content: 'RULES' },
          { role: 'user', content: [{ type: 'text', text: 'PROMPT' }] },
        ],
      });
    } finally {
      if (saved === undefined) delete process.env['OPENAI_BASE_URL'];
      else process.env['OPENAI_BASE_URL'] = saved;
    }
  });

  void it('names Grok and xAI in its errors', async () => {
    const noKey = await new GrokTextGenerator({ apiKey: ' ' }).generateText({
      instructions: '',
      prompt: 'P',
    });
    assert.match(
      noKey.ok ? '' : noKey.error,
      /No Grok API key is set; create one at console\.x\.ai/
    );
    const unauthorized = await new GrokTextGenerator({
      apiKey: KEY,
      loadModule: sdkWith(() =>
        Response.json({ error: 'bad key' }, { status: 401 })
      ).load,
    }).generateText({ instructions: '', prompt: 'P' });
    assert.match(
      unauthorized.ok ? '' : unauthorized.error,
      /^Grok \(model "grok-4"\) was refused \(401\): the API key isn't valid; check it, or create one at console\.x\.ai/
    );
    const missing = await new GrokTextGenerator({
      apiKey: KEY,
      loadModule: () => Promise.reject(new Error('Cannot find module')),
    }).generateText({ instructions: '', prompt: 'P' });
    assert.match(
      missing.ok ? '' : missing.error,
      /The Grok provider needs the optional package openai;/
    );
  });
});

const request: ImageRequest = {
  instructions: 'RULES',
  prompt: 'PROMPT',
  images: [{ mimeType: 'image/png', data: PNG }],
  mode: null,
};

void describe('GrokImageGenerator', () => {
  void it('posts a JSON edit request and decodes the base64 result', async () => {
    const fake = fakeFetch({
      'POST /v1/images/edits': json({
        data: [{ b64_json: btoa(String.fromCharCode(...PNG)) }],
      }),
    });
    const generator = new GrokImageGenerator({
      apiKey: ` ${KEY} `,
      fetch: fake.fetch,
    });
    assert.deepEqual(await generator.listModes(), {
      ok: true,
      value: [DEFAULT_GROK_IMAGE_MODEL],
    });
    const result = await generator.generateImage(request);
    assert.deepEqual(result, {
      ok: true,
      value: { image: { mimeType: 'image/png', data: PNG }, notes: null },
    });
    const call = fake.calls[0];
    assert.equal(call?.url.toString(), 'https://api.x.ai/v1/images/edits');
    const headers = new Headers(call?.init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(call?.init?.body)), {
      model: 'grok-imagine-image',
      prompt: 'RULES\n\nPROMPT',
      image: {
        url: `data:image/png;base64,${PNG_OUTPUT_BASE64}`,
        type: 'image_url',
      },
      response_format: 'b64_json',
      n: 1,
    });
  });

  void it('recognises JPEG and WebP results and rejects anything else', async () => {
    const run = async (bytes: number[]): Promise<string> => {
      const result = await new GrokImageGenerator({
        apiKey: KEY,
        fetch: fakeFetch({
          'POST /v1/images/edits': json({
            data: [{ b64_json: btoa(String.fromCharCode(...bytes)) }],
          }),
        }).fetch,
      }).generateImage(request);
      return result.ok ? result.value.image.mimeType : result.error;
    };
    assert.equal(await run([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
    // "RI" at 0-1 and "WE" at 8-9 is not enough.
    assert.match(
      await run([0x52, 0x49, 0x58, 0x58, 0, 0, 0, 0, 0x57, 0x45, 0x58, 0x58]),
      /isn't a PNG, JPEG or WebP image/
    );
    assert.equal(
      await run([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      'image/webp'
    );
    assert.match(await run([1, 2, 3, 4]), /isn't a PNG, JPEG or WebP image/);
  });

  void it('reports API errors, empty replies and bad base64', async () => {
    const run = async (response: Response): Promise<string> => {
      const result = await new GrokImageGenerator({
        apiKey: KEY,
        fetch: fakeFetch({ 'POST /v1/images/edits': response }).fetch,
      }).generateImage(request);
      return result.ok ? '' : result.error;
    };
    const unauthorized = await run(
      json({ error: 'Incorrect API key provided' }, 401)
    );
    assert.match(
      unauthorized,
      /failed \(HTTP 401\): Incorrect API key provided/
    );
    assert.doesNotMatch(unauthorized, /test-key/);
    assert.match(await run(json({ data: [] })), /returned no image data/);
    assert.match(
      await run(json({ data: [{ b64_json: '***' }] })),
      /isn't valid base64/
    );
  });

  void it('refuses bad input before calling', async () => {
    const fake = fakeFetch({});
    const run = async (
      overrides: Partial<ImageRequest> = {},
      apiKey = KEY
    ): Promise<string> => {
      const result = await new GrokImageGenerator({
        apiKey,
        fetch: fake.fetch,
      }).generateImage({ ...request, ...overrides });
      return result.ok ? '' : result.error;
    };
    assert.match(await run({}, ' '), /No Grok API key/);
    assert.match(await run({ mode: 'other' }), /has no mode "other"/);
    assert.match(await run({ images: [] }), /needs an image to edit/);
    assert.match(
      await run({
        images: [
          { mimeType: 'image/png', data: PNG },
          { mimeType: 'image/png', data: PNG },
        ],
      }),
      /edits one image; it was given 2/
    );
    assert.match(
      await run({ images: [{ mimeType: 'image/gif', data: PNG }] }),
      /The image to edit is image\/gif/
    );
    assert.match(
      await run({
        images: [{ mimeType: 'image/png', data: new Uint8Array() }],
      }),
      /The image to edit is empty/
    );
    const controller = new AbortController();
    controller.abort();
    assert.match(await run({ signal: controller.signal }), /was cancelled/);
    assert.equal(fake.calls.length, 0);
  });

  void it('keeps the key out of JSON, spreads and inspect output', () => {
    for (const generator of [
      new GrokImageGenerator({ apiKey: KEY }),
      new GrokTextGenerator({ apiKey: KEY }),
    ]) {
      assert.doesNotMatch(JSON.stringify(generator), /test-key/);
      assert.doesNotMatch(JSON.stringify({ ...generator }), /test-key/);
      assert.doesNotMatch(
        inspect(generator, { showHidden: true, depth: 5 }),
        /test-key/
      );
    }
  });
});
