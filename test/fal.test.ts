import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import {
  DEFAULT_FAL_IMAGE_MODEL,
  FalImageGenerator,
  type ImageRequest,
} from '../src/index.js';
import { fakeFetch, json, PNG_OUTPUT, PNG_OUTPUT_BASE64 } from './helpers.js';

const KEY = 'fal-test-key-1234567890:abcdef';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const SUBMIT = 'POST /fal-ai/flux-pro/kontext';
const STATUS = 'GET /fal-ai/flux-pro/kontext/requests/r1/status';
const RESULT = 'GET /fal-ai/flux-pro/kontext/requests/r1';
const CANCEL = 'PUT /fal-ai/flux-pro/kontext/requests/r1/cancel';
const OUTPUT_URL = 'https://v3.fal.media/files/abc/out.png';

const request: ImageRequest = {
  instructions: 'RULES',
  prompt: 'PROMPT',
  images: [{ mimeType: 'image/png', data: PNG }],
  mode: null,
};

const queued = (overrides: Record<string, unknown> = {}): Response =>
  json({
    request_id: 'r1',
    status_url:
      'https://queue.fal.run/fal-ai/flux-pro/kontext/requests/r1/status',
    response_url: 'https://queue.fal.run/fal-ai/flux-pro/kontext/requests/r1',
    cancel_url:
      'https://queue.fal.run/fal-ai/flux-pro/kontext/requests/r1/cancel',
    ...overrides,
  });

const status = (value: string): Response => json({ status: value });
const imageResult = (url = OUTPUT_URL): Response =>
  json({ images: [{ url, content_type: 'image/png' }] });
const png = (): Response =>
  new Response(PNG_OUTPUT, { headers: { 'content-type': 'image/png' } });
const noSleep = (): Promise<void> => Promise.resolve();
const errorOf = (result: { ok: boolean; error?: string }): string =>
  result.ok ? '' : (result.error ?? '');

const happyRoutes = {
  [SUBMIT]: queued,
  [STATUS]: () => status('COMPLETED'),
  [RESULT]: () => imageResult(),
  'GET /files/abc/out.png': png,
};

