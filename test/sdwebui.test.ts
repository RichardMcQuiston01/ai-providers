import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImageRequest } from '../src/index.js';
import { SdWebUiImageGenerator } from '../src/sdwebui.js';
import { fakeFetch, json, PNG_OUTPUT, PNG_OUTPUT_BASE64 } from './helpers.js';

/** A PNG header for a 640 x 480 image (signature, IHDR length and type, width, height). */
const PNG_640X480 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
  0x52, 0, 0, 2, 128, 0, 0, 1, 224,
]);
const PHOTO = { mimeType: 'image/png', data: PNG_640X480 };
const MASK = { mimeType: 'image/png', data: PNG_OUTPUT };
const ROUTE = 'POST /sdapi/v1/img2img';

const request = (overrides: Partial<ImageRequest> = {}): ImageRequest => ({
  instructions: 'Keep the product unchanged.',
  prompt: 'A bright kitchen.',
  images: [PHOTO],
  mode: null,
  ...overrides,
});

const reply = (): Response => json({ images: [PNG_OUTPUT_BASE64], info: '{}' });

function payloadOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

void describe('SdWebUiImageGenerator', () => {
  void it('posts an img2img payload and returns the PNG', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: reply });
    const generator = new SdWebUiImageGenerator({
      model: 'sdxl.safetensors',
      denoisingStrength: 0.4,
      input: { steps: 20, negative_prompt: 'blur' },
      fetch,
    });
    const result = await generator.generateImage(request());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.image.data, PNG_OUTPUT);
    assert.equal(calls[0]?.url.origin, 'http://127.0.0.1:7860');
    const payload = payloadOf(calls[0]?.init);
    assert.equal(
      payload['prompt'],
      'Keep the product unchanged.\n\nA bright kitchen.'
    );
    assert.equal(payload['denoising_strength'], 0.4);
    assert.equal(payload['steps'], 20);
    assert.equal(payload['negative_prompt'], 'blur');
    assert.equal(payload['width'], 640);
    assert.equal(payload['height'], 480);
    assert.equal(payload['save_images'], false);
    assert.deepEqual(payload['override_settings'], {
      sd_model_checkpoint: 'sdxl.safetensors',
    });
    assert.equal((payload['init_images'] as string[]).length, 1);
    assert.equal('mask' in payload, false);
  });

  void it('uses explicit width and height over the PNG size', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: reply });
    await new SdWebUiImageGenerator({
      width: 1024,
      height: 768,
      fetch,
    }).generateImage(request());
    const payload = payloadOf(calls[0]?.init);
    assert.equal(payload['width'], 1024);
    assert.equal(payload['height'], 768);
  });

  void it('omits the size for a non-PNG input', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: reply });
    await new SdWebUiImageGenerator({ fetch }).generateImage(
      request({
        images: [
          {
            mimeType: 'image/jpeg',
            data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
          },
        ],
      })
    );
    const payload = payloadOf(calls[0]?.init);
    assert.equal('width' in payload, false);
    assert.equal('height' in payload, false);
  });

  void it('inpaint sends the second image as the mask', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: reply });
    const result = await new SdWebUiImageGenerator({ fetch }).generateImage(
      request({ mode: 'inpaint', images: [PHOTO, MASK] })
    );
    assert.equal(result.ok, true);
    assert.equal(typeof payloadOf(calls[0]?.init)['mask'], 'string');
  });

  void it('lists its modes', async () => {
    const modes = await new SdWebUiImageGenerator({}).listModes();
    assert.deepEqual(modes.ok && modes.value, ['img2img', 'inpaint']);
  });

  void it('refuses bad requests before calling the web UI', async () => {
    const { fetch, calls } = fakeFetch({});
    const generator = new SdWebUiImageGenerator({
      fetch,
      input: { init_images: 'x' },
    });
    const plain = new SdWebUiImageGenerator({ fetch });
    const cases: Array<[string, Promise<{ ok: boolean; error?: string }>]> = [
      ['no mode "x"', plain.generateImage(request({ mode: 'x' }))],
      ['needs an image', plain.generateImage(request({ images: [] }))],
      ['needs a mask', plain.generateImage(request({ mode: 'inpaint' }))],
      [
        'Use the inpaint mode',
        plain.generateImage(request({ images: [PHOTO, MASK] })),
      ],
      [
        'image/gif',
        plain.generateImage(
          request({ images: [{ mimeType: 'image/gif', data: PNG_OUTPUT }] })
        ),
      ],
      ['can\'t set "init_images"', generator.generateImage(request())],
    ];
    for (const [expected, pending] of cases) {
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', new RegExp(expected));
    }
    assert.equal(calls.length, 0);
  });

  void it('refuses a remote, malformed or credentialed host before sending anything', async () => {
    for (const host of [
      'https://example.com',
      'http://127.0.0.1:7860/sdapi',
      'not a url',
      'http://user:secret@127.0.0.1:7860',
    ]) {
      const { fetch, calls } = fakeFetch({ [ROUTE]: reply });
      const result = await new SdWebUiImageGenerator({
        host,
        fetch,
      }).generateImage(request());
      assert.equal(result.ok, false, host);
      assert.match(
        (result as { error: string }).error,
        /^The Stable Diffusion web UI host /
      );
      assert.doesNotMatch((result as { error: string }).error, /secret/);
      assert.equal(calls.length, 0, host);
    }
  });

  void it('allows a listed host', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: reply });
    const result = await new SdWebUiImageGenerator({
      host: 'http://gpu-box:7860',
      allowedHosts: ['gpu-box'],
      fetch,
    }).generateImage(request());
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url.host, 'gpu-box:7860');
  });

  void it('names the error when the web UI fails or is down', async () => {
    const failing = fakeFetch({
      [ROUTE]: () => json({ detail: 'Not Found' }, 404),
    });
    const notFound = await new SdWebUiImageGenerator({
      fetch: failing.fetch,
    }).generateImage(request());
    assert.equal(
      !notFound.ok && /HTTP 404.*Not Found/.test(notFound.error),
      true
    );
    const offline = await new SdWebUiImageGenerator({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    }).generateImage(request());
    assert.equal(!offline.ok && /Is it running\?/.test(offline.error), true);
  });

  void it('rejects an empty reply and non-image data', async () => {
    const empty = fakeFetch({ [ROUTE]: () => json({ images: [] }) });
    const none = await new SdWebUiImageGenerator({
      fetch: empty.fetch,
    }).generateImage(request());
    assert.equal(!none.ok && /returned no image data/.test(none.error), true);
    const junk = fakeFetch({
      [ROUTE]: () => json({ images: [btoa('not an image')] }),
    });
    const bad = await new SdWebUiImageGenerator({
      fetch: junk.fetch,
    }).generateImage(request());
    assert.equal(!bad.ok && /isn't a PNG, JPEG or WebP/.test(bad.error), true);
  });

  void it('returns an error, not an exception, when cancelled', async () => {
    const { fetch, calls } = fakeFetch({ [ROUTE]: reply });
    const controller = new AbortController();
    controller.abort();
    const result = await new SdWebUiImageGenerator({ fetch }).generateImage(
      request({ signal: controller.signal })
    );
    assert.equal(!result.ok && /was cancelled/.test(result.error), true);
    assert.equal(calls.length, 0);
  });
});
