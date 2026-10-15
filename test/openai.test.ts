import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import * as realSdk from 'openai';

import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  DEFAULT_OPENAI_TEXT_MODEL,
  OpenAiImageGenerator,
  OpenAiTextGenerator,
  type OpenAiModule,
} from '../src/openai.js';
import { PNG_OUTPUT, PNG_OUTPUT_BASE64 } from './helpers.js';

const KEY = 'sk-proj-test-key-1234567890';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

interface Seen {
  url: string;
  headers: Headers;
  /** Parsed JSON, or the fields of a multipart form (files as their names). */
  body: Record<string, unknown>;
  files: File[];
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
): { load: () => Promise<OpenAiModule>; seen: Seen[] } {
  const seen: Seen[] = [];
  const RealClient = realSdk.default;
  class FakeClient extends RealClient {
    constructor(options: ConstructorParameters<typeof RealClient>[0]) {
      super({
        ...options,
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const body: Record<string, unknown> = {};
          const files: File[] = [];
          if (init?.body instanceof FormData) {
            init.body.forEach((value, name) => {
              if (value instanceof File) files.push(value);
              else body[name] = value;
            });
          } else {
            Object.assign(body, JSON.parse(String(init?.body)));
          }
          const entry: Seen = {
            url: String(input),
            headers: new Headers(init?.headers),
            body,
            files,
          };
          seen.push(entry);
          return respond(entry, init?.signal ?? null);
        },
      });
    }
  }
  const module = { ...realSdk, default: FakeClient } as unknown as OpenAiModule;
  return { load: async () => module, seen };
}

function completion(
  message: Record<string, unknown> = { content: '  A fresh caption  ' },
  finishReason = 'stop'
): Response {
  return Response.json({
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 1,
    model: DEFAULT_OPENAI_TEXT_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: 'assistant', refusal: null, ...message },
      },
    ],
  });
}

function imageReply(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    created: 1,
    data: [{ b64_json: PNG_OUTPUT_BASE64 }],
    output_format: 'png',
    ...overrides,
  });
}

