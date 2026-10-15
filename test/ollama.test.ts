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
