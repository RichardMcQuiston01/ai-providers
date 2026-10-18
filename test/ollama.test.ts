import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ok,
  listOllamaModels,
  OllamaTextGenerator,
  stripThinking,
  type FetchLike,
} from '../src/index.js';
import { fakeFetch, json } from './helpers.js';

const PHOTO = {
  mimeType: 'image/png',
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

void describe('OllamaTextGenerator host check', () => {
  void it('refuses a remote, malformed or credentialed host before sending anything', async () => {
    for (const host of [
      'https://example.com',
      'http://127.0.0.1:11434/api',
      'not a url',
      'http://user:secret@127.0.0.1:11434',
    ]) {
      const fake = fakeFetch({});
      const result = await new OllamaTextGenerator({
        model: 'm',
        host,
        fetch: fake.fetch,
      }).generateText({ instructions: '', prompt: 'p' });
      assert.equal(result.ok, false, host);
      assert.match((result as { error: string }).error, /^The Ollama host /);
      assert.doesNotMatch((result as { error: string }).error, /secret/);
      assert.equal(fake.calls.length, 0, host);
    }
  });

  void it('uses the default host for an empty one and keeps the origin only', async () => {
    const fake = fakeFetch({
      'POST /api/chat': json({ message: { content: 'ok' } }),
    });
    await new OllamaTextGenerator({
      model: 'm',
      host: ' ',
      fetch: fake.fetch,
    }).generateText({ instructions: '', prompt: 'p' });
    await new OllamaTextGenerator({
      model: 'm',
      host: 'http://localhost:11434/',
      fetch: fake.fetch,
    }).generateText({ instructions: '', prompt: 'p' });
    assert.deepEqual(
      fake.calls.map((call) => call.url.origin),
      ['http://127.0.0.1:11434', 'http://localhost:11434']
    );
  });
});

void describe('OllamaTextGenerator', () => {
  void it('sends a non-streamed chat with the rules as the system message', async () => {
    const fake = fakeFetch({
      'POST /api/chat': json({
        message: { role: 'assistant', content: '<think>…</think>New caption' },
      }),
    });
    const generator = new OllamaTextGenerator({
      model: 'llama3.2',
      fetch: fake.fetch,
    });
    const result = await generator.generateText({
      instructions: 'RULES',
      prompt: 'PROMPT',
    });
    assert.deepEqual(result, ok({ text: 'New caption' }));
    const sent = JSON.parse(String(fake.calls[0]?.init?.body)) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(sent.model, 'llama3.2');
    assert.equal(sent.stream, false);
    assert.deepEqual(
      sent.messages.map((message) => message.role),
      ['system', 'user']
    );
    assert.equal(sent.messages[0]?.content, 'RULES');
    assert.equal(
      fake.calls[0]?.url.toString(),
      'http://127.0.0.1:11434/api/chat'
    );
  });

  void it('sends images base64 for vision models, to a custom host', async () => {
    const fake = fakeFetch({
      'POST /api/chat': json({ message: { content: 'ok' } }),
    });
    const generator = new OllamaTextGenerator({
      model: 'llava',
      host: 'http://gpu.lan:11434/',
      allowedHosts: ['gpu.lan'],
      fetch: fake.fetch,
    });
    await generator.generateText({
      instructions: '',
      prompt: 'p',
      images: [PHOTO],
    });
    assert.equal(fake.calls[0]?.url.origin, 'http://gpu.lan:11434');
    const sent = JSON.parse(String(fake.calls[0]?.init?.body)) as {
      messages: Array<{ images?: string[] }>;
    };
    assert.deepEqual(sent.messages[1]?.images, ['iVBORw==']);
  });

  void it('refuses an empty model and an empty reply', async () => {
    const empty = await new OllamaTextGenerator({ model: ' ' }).generateText({
      instructions: '',
      prompt: 'p',
    });
    assert.match((empty as { error: string }).error, /No Ollama model/);
    const blank = fakeFetch({
      'POST /api/chat': json({ message: { content: '<think>x</think>  ' } }),
    });
    const reply = await new OllamaTextGenerator({
      model: 'm',
      fetch: blank.fetch,
    }).generateText({ instructions: '', prompt: 'p' });
    assert.match((reply as { error: string }).error, /empty reply/);
    assert.equal(stripThinking('<THINK>a\nb</THINK> Hi '), 'Hi');
  });

  void it('names the model and the error, and says when Ollama is down', async () => {
    const missing = fakeFetch({
      'POST /api/chat': json({ error: 'model "x" not found' }, 404),
    });
    const result = await new OllamaTextGenerator({
      model: 'x',
      fetch: missing.fetch,
    }).generateText({
      instructions: '',
      prompt: 'p',
    });
    assert.match(
      (result as { error: string }).error,
      /Ollama \(model "x"\) failed \(HTTP 404\): model "x" not found/
    );

    const down: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const offline = await new OllamaTextGenerator({
      model: 'x',
      fetch: down,
    }).generateText({
      instructions: '',
      prompt: 'p',
    });
    assert.match(
      (offline as { error: string }).error,
      /Could not reach .*127\.0\.0\.1:11434.*Is it running\?/
    );
  });
});

void describe('stripThinking', () => {
  void it('drops several blocks and keeps the text between them', () => {
    assert.equal(
      stripThinking('<think>a</think>One <think>b</think>two'),
      'One two'
    );
  });

  void it('drops an unclosed block and everything after it', () => {
    assert.equal(stripThinking('<think>reasoning, then truncated'), '');
    assert.equal(stripThinking('Visible. <think>secret, cut off'), 'Visible.');
    assert.equal(
      stripThinking('<think>done</think>Answer <THINK>more reasoning'),
      'Answer'
    );
  });

  void it('removes nested blocks completely', () => {
    assert.equal(
      stripThinking(
        '<think>outer <think>inner</think> still thinking</think> visible'
      ),
      'visible'
    );
    assert.equal(
      stripThinking('<think><think><think>x</think></think></think>ok'),
      'ok'
    );
  });

  void it('leaves text without think tags, and tags with attributes, alone or removed', () => {
    assert.equal(stripThinking('  plain  '), 'plain');
    assert.equal(stripThinking('a < b and <thinking>'), 'a < b and <thinking>');
    assert.equal(stripThinking('<think id="1">x</think>ok'), 'ok');
  });

  void it('reports an empty reply when a generation is only an unclosed block', async () => {
    const fake = fakeFetch({
      'POST /api/chat': json({ message: { content: '<think>never ends' } }),
    });
    const result = await new OllamaTextGenerator({
      model: 'm',
      fetch: fake.fetch,
    }).generateText({ instructions: '', prompt: 'p' });
    assert.match((result as { error: string }).error, /empty reply/);
  });
});

void describe('listOllamaModels', () => {
  const tags = (): Response =>
    json({
      models: [
        { name: 'qwen3:8b', model: 'qwen3:8b', size: 1 },
        { name: 'llama3.2:latest', model: 'llama3.2:latest' },
        { name: 'llama3.2:latest' },
        { name: '' },
        { size: 3 },
      ],
    });

  void it('lists the pulled models, sorted and without duplicates', async () => {
    const fake = fakeFetch({ 'GET /api/tags': tags });
    const result = await listOllamaModels({ fetch: fake.fetch });
    assert.deepEqual(result, ok(['llama3.2:latest', 'qwen3:8b']));
    assert.equal(
      fake.calls[0]?.url.toString(),
      'http://127.0.0.1:11434/api/tags'
    );
  });

  void it('works on a generator without sending a chat, on its host', async () => {
    const fake = fakeFetch({ 'GET /api/tags': tags });
    const generator = new OllamaTextGenerator({
      model: 'm',
      host: 'http://gpu.lan:11434',
      allowedHosts: ['gpu.lan'],
      fetch: fake.fetch,
    });
    const result = await generator.listModels();
    assert.equal(result.ok && result.value.length, 2);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0]?.url.host, 'gpu.lan:11434');
  });

  void it('refuses a remote or credentialed host before sending anything', async () => {
    for (const host of [
      'https://example.com',
      'http://user:secret@127.0.0.1:11434',
    ]) {
      const fake = fakeFetch({ 'GET /api/tags': tags });
      const result = await listOllamaModels({ host, fetch: fake.fetch });
      assert.equal(result.ok, false, host);
      assert.match((result as { error: string }).error, /^The Ollama host /);
      assert.doesNotMatch((result as { error: string }).error, /secret/);
      assert.equal(fake.calls.length, 0, host);
    }
  });

  void it('names the error when Ollama fails, is down, or answers oddly', async () => {
    const failing = fakeFetch({
      'GET /api/tags': () => json({ error: 'boom' }, 500),
    });
    const failed = await listOllamaModels({ fetch: failing.fetch });
    assert.equal(
      !failed.ok &&
        /Ollama \(listing models\) failed \(HTTP 500\): boom/.test(
          failed.error
        ),
      true
    );
    const offline = await listOllamaModels({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    assert.equal(!offline.ok && /Is it running\?/.test(offline.error), true);
    const odd = fakeFetch({ 'GET /api/tags': () => json({ nope: 1 }) });
    const noList = await listOllamaModels({ fetch: odd.fetch });
    assert.equal(
      !noList.ok && /returned no model list/.test(noList.error),
      true
    );
  });

  void it('returns an error, not an exception, when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    // Like real fetch, reject when the signal has already fired.
    const result = await listOllamaModels(
      {
        fetch: (_input, init) =>
          init?.signal?.aborted === true
            ? Promise.reject(new DOMException('aborted', 'AbortError'))
            : Promise.resolve(json({ models: [] })),
      },
      controller.signal
    );
    assert.equal(!result.ok && /was cancelled/.test(result.error), true);
  });
});
