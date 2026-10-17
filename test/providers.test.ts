import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { memoryWorkflowSource } from '../src/index.js';
import {
  IMAGE_PROVIDERS,
  TEXT_PROVIDERS,
  createImageGenerator,
  createProviders,
  createTextGenerator,
  type ImageProviderConfig,
  type TextProviderConfig,
} from '../src/providers.js';

const KEY = 'test-key-1234567890';

const TEXT_CONFIGS: Record<string, TextProviderConfig> = {
  ollama: { provider: 'ollama', model: 'llama3.2' },
  gemini: { provider: 'gemini', apiKey: KEY },
  claude: { provider: 'claude', apiKey: KEY },
  openai: { provider: 'openai', apiKey: KEY },
  grok: { provider: 'grok', apiKey: KEY },
  openrouter: { provider: 'openrouter', apiKey: KEY },
  lmstudio: { provider: 'lmstudio', model: 'm' },
  vllm: { provider: 'vllm', model: 'm' },
  llamacpp: { provider: 'llamacpp', model: 'm' },
  'openai-compatible': {
    provider: 'openai-compatible',
    model: 'm',
    host: 'http://127.0.0.1:5000',
  },
};

const IMAGE_CONFIGS: Record<string, ImageProviderConfig> = {
  comfyui: { provider: 'comfyui', workflows: memoryWorkflowSource({}) },
  gemini: { provider: 'gemini', apiKey: KEY },
  openai: { provider: 'openai', apiKey: KEY },
  grok: { provider: 'grok', apiKey: KEY },
  replicate: { provider: 'replicate', apiKey: KEY },
  fal: { provider: 'fal', apiKey: KEY },
  bfl: { provider: 'bfl', apiKey: KEY },
  stability: { provider: 'stability', apiKey: KEY },
  sdwebui: { provider: 'sdwebui' },
};

void describe('createTextGenerator', () => {
  void it('has a test config for every listed provider', () => {
    assert.deepEqual(
      Object.keys(TEXT_CONFIGS).sort(),
      [...TEXT_PROVIDERS].sort()
    );
  });

  for (const [name, config] of Object.entries(TEXT_CONFIGS)) {
    void it(`builds ${name}`, () => {
      const result = createTextGenerator(config);
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(typeof result.value.generateText, 'function');
    });
  }

  void it('passes the provider options through', () => {
    const result = createTextGenerator({
      provider: 'ollama',
      model: 'qwen3',
    });
    assert.equal(result.ok && result.value.model, 'qwen3');
    assert.equal(result.ok && result.value.provider, 'ollama');
  });

  void it('names the valid providers for an unknown or missing one', () => {
    for (const config of [{ provider: 'nope' }, {}, null, 'ollama', []]) {
      const result = createTextGenerator(
        config as unknown as TextProviderConfig
      );
      assert.equal(result.ok, false);
      assert.match(
        (result as { error: string }).error,
        /ollama, gemini, claude/
      );
    }
  });
});

void describe('createImageGenerator', () => {
  void it('has a test config for every listed provider', () => {
    assert.deepEqual(
      Object.keys(IMAGE_CONFIGS).sort(),
      [...IMAGE_PROVIDERS].sort()
    );
  });

  for (const [name, config] of Object.entries(IMAGE_CONFIGS)) {
    void it(`builds ${name}`, () => {
      const result = createImageGenerator(config);
      assert.equal(result.ok, true);
      if (result.ok)
        assert.equal(typeof result.value.generateImage, 'function');
    });
  }

  void it('reports the provider it built', () => {
    const result = createImageGenerator({ provider: 'bfl', apiKey: KEY });
    assert.equal(result.ok && result.value.provider, 'bfl');
  });

  void it('names the valid providers for an unknown one', () => {
    const result = createImageGenerator({
      provider: 'ollama',
    } as unknown as ImageProviderConfig);
    assert.equal(result.ok, false);
    assert.match(
      (result as { error: string }).error,
      /Unknown image provider "ollama"; use one of comfyui, gemini/
    );
  });

  void it('keeps the key out of the generator', () => {
    const result = createImageGenerator({ provider: 'stability', apiKey: KEY });
    assert.equal(JSON.stringify(result).includes(KEY), false);
  });
});

void describe('createProviders', () => {
  void it('builds both, one, or neither', () => {
    const both = createProviders({
      text: { provider: 'ollama', model: 'm' },
      image: { provider: 'sdwebui' },
    });
    assert.equal(both.ok && both.value.text?.provider, 'ollama');
    assert.equal(both.ok && both.value.image?.provider, 'sdwebui');
    const textOnly = createProviders({
      text: { provider: 'ollama', model: 'm' },
    });
    assert.equal(textOnly.ok && textOnly.value.image, null);
    const none = createProviders({});
    assert.deepEqual(none.ok && none.value, { text: null, image: null });
  });

  void it('returns the first bad setting as the error', () => {
    const result = createProviders({
      text: { provider: 'nope' } as unknown as TextProviderConfig,
      image: { provider: 'sdwebui' },
    });
    assert.equal(result.ok, false);
    assert.match(
      (result as { error: string }).error,
      /Unknown text provider "nope"/
    );
  });
});