void describe('OpenAiTextGenerator', () => {
  void it('sends the rules as the system message, the key as a bearer token, and images first', async () => {
    const fake = sdkWith(() => completion());
    const generator = new OpenAiTextGenerator({
      apiKey: ` ${KEY} `,
      loadModule: fake.load,
    });
    const result = await generator.generateText({
      instructions: 'RULES',
      prompt: 'PROMPT',
      images: [{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }],
    });
    assert.deepEqual(result, { ok: true, value: { text: 'A fresh caption' } });
    const request = fake.seen[0];
    assert.ok(request);
    assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(request.headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(request.headers.get('openai-organization'), null);
    assert.deepEqual(request.body, {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'RULES' },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AQID' },
            },
            { type: 'text', text: 'PROMPT' },
          ],
        },
      ],
    });
  });

  void it('leaves out the system message when there are no instructions, and uses a given model', async () => {
    const fake = sdkWith(() => completion());
    await new OpenAiTextGenerator({
      apiKey: KEY,
      model: ' gpt-5.4-mini ',
      loadModule: fake.load,
    }).generateText({ instructions: ' ', prompt: 'P' });
    assert.equal(fake.seen[0]?.body['model'], 'gpt-5.4-mini');
    assert.deepEqual(fake.seen[0]?.body['messages'], [
      { role: 'user', content: [{ type: 'text', text: 'P' }] },
    ]);
  });

  void it('reports a refusal with its explanation', async () => {
    const fake = sdkWith(() =>
      completion({ content: null, refusal: "I can't help with that." })
    );
    const result = await new OpenAiTextGenerator({
      apiKey: KEY,
      loadModule: fake.load,
    }).generateText({ instructions: 'R', prompt: 'P' });
    assert.equal(
      result.ok ? '' : result.error,
      'OpenAI (model "gpt-5.5") declined the request: I can\'t help with that.'
    );
  });

  void it('reports an empty reply with the finish reason', async () => {
    const fake = sdkWith(() => completion({ content: '' }, 'length'));
    const result = await new OpenAiTextGenerator({
      apiKey: KEY,
      loadModule: fake.load,
    }).generateText({ instructions: 'R', prompt: 'P' });
    assert.match(
      result.ok ? '' : result.error,
      /returned no text \(finish reason: length\)/
    );
  });

  void it('turns API errors into specific messages without the key', async () => {
    const cases: [number, RegExp][] = [
      [401, /401\): the API key isn't valid/],
      [404, /404\): .*Check the model name/],
      [400, /\(400\): boom 400$/],
    ];
    for (const [status, expected] of cases) {
      const fake = sdkWith(() =>
        Response.json({ error: { message: `boom ${status}` } }, { status })
      );
      const result = await new OpenAiTextGenerator({
        apiKey: KEY,
        loadModule: fake.load,
      }).generateText({ instructions: 'R', prompt: 'P' });
      const error = result.ok ? '' : result.error;
      assert.match(error, expected);
      assert.doesNotMatch(error, /test-key/);
    }
  });

  void it('refuses a missing key, bad images and a cancelled signal before calling', async () => {
    const fake = sdkWith(() => completion());
    const noKey = await new OpenAiTextGenerator({
      apiKey: ' ',
      loadModule: fake.load,
    }).generateText({ instructions: 'R', prompt: 'P' });
    assert.match(noKey.ok ? '' : noKey.error, /No OpenAI API key/);

    const generator = new OpenAiTextGenerator({
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
    const result = await new OpenAiTextGenerator({
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
    const result = await new OpenAiTextGenerator({
      apiKey: KEY,
      loadModule: () => Promise.reject(new Error('Cannot find module')),
    }).generateText({ instructions: 'R', prompt: 'P' });
    assert.match(
      result.ok ? '' : result.error,
      /needs the optional package openai;.*Cannot find module/
    );
  });

  void it('keeps the key out of JSON, spreads and inspect output', () => {
    for (const generator of [
      new OpenAiTextGenerator({ apiKey: KEY }),
      new OpenAiImageGenerator({ apiKey: KEY }),
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

void describe('OpenAiImageGenerator', () => {
  void it('edits the first image with the rest as references and returns the decoded result', async () => {
    const fake = sdkWith(() => imageReply({ output_format: 'jpeg' }));
    const generator = new OpenAiImageGenerator({
      apiKey: KEY,
      quality: 'low',
      loadModule: fake.load,
    });
    assert.deepEqual(await generator.listModes(), {
      ok: true,
      value: [DEFAULT_OPENAI_IMAGE_MODEL],
    });
    const result = await generator.generateImage({
      instructions: 'RULES',
      prompt: 'PROMPT',
      images: [
        { mimeType: 'image/png', data: PNG },
        { mimeType: 'image/jpeg', data: new Uint8Array([9]) },
      ],
      mode: null,
    });
    assert.deepEqual(result, {
      ok: true,
      value: {
        image: { mimeType: 'image/png', data: PNG_OUTPUT },
        notes: null,
      },
    });
    const request = fake.seen[0];
    assert.ok(request);
    assert.equal(request.url, 'https://api.openai.com/v1/images/edits');
    assert.equal(request.headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(request.body['model'], 'gpt-image-2');
    assert.equal(request.body['prompt'], 'RULES\n\nPROMPT');
    assert.equal(request.body['quality'], 'low');
    assert.deepEqual(
      request.files.map((file) => [file.name, file.type, file.size]),
      [
        ['image-1.png', 'image/png', 4],
        ['image-2.jpg', 'image/jpeg', 1],
      ]
    );
  });

  void it('sends only the prompt when there are no instructions', async () => {
    const fake = sdkWith(() => imageReply());
    const result = await new OpenAiImageGenerator({
      apiKey: KEY,
      loadModule: fake.load,
    }).generateImage({
      instructions: '',
      prompt: 'PROMPT',
      images: [{ mimeType: 'image/webp', data: PNG }],
      mode: 'gpt-image-2',
    });
    assert.equal(result.ok && result.value.image.mimeType, 'image/png');
    assert.equal(fake.seen[0]?.body['prompt'], 'PROMPT');
    assert.equal(fake.seen[0]?.body['quality'], undefined);
  });

  void it('refuses a missing key, an unknown mode, no image, a bad image and a cancelled signal before calling', async () => {
    const fake = sdkWith(() => imageReply());
    const request = {
      instructions: '',
      prompt: 'P',
      images: [{ mimeType: 'image/png', data: PNG }],
      mode: null,
    };
    const error = async (
      generator: OpenAiImageGenerator,
      overrides: Partial<Parameters<typeof generator.generateImage>[0]> = {}
    ): Promise<string> => {
      const result = await generator.generateImage({
        ...request,
        ...overrides,
      });
      return result.ok ? '' : result.error;
    };
    const generator = new OpenAiImageGenerator({
      apiKey: KEY,
      loadModule: fake.load,
    });
    assert.match(
      await error(
        new OpenAiImageGenerator({ apiKey: '', loadModule: fake.load })
      ),
      /No OpenAI API key/
    );
    assert.match(
      await error(generator, { mode: 'dall-e-3' }),
      /has no mode "dall-e-3"; its only mode is "gpt-image-2"/
    );
    assert.match(
      await error(generator, { images: [] }),
      /needs an image to edit/
    );
    assert.match(
      await error(generator, {
        images: [
          { mimeType: 'image/png', data: PNG },
          { mimeType: 'image/gif', data: PNG },
        ],
      }),
      /Reference image 1 is image\/gif/
    );
    assert.match(
      await error(generator, {
        images: [{ mimeType: 'image/png', data: new Uint8Array() }],
      }),
      /The image to edit is empty/
    );
    const controller = new AbortController();
    controller.abort();
    assert.match(
      await error(generator, { signal: controller.signal }),
      /was cancelled/
    );
    assert.equal(fake.seen.length, 0);
  });

  void it('reports API errors, a reply without an image, and bad base64', async () => {
    const run = async (response: Response): Promise<string> => {
      const fake = sdkWith(() => response.clone());
      const result = await new OpenAiImageGenerator({
        apiKey: KEY,
        loadModule: fake.load,
      }).generateImage({
        instructions: '',
        prompt: 'P',
        images: [{ mimeType: 'image/png', data: PNG }],
        mode: null,
      });
      return result.ok ? '' : result.error;
    };
    assert.match(
      await run(
        Response.json(
          {
            error: {
              message: 'Your request was rejected by the safety system.',
            },
          },
          { status: 400 }
        )
      ),
      /\(400\): Your request was rejected by the safety system/
    );
    assert.match(
      await run(Response.json({ created: 1, data: [] })),
      /returned no image data/
    );
    assert.match(
      await run(imageReply({ data: [{ b64_json: '***' }] })),
      /isn't valid base64/
    );
  });

  void it('names the package when it is not installed', async () => {
    const result = await new OpenAiImageGenerator({
      apiKey: KEY,
      loadModule: () => Promise.reject(new Error('Cannot find module')),
    }).generateImage({
      instructions: '',
      prompt: 'P',
      images: [{ mimeType: 'image/png', data: PNG }],
      mode: null,
    });
    assert.match(
      result.ok ? '' : result.error,
      /needs the optional package openai;.*Cannot find module/
    );
  });
});

void describe('OpenAiImageGenerator output types', () => {
  const run = async (
    response: Response
  ): Promise<{ type?: string; error?: string }> => {
    const fake = sdkWith(() => response.clone());
    const result = await new OpenAiImageGenerator({
      apiKey: KEY,
      loadModule: fake.load,
    }).generateImage({
      instructions: '',
      prompt: 'P',
      images: [{ mimeType: 'image/png', data: PNG }],
      mode: null,
    });
    return result.ok
      ? { type: result.value.image.mimeType }
      : { error: result.error };
  };

  void it('ignores an output_format the reply made up', async () => {
    for (const output_format of [
      'svg+xml',
      'png\r\nX-Evil: 1',
      'gif',
      'jpeg',
    ]) {
      assert.deepEqual(
        await run(imageReply({ output_format })),
        { type: 'image/png' },
        output_format
      );
    }
  });

  void it('refuses bytes that are not PNG, JPEG or WebP', async () => {
    const result = await run(
      imageReply({
        data: [{ b64_json: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') }],
      })
    );
    assert.match(result.error ?? '', /isn't a PNG, JPEG or WebP image/);
  });
});
