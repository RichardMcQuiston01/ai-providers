import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ok,
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
