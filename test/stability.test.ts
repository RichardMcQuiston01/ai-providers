import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import type { ImageRequest } from '../src/index.js';
import {
  DEFAULT_STABILITY_IMAGE_MODEL,
  StabilityImageGenerator,
} from '../src/stability.js';
import { fakeFetch, json, PNG_OUTPUT, PNG_OUTPUT_BASE64 } from './helpers.js';

const KEY = 'sk-stability-test-key-1234567890';
const PHOTO = { mimeType: 'image/png', data: PNG_OUTPUT };

const request = (overrides: Partial<ImageRequest> = {}): ImageRequest => ({
  instructions: 'Keep the product unchanged.',
  prompt: 'A bright kitchen.',
  images: [PHOTO],
  mode: null,
  ...overrides,
});

const success = (extra: Record<string, unknown> = {}): Response =>
  json({
    image: PNG_OUTPUT_BASE64,
    finish_reason: 'SUCCESS',
    seed: 7,
    ...extra,
  });

const SD3 = 'POST /v2beta/stable-image/generate/sd3';

function formOf(init: RequestInit | undefined): FormData {
  assert.ok(init?.body instanceof FormData);
  return init.body;
}

void describe('StabilityImageGenerator', () => {
  void it('runs image-to-image by default and returns the PNG', async () => {
    const { fetch, calls } = fakeFetch({ [SD3]: success });
    const generator = new StabilityImageGenerator({
      apiKey: KEY,
      strength: 0.4,
      input: { seed: 7, negative_prompt: 'blur' },
      fetch,
    });
    const result = await generator.generateImage(request());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.image.mimeType, 'image/png');
    assert.deepEqual(result.value.image.data, PNG_OUTPUT);
    assert.equal(result.value.notes, 'seed 7');
    assert.equal(calls.length, 1);
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('content-type'), null);
    const form = formOf(calls[0]?.init);
    assert.equal(form.get('mode'), 'image-to-image');
    assert.equal(form.get('model'), DEFAULT_STABILITY_IMAGE_MODEL);
    assert.equal(form.get('strength'), '0.4');
    assert.equal(form.get('seed'), '7');
    assert.equal(form.get('negative_prompt'), 'blur');
    assert.equal(form.get('output_format'), 'png');
    assert.equal(
      form.get('prompt'),
      'Keep the product unchanged.\n\nA bright kitchen.'
    );
    assert.ok(form.get('image') instanceof Blob);
  });

  void it('lists its modes', async () => {
    const generator = new StabilityImageGenerator({ apiKey: KEY });
    const modes = await generator.listModes();
    assert.deepEqual(modes.ok && modes.value, [
      'image-to-image',
      'structure',
      'search-and-replace',
      'search-and-recolor',
      'remove-background',
    ]);
  });

  void it('sends search-and-replace to its endpoint with search_prompt', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v2beta/stable-image/edit/search-and-replace': success,
    });
    const generator = new StabilityImageGenerator({
      apiKey: KEY,
      searchPrompt: 'the mug',
      fetch,
    });
    const result = await generator.generateImage(
      request({ mode: 'search-and-replace' })
    );
    assert.equal(result.ok, true);
    assert.equal(formOf(calls[0]?.init).get('search_prompt'), 'the mug');
  });

  void it('needs searchPrompt and selectPrompt for their modes', async () => {
    const { fetch, calls } = fakeFetch({});
    const generator = new StabilityImageGenerator({ apiKey: KEY, fetch });
    const replace = await generator.generateImage(
      request({ mode: 'search-and-replace' })
    );
    const recolor = await generator.generateImage(
      request({ mode: 'search-and-recolor' })
    );
    assert.equal(!replace.ok && /needs searchPrompt/.test(replace.error), true);
    assert.equal(!recolor.ok && /needs selectPrompt/.test(recolor.error), true);
    assert.equal(calls.length, 0);
  });

  void it('remove-background sends no prompt', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /v2beta/stable-image/edit/remove-background': success,
    });
    const generator = new StabilityImageGenerator({ apiKey: KEY, fetch });
    const result = await generator.generateImage(
      request({ mode: 'remove-background' })
    );
    assert.equal(result.ok, true);
    assert.equal(formOf(calls[0]?.init).get('prompt'), null);
  });

  void it('refuses an unknown mode, no key, no image, references and bad types', async () => {
    const { fetch, calls } = fakeFetch({});
    const generator = new StabilityImageGenerator({ apiKey: KEY, fetch });
    const cases: Array<[string, Promise<{ ok: boolean; error?: string }>]> = [
      ['no mode "x"', generator.generateImage(request({ mode: 'x' }))],
      ['needs an image', generator.generateImage(request({ images: [] }))],
      [
        'edits one image',
        generator.generateImage(request({ images: [PHOTO, PHOTO] })),
      ],
      [
        'image/gif',
        generator.generateImage(
          request({ images: [{ mimeType: 'image/gif', data: PNG_OUTPUT }] })
        ),
      ],
      [
        'No Stability AI API key',
        new StabilityImageGenerator({ apiKey: ' ', fetch }).generateImage(
          request()
        ),
      ],
    ];
    for (const [expected, pending] of cases) {
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', new RegExp(expected));
    }
    assert.equal(calls.length, 0);
  });

  void it('does not let input override fields it sets', async () => {
    const { fetch, calls } = fakeFetch({ [SD3]: success });
    const generator = new StabilityImageGenerator({
      apiKey: KEY,
      input: { prompt: 'something else' },
      fetch,
    });
    const result = await generator.generateImage(request());
    assert.equal(!result.ok && /can't set "prompt"/.test(result.error), true);
    assert.equal(calls.length, 0);
  });

  void it('reports CONTENT_FILTERED and other finish reasons', async () => {
    const filtered = fakeFetch({
      [SD3]: () => success({ finish_reason: 'CONTENT_FILTERED' }),
    });
    const result = await new StabilityImageGenerator({
      apiKey: KEY,
      fetch: filtered.fetch,
    }).generateImage(request());
    assert.equal(!result.ok && /CONTENT_FILTERED/.test(result.error), true);
  });

  void it("includes Stability's own message in HTTP errors", async () => {
    const { fetch } = fakeFetch({
      [SD3]: () =>
        json(
          { name: 'content_moderation', errors: ['Your request was flagged.'] },
          403
        ),
    });
    const result = await new StabilityImageGenerator({
      apiKey: KEY,
      fetch,
    }).generateImage(request());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /HTTP 403/);
      assert.match(result.error, /Your request was flagged\./);
      assert.equal(result.error.includes(KEY), false);
    }
  });

  void it('rejects a reply that is not a PNG, JPEG or WebP', async () => {
    const { fetch } = fakeFetch({
      [SD3]: () =>
        json({ image: btoa('not an image'), finish_reason: 'SUCCESS' }),
    });
    const result = await new StabilityImageGenerator({
      apiKey: KEY,
      fetch,
    }).generateImage(request());
    assert.equal(
      !result.ok && /isn't a PNG, JPEG or WebP/.test(result.error),
      true
    );
  });

  void it('returns an error, not an exception, when cancelled', async () => {
    const { fetch, calls } = fakeFetch({ [SD3]: success });
    const controller = new AbortController();
    controller.abort();
    const result = await new StabilityImageGenerator({
      apiKey: KEY,
      fetch,
    }).generateImage(request({ signal: controller.signal }));
    assert.equal(!result.ok && /was cancelled/.test(result.error), true);
    assert.equal(calls.length, 0);
  });

  void it('keeps the key out of inspect and JSON', () => {
    const generator = new StabilityImageGenerator({ apiKey: KEY });
    assert.equal(inspect(generator).includes(KEY), false);
    assert.equal(JSON.stringify(generator).includes(KEY), false);
  });
});
