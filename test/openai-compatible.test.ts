import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import * as realSdk from 'openai';

import type { OpenAiModule } from '../src/openai.js';
import {
  DEFAULT_OPENROUTER_TEXT_MODEL,
  LlamaCppTextGenerator,
  LmStudioTextGenerator,
  OpenAiCompatibleTextGenerator,
  OpenRouterTextGenerator,
  VllmTextGenerator,
} from '../src/openai-compatible.js';

const KEY = 'sk-or-v1-test-key-1234567890';

interface Seen {
  url: string;
  headers: Headers;
  body: unknown;
}

/** The real SDK with its HTTP going to a fake fetch, recording what it sends. */
function sdkWith(respond: () => Response = completion): {
  load: () => Promise<OpenAiModule>;
  seen: Seen[];
} {
  const seen: Seen[] = [];
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

function completion(): Response {
  return Response.json({
    id: 'c1',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', refusal: null, content: ' A caption ' },
      },
    ],
  });
}

const ask = { instructions: 'RULES', prompt: 'PROMPT' };
const errorOf = (result: { ok: boolean; error?: string }): string =>
  result.ok ? '' : (result.error ?? '');

void describe('OpenRouterTextGenerator', () => {
  void it('calls openrouter.ai with the key, the router model and attribution headers', async () => {
    const fake = sdkWith();
    const generator = new OpenRouterTextGenerator({
      apiKey: ` ${KEY} `,
      appUrl: 'https://shop.example',
      appName: 'My Shop',
      loadModule: fake.load,
    });
    assert.equal(generator.provider, 'openrouter');
    assert.equal(generator.model, DEFAULT_OPENROUTER_TEXT_MODEL);
    const result = await generator.generateText(ask);
    assert.deepEqual(result, { ok: true, value: { text: 'A caption' } });
    const request = fake.seen[0];
    assert.equal(request?.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request?.headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(request?.headers.get('http-referer'), 'https://shop.example');
    assert.equal(request?.headers.get('x-title'), 'My Shop');
    assert.deepEqual(request?.body, {
      model: 'openrouter/auto',
      messages: [
        { role: 'system', content: 'RULES' },
        { role: 'user', content: [{ type: 'text', text: 'PROMPT' }] },
      ],
    });
  });

  void it('sends no attribution headers unless asked, and takes a model', async () => {
    const fake = sdkWith();
    await new OpenRouterTextGenerator({
      apiKey: KEY,
      model: ' anthropic/claude-sonnet-5-5 ',
      loadModule: fake.load,
    }).generateText(ask);
    assert.equal(fake.seen[0]?.headers.get('http-referer'), null);
    assert.equal(fake.seen[0]?.headers.get('x-title'), null);
    assert.equal(
      (fake.seen[0]?.body as { model: string }).model,
      'anthropic/claude-sonnet-5-5'
    );
  });

  void it('needs a key and says where to get one; 401 mentions OpenRouter', async () => {
    const noKey = await new OpenRouterTextGenerator({
      apiKey: ' ',
    }).generateText(ask);
    assert.match(
      errorOf(noKey),
      /No OpenRouter API key is set; create one at openrouter\.ai\/keys/
    );
    const unauthorized = await new OpenRouterTextGenerator({
      apiKey: KEY,
      loadModule: sdkWith(() =>
        Response.json({ error: { message: 'No auth' } }, { status: 401 })
      ).load,
    }).generateText(ask);
    assert.match(
      errorOf(unauthorized),
      /^OpenRouter \(model "openrouter\/auto"\) was refused \(401\)/
    );
    assert.doesNotMatch(errorOf(unauthorized), /test-key/);
  });
});

void describe('local servers', () => {
  const kinds = [
    [
      'LM Studio',
      'lmstudio',
      1234,
      (o: object) => new LmStudioTextGenerator({ model: 'm', ...o }),
    ],
    [
      'vLLM',
      'vllm',
      8000,
      (o: object) => new VllmTextGenerator({ model: 'm', ...o }),
    ],
    [
      'llama.cpp server',
      'llamacpp',
      8080,
      (o: object) => new LlamaCppTextGenerator({ model: 'm', ...o }),
    ],
  ] as const;

  for (const [label, provider, port, make] of kinds) {
    void it(`${label}: uses its usual port, needs no key, and ignores the environment`, async () => {
      const savedKey = process.env['OPENAI_API_KEY'];
      const savedUrl = process.env['OPENAI_BASE_URL'];
      process.env['OPENAI_API_KEY'] = 'sk-from-environment';
      process.env['OPENAI_BASE_URL'] = 'https://example.invalid/v1';
      try {
        const fake = sdkWith();
        const generator = make({ model: 'my-model', loadModule: fake.load });
        assert.equal(generator.provider, provider);
        assert.equal(generator.model, 'my-model');
        const result = await generator.generateText(ask);
        assert.deepEqual(result, { ok: true, value: { text: 'A caption' } });
        const request = fake.seen[0];
        assert.equal(
          request?.url,
          `http://127.0.0.1:${port}/v1/chat/completions`
        );
        assert.doesNotMatch(
          request?.headers.get('authorization') ?? '',
          /from-environment/
        );
        assert.equal((request?.body as { model: string }).model, 'my-model');
      } finally {
        if (savedKey === undefined) delete process.env['OPENAI_API_KEY'];
        else process.env['OPENAI_API_KEY'] = savedKey;
        if (savedUrl === undefined) delete process.env['OPENAI_BASE_URL'];
        else process.env['OPENAI_BASE_URL'] = savedUrl;
      }
    });
  }

  void it('sends a key when the server was started with one', async () => {
    const fake = sdkWith();
    await new VllmTextGenerator({
      model: 'm',
      apiKey: ' secret-vllm-key ',
      loadModule: fake.load,
    }).generateText(ask);
    assert.equal(
      fake.seen[0]?.headers.get('authorization'),
      'Bearer secret-vllm-key'
    );
  });

  void it('takes another host, port and API path', async () => {
    const fake = sdkWith();
    await new LmStudioTextGenerator({
      model: 'm',
      host: 'http://gpu-box:5000/',
      allowedHosts: ['gpu-box'],
      apiPath: 'openai/v1/',
      loadModule: fake.load,
    }).generateText(ask);
    assert.equal(
      fake.seen[0]?.url,
      'http://gpu-box:5000/openai/v1/chat/completions'
    );
  });

  void it('refuses a remote, malformed or credentialed host before sending anything', async () => {
    for (const host of [
      'https://api.example.com',
      'http://192.168.1.20:1234',
      'not a url',
      'http://user:secret@127.0.0.1:1234',
      'http://127.0.0.1:1234/v1',
    ]) {
      const fake = sdkWith();
      const result = await new LmStudioTextGenerator({
        model: 'm',
        host,
        loadModule: fake.load,
      }).generateText(ask);
      assert.match(errorOf(result), /^The LM Studio host /, host);
      assert.doesNotMatch(errorOf(result), /secret/, host);
      assert.equal(fake.seen.length, 0, host);
    }
  });

  void it('refuses an odd API path, and a missing model, before sending anything', async () => {
    const fake = sdkWith();
    const badPath = await new VllmTextGenerator({
      model: 'm',
      apiPath: '/v1?x=1',
      loadModule: fake.load,
    }).generateText(ask);
    assert.match(errorOf(badPath), /apiPath must be letters/);
    const noModel = await new LlamaCppTextGenerator({
      model: ' ',
      loadModule: fake.load,
    }).generateText(ask);
    assert.match(
      errorOf(noModel),
      /No llama\.cpp server model is set; pass model/
    );
    assert.equal(fake.seen.length, 0);
  });

  void it('names the package when it is not installed', async () => {
    const result = await new LmStudioTextGenerator({
      model: 'm',
      loadModule: () => Promise.reject(new Error('Cannot find module')),
    }).generateText(ask);
    assert.match(
      errorOf(result),
      /The LM Studio provider needs the optional package openai;/
    );
  });
});

void describe('OpenAiCompatibleTextGenerator', () => {
  void it('needs a host, uses the given name, and checks the host', async () => {
    const fake = sdkWith();
    const generator = new OpenAiCompatibleTextGenerator({
      name: 'jan',
      host: 'http://127.0.0.1:1337',
      model: 'm',
      loadModule: fake.load,
    });
    assert.equal(generator.provider, 'jan');
    await generator.generateText(ask);
    assert.equal(
      fake.seen[0]?.url,
      'http://127.0.0.1:1337/v1/chat/completions'
    );

    const remote = await new OpenAiCompatibleTextGenerator({
      name: 'jan',
      host: 'https://example.com',
      model: 'm',
      loadModule: fake.load,
    }).generateText(ask);
    assert.match(errorOf(remote), /^The jan host .*isn't this machine/);
    assert.equal(fake.seen.length, 1);
  });

  void it('defaults its name and keeps keys out of JSON, spreads and inspect output', () => {
    const generator = new OpenAiCompatibleTextGenerator({
      host: 'http://127.0.0.1:1',
      model: 'm',
      apiKey: KEY,
    });
    assert.equal(generator.provider, 'openai-compatible');
    for (const target of [
      generator,
      new OpenRouterTextGenerator({ apiKey: KEY }),
    ]) {
      assert.doesNotMatch(JSON.stringify(target), /test-key/);
      assert.doesNotMatch(JSON.stringify({ ...target }), /test-key/);
      assert.doesNotMatch(
        inspect(target, { showHidden: true, depth: 5 }),
        /test-key/
      );
    }
  });
});