void describe('FalImageGenerator', () => {
  void it('submits to the queue with a Key header, reads the result and downloads without the key', async () => {
    const fake = fakeFetch(happyRoutes);
    const generator = new FalImageGenerator({
      apiKey: ` ${KEY} `,
      input: { output_format: 'png' },
      fetch: fake.fetch,
      sleep: noSleep,
    });
    assert.deepEqual(await generator.listModes(), {
      ok: true,
      value: [DEFAULT_FAL_IMAGE_MODEL],
    });
    const result = await generator.generateImage(request);
    assert.deepEqual(result, {
      ok: true,
      value: {
        image: { mimeType: 'image/png', data: PNG_OUTPUT },
        notes: null,
      },
    });
    const [submit, poll, read, download] = fake.calls;
    assert.ok(submit && poll && read && download);
    assert.equal(
      submit.url.toString(),
      'https://queue.fal.run/fal-ai/flux-pro/kontext'
    );
    for (const call of [submit, poll, read]) {
      assert.equal(
        new Headers(call.init?.headers).get('authorization'),
        `Key ${KEY}`
      );
    }
    assert.deepEqual(JSON.parse(String(submit.init?.body)), {
      output_format: 'png',
      prompt: 'RULES\n\nPROMPT',
      image_url: 'data:image/png;base64,iVBORw==',
    });
    assert.equal(download.url.toString(), OUTPUT_URL);
    assert.equal(
      new Headers(download.init?.headers).get('authorization'),
      null
    );
  });

  void it('polls while the request is queued or running', async () => {
    const fake = fakeFetch({
      ...happyRoutes,
      [STATUS]: [
        () => status('IN_QUEUE'),
        () => status('IN_PROGRESS'),
        () => status('COMPLETED'),
      ],
    });
    const sleeps: number[] = [];
    const result = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fake.fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).generateImage(request);
    assert.equal(result.ok, true);
    assert.deepEqual(sleeps, [1000, 1000]);
  });

  void it('sends the configured input names and reference images', async () => {
    const fake = fakeFetch({
      'POST /fal-ai/custom/edit': queued({
        status_url: 'https://queue.fal.run/fal-ai/custom/requests/r1/status',
        response_url: 'https://queue.fal.run/fal-ai/custom/requests/r1',
        cancel_url: 'https://queue.fal.run/fal-ai/custom/requests/r1/cancel',
      }),
      'GET /fal-ai/custom/requests/r1/status': () => status('COMPLETED'),
      'GET /fal-ai/custom/requests/r1': () =>
        json({ image: { url: OUTPUT_URL } }),
      'GET /files/abc/out.png': png,
    });
    const result = await new FalImageGenerator({
      apiKey: KEY,
      model: 'fal-ai/custom/edit',
      imageInput: 'source',
      promptInput: 'text',
      referenceImagesInput: 'refs',
      fetch: fake.fetch,
    }).generateImage({
      ...request,
      instructions: '',
      images: [
        { mimeType: 'image/png', data: PNG },
        { mimeType: 'image/jpeg', data: new Uint8Array([9]) },
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(String(fake.calls[0]?.init?.body)), {
      text: 'PROMPT',
      source: 'data:image/png;base64,iVBORw==',
      refs: ['data:image/jpeg;base64,CQ=='],
    });
  });

  void it('decodes an output that comes back as a data URI', async () => {
    const result = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        [RESULT]: () =>
          imageResult(`data:image/png;base64,${PNG_OUTPUT_BASE64}`),
      }).fetch,
    }).generateImage(request);
    assert.deepEqual(result, {
      ok: true,
      value: {
        image: { mimeType: 'image/png', data: PNG_OUTPUT },
        notes: null,
      },
    });
  });

  void it("reports a failed run with fal's message", async () => {
    const result = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        [RESULT]: () => json({ detail: 'The image is too large' }, 422),
      }).fetch,
    }).generateImage(request);
    assert.match(
      errorOf(result),
      /^fal \(model "fal-ai\/flux-pro\/kontext"\) failed \(HTTP 422\): The image is too large/
    );
  });

  void it('turns HTTP errors on submit into specific messages without the key', async () => {
    const result = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        [SUBMIT]: json({ detail: 'Invalid API key' }, 401),
      }).fetch,
    }).generateImage(request);
    const error = errorOf(result);
    assert.match(error, /failed \(HTTP 401\): Invalid API key/);
    assert.doesNotMatch(error, /test-key/);
  });

  void it('cancels the request when the run takes too long', async () => {
    let clock = 0;
    const fake = fakeFetch({
      ...happyRoutes,
      [STATUS]: () => status('IN_PROGRESS'),
      [CANCEL]: () => json({ status: 'CANCELLATION_REQUESTED' }, 202),
    });
    const result = await new FalImageGenerator({
      apiKey: KEY,
      runTimeoutMs: 3000,
      fetch: fake.fetch,
      now: () => clock,
      sleep: () => {
        clock += 1500;
        return Promise.resolve();
      },
    }).generateImage(request);
    assert.match(errorOf(result), /didn't finish within 3 s and was cancelled/);
    const last = fake.calls.at(-1);
    assert.equal(last?.init?.method, 'PUT');
    assert.equal(
      last?.url.pathname,
      '/fal-ai/flux-pro/kontext/requests/r1/cancel'
    );
  });

  void it('cancels the request when the caller aborts while it runs', async () => {
    const controller = new AbortController();
    const fake = fakeFetch({
      ...happyRoutes,
      [STATUS]: () => status('IN_QUEUE'),
      [CANCEL]: () => json({}, 202),
    });
    const result = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fake.fetch,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    }).generateImage({ ...request, signal: controller.signal });
    assert.match(errorOf(result), /was cancelled/);
    assert.equal(fake.calls.at(-1)?.url.pathname.endsWith('/cancel'), true);
  });

  void it('never sends the key to a status, result or cancel URL outside queue.fal.run', async () => {
    for (const field of ['status_url', 'response_url', 'cancel_url']) {
      const fake = fakeFetch({
        [SUBMIT]: queued({ [field]: 'https://evil.example/steal' }),
      });
      const result = await new FalImageGenerator({
        apiKey: KEY,
        fetch: fake.fetch,
      }).generateImage(request);
      assert.match(
        errorOf(result),
        /isn't queue\.fal\.run; it was not called/,
        field
      );
      assert.equal(fake.calls.length, 1, field);
    }
    const http = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        [SUBMIT]: queued({ status_url: 'http://queue.fal.run/x' }),
      }).fetch,
    }).generateImage(request);
    assert.match(errorOf(http), /isn't queue\.fal\.run/);
    const missing = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({ [SUBMIT]: json({ request_id: 'r1' }) }).fetch,
    }).generateImage(request);
    assert.match(errorOf(missing), /didn't return a status_url/);
  });

  void it('downloads only from fal hosts, following a redirect only to one', async () => {
    for (const url of [
      'https://evil.example/out.png',
      'http://v3.fal.media/out.png',
      'https://fal.media.evil.example/out.png',
    ]) {
      const fake = fakeFetch({
        ...happyRoutes,
        [RESULT]: () => imageResult(url),
      });
      const result = await new FalImageGenerator({
        apiKey: KEY,
        fetch: fake.fetch,
      }).generateImage(request);
      assert.match(errorOf(result), /isn't fal\.media or fal\.run/, url);
      assert.equal(fake.calls.length, 3, url);
    }
    const good = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        'GET /files/abc/out.png': () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://v3b.fal.media/moved/out.png' },
          }),
        'GET /moved/out.png': png,
      }).fetch,
    }).generateImage(request);
    assert.equal(good.ok, true);
    const bad = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        'GET /files/abc/out.png': () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
          }),
      }).fetch,
    }).generateImage(request);
    assert.match(errorOf(bad), /isn't fal\.media or fal\.run/);
  });

  void it('accepts extra output hosts you list', async () => {
    const result = await new FalImageGenerator({
      apiKey: KEY,
      outputHosts: ['cdn.example.com'],
      fetch: fakeFetch({
        ...happyRoutes,
        [RESULT]: () =>
          imageResult('https://img.cdn.example.com/files/abc/out.png'),
      }).fetch,
    }).generateImage(request);
    assert.equal(result.ok, true);
  });

  void it('rejects output that is not PNG, JPEG or WebP, or is missing', async () => {
    const svg = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        'GET /files/abc/out.png': () =>
          new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
            headers: { 'content-type': 'image/png' },
          }),
      }).fetch,
    }).generateImage(request);
    assert.match(errorOf(svg), /isn't a PNG, JPEG or WebP image/);
    const none = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({ ...happyRoutes, [RESULT]: () => json({ images: [] }) })
        .fetch,
    }).generateImage(request);
    assert.match(errorOf(none), /finished without an output image/);
  });

  void it('reports an unexpected status', async () => {
    const result = await new FalImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({ ...happyRoutes, [STATUS]: () => status('WAT') }).fetch,
    }).generateImage(request);
    assert.match(errorOf(result), /unexpected status: WAT/);
  });

  void it('refuses bad input before calling', async () => {
    const fake = fakeFetch({});
    const run = async (
      overrides: Partial<ImageRequest> = {},
      options: { apiKey?: string; model?: string } = {}
    ): Promise<string> =>
      errorOf(
        await new FalImageGenerator({
          apiKey: KEY,
          fetch: fake.fetch,
          ...options,
        }).generateImage({ ...request, ...overrides })
      );
    assert.match(await run({}, { apiKey: ' ' }), /No fal API key/);
    assert.match(await run({ mode: 'other' }), /has no mode "other"/);
    assert.match(await run({}, { model: 'not a model' }), /isn't valid/);
    assert.match(await run({}, { model: 'single' }), /isn't valid/);
    assert.match(await run({ images: [] }), /needs an image to edit/);
    assert.match(
      await run({
        images: [
          { mimeType: 'image/png', data: PNG },
          { mimeType: 'image/png', data: PNG },
        ],
      }),
      /no referenceImagesInput is set/
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
    const generator = new FalImageGenerator({ apiKey: KEY });
    assert.doesNotMatch(JSON.stringify(generator), /test-key/);
    assert.doesNotMatch(JSON.stringify({ ...generator }), /test-key/);
    assert.doesNotMatch(
      inspect(generator, { showHidden: true, depth: 5 }),
      /test-key/
    );
  });
});
