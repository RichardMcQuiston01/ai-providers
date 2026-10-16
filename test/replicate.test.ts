import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import {
  DEFAULT_REPLICATE_IMAGE_MODEL,
  ReplicateImageGenerator,
  type ImageRequest,
} from '../src/index.js';
import { fakeFetch, json, PNG_OUTPUT } from './helpers.js';

const KEY = 'r8_test-key-1234567890';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const CREATE = 'POST /v1/models/black-forest-labs/flux-kontext-pro/predictions';
const OUTPUT_URL = 'https://replicate.delivery/xezq/abc/out.png';

const request: ImageRequest = {
  instructions: 'RULES',
  prompt: 'PROMPT',
  images: [{ mimeType: 'image/png', data: PNG }],
  mode: null,
};

const prediction = (
  status: string,
  extra: Record<string, unknown> = {}
): Response => json({ id: 'p1', status, output: null, error: null, ...extra });

const image = (): Response =>
  new Response(PNG_OUTPUT, {
    headers: { 'content-type': 'image/png' },
  });

const noSleep = (): Promise<void> => Promise.resolve();

function errorOf(result: { ok: boolean; error?: string }): string {
  return result.ok ? '' : (result.error ?? '');
}

void describe('ReplicateImageGenerator', () => {
  void it('creates a prediction, then downloads the output without the token', async () => {
    const fake = fakeFetch({
      [CREATE]: prediction('succeeded', { output: OUTPUT_URL }),
      'GET /xezq/abc/out.png': image,
    });
    const generator = new ReplicateImageGenerator({
      apiKey: ` ${KEY} `,
      input: { output_format: 'png' },
      fetch: fake.fetch,
      sleep: noSleep,
    });
    assert.deepEqual(await generator.listModes(), {
      ok: true,
      value: [DEFAULT_REPLICATE_IMAGE_MODEL],
    });
    const result = await generator.generateImage(request);
    assert.deepEqual(result, {
      ok: true,
      value: {
        image: { mimeType: 'image/png', data: PNG_OUTPUT },
        notes: null,
      },
    });
    const [create, download] = fake.calls;
    assert.ok(create && download);
    const headers = new Headers(create.init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
    assert.equal(headers.get('prefer'), 'wait=30');
    assert.deepEqual(JSON.parse(String(create.init?.body)), {
      input: {
        output_format: 'png',
        prompt: 'RULES\n\nPROMPT',
        input_image: 'data:image/png;base64,iVBORw==',
      },
    });
    assert.equal(download.url.toString(), OUTPUT_URL);
    assert.equal(
      new Headers(download.init?.headers).get('authorization'),
      null
    );
  });

  void it('polls until the prediction succeeds and takes the first of a list of outputs', async () => {
    const fake = fakeFetch({
      [CREATE]: prediction('starting'),
      'GET /v1/predictions/p1': [
        () => prediction('processing'),
        () => prediction('succeeded', { output: [OUTPUT_URL, 'ignored'] }),
      ],
      'GET /xezq/abc/out.png': image,
    });
    const sleeps: number[] = [];
    const result = await new ReplicateImageGenerator({
      apiKey: KEY,
      fetch: fake.fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).generateImage(request);
    assert.equal(result.ok, true);
    assert.deepEqual(sleeps, [2000, 2000]);
  });

  void it('pins a version and sends the configured input names and references', async () => {
    const fake = fakeFetch({
      'POST /v1/predictions': prediction('succeeded', { output: OUTPUT_URL }),
      'GET /xezq/abc/out.png': image,
    });
    await new ReplicateImageGenerator({
      apiKey: KEY,
      model: 'acme/edit:abc123',
      imageInput: 'image',
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
    assert.deepEqual(JSON.parse(String(fake.calls[0]?.init?.body)), {
      version: 'abc123',
      input: {
        text: 'PROMPT',
        image: 'data:image/png;base64,iVBORw==',
        refs: ['data:image/jpeg;base64,CQ=='],
      },
    });
  });

  void it("reports a failed or canceled prediction with Replicate's message", async () => {
    const failed = await new ReplicateImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        [CREATE]: prediction('failed', { error: 'NSFW content detected' }),
      }).fetch,
    }).generateImage(request);
    assert.equal(
      errorOf(failed),
      'Replicate (model "black-forest-labs/flux-kontext-pro") failed: NSFW content detected'
    );
    const canceled = await new ReplicateImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({ [CREATE]: prediction('canceled') }).fetch,
    }).generateImage(request);
    assert.match(errorOf(canceled), /was canceled on Replicate/);
  });

  void it('cancels the prediction when the run takes too long', async () => {
    let clock = 0;
    const fake = fakeFetch({
      [CREATE]: prediction('processing'),
      'GET /v1/predictions/p1': () => prediction('processing'),
      'POST /v1/predictions/p1/cancel': () => prediction('canceled'),
    });
    const result = await new ReplicateImageGenerator({
      apiKey: KEY,
      runTimeoutMs: 5000,
      fetch: fake.fetch,
      now: () => clock,
      sleep: () => {
        clock += 2000;
        return Promise.resolve();
      },
    }).generateImage(request);
    assert.match(errorOf(result), /didn't finish within 5 s and was cancelled/);
    assert.equal(fake.calls.at(-1)?.url.pathname, '/v1/predictions/p1/cancel');
  });

  void it('cancels the prediction when the caller aborts while it runs', async () => {
    const controller = new AbortController();
    const fake = fakeFetch({
      [CREATE]: prediction('processing'),
      'POST /v1/predictions/p1/cancel': () => prediction('canceled'),
    });
    const result = await new ReplicateImageGenerator({
      apiKey: KEY,
      fetch: fake.fetch,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    }).generateImage({ ...request, signal: controller.signal });
    assert.match(errorOf(result), /was cancelled/);
    assert.equal(fake.calls.at(-1)?.url.pathname, '/v1/predictions/p1/cancel');
  });

  void it('turns HTTP errors into specific messages without the token', async () => {
    const result = await new ReplicateImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        [CREATE]: json(
          { title: 'Unauthenticated', detail: 'Invalid token', status: 401 },
          401
        ),
      }).fetch,
    }).generateImage(request);
    const error = errorOf(result);
    assert.match(error, /failed \(HTTP 401\): Invalid token/);
    assert.doesNotMatch(error, /test-key/);
  });

  void it('does not download an output from another host or over http', async () => {
    for (const url of [
      'https://evil.example/out.png',
      'http://replicate.delivery/out.png',
      'https://replicate.delivery.evil.example/out.png',
    ]) {
      const fake = fakeFetch({
        [CREATE]: prediction('succeeded', { output: url }),
      });
      const result = await new ReplicateImageGenerator({
        apiKey: KEY,
        fetch: fake.fetch,
      }).generateImage(request);
      assert.match(
        errorOf(result),
        /isn't replicate\.delivery; it was not downloaded/
      );
      assert.equal(fake.calls.length, 1);
    }
  });

  void it('takes the type from the bytes, not the path or Content-Type', async () => {
    const run = async (body: BodyInit, contentType: string) => {
      const fake = fakeFetch({
        [CREATE]: prediction('succeeded', { output: OUTPUT_URL }),
        'GET /xezq/abc/out.png': () =>
          new Response(body, { headers: { 'content-type': contentType } }),
      });
      return new ReplicateImageGenerator({
        apiKey: KEY,
        fetch: fake.fetch,
      }).generateImage(request);
    };
    const asPng = await run(PNG_OUTPUT, 'image/svg+xml');
    assert.equal(asPng.ok && asPng.value.image.mimeType, 'image/png');
    const svg = await run(
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'image/png'
    );
    assert.match(errorOf(svg), /isn't a PNG, JPEG or WebP image/);
  });

  void it('follows a redirect only to replicate.delivery and counts the create request against the run time', async () => {
    const good = fakeFetch({
      [CREATE]: prediction('succeeded', { output: OUTPUT_URL }),
      'GET /xezq/abc/out.png': () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.replicate.delivery/moved/out.png' },
        }),
      'GET /moved/out.png': image,
    });
    const followed = await new ReplicateImageGenerator({
      apiKey: KEY,
      fetch: good.fetch,
    }).generateImage(request);
    assert.equal(followed.ok, true);

    const bad = fakeFetch({
      [CREATE]: prediction('succeeded', { output: OUTPUT_URL }),
      'GET /xezq/abc/out.png': () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        }),
    });
    const refused = await new ReplicateImageGenerator({
      apiKey: KEY,
      fetch: bad.fetch,
    }).generateImage(request);
    assert.match(
      errorOf(refused),
      /isn't replicate\.delivery; it was not downloaded/
    );
    assert.equal(bad.calls.length, 2);

    // The create request takes 4 s of a 5 s budget, so one poll interval is too much.
    let clock = 0;
    const slow = fakeFetch({
      [CREATE]: () => {
        clock += 4000;
        return prediction('processing');
      },
      'GET /v1/predictions/p1': () => prediction('processing'),
      'POST /v1/predictions/p1/cancel': () => prediction('canceled'),
    });
    const late = await new ReplicateImageGenerator({
      apiKey: KEY,
      runTimeoutMs: 5000,
      fetch: slow.fetch,
      now: () => clock,
      sleep: () => {
        clock += 2000;
        return Promise.resolve();
      },
    }).generateImage(request);
    assert.match(errorOf(late), /didn't finish within 5 s and was cancelled/);
    assert.equal(slow.calls.at(-1)?.url.pathname, '/v1/predictions/p1/cancel');
    assert.equal(
      slow.calls.filter((call) => call.init?.method === 'GET').length,
      0
    );
  });

  void it('rejects an output that is not an image, or is missing', async () => {
    const notImage = await new ReplicateImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        [CREATE]: prediction('succeeded', {
          output: 'https://replicate.delivery/x/out',
        }),
        'GET /x/out': () =>
          new Response('<html>nope</html>', {
            headers: { 'content-type': 'text/html' },
          }),
      }).fetch,
    }).generateImage(request);
    assert.match(
      errorOf(notImage),
      /returned data that isn't a PNG, JPEG or WebP image/
    );
    const none = await new ReplicateImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({ [CREATE]: prediction('succeeded') }).fetch,
    }).generateImage(request);
    assert.match(errorOf(none), /finished without an output image/);
  });

  void it('refuses bad input before calling', async () => {
    const fake = fakeFetch({});
    const run = async (
      overrides: Partial<ImageRequest> = {},
      options: { apiKey?: string; model?: string } = {}
    ): Promise<string> =>
      errorOf(
        await new ReplicateImageGenerator({
          apiKey: KEY,
          fetch: fake.fetch,
          ...options,
        }).generateImage({ ...request, ...overrides })
      );
    assert.match(await run({}, { apiKey: ' ' }), /No Replicate API token/);
    assert.match(await run({ mode: 'other' }), /has no mode "other"/);
    assert.match(await run({}, { model: 'not a model' }), /isn't valid/);
    assert.match(await run({}, { model: 'a/b:c:d' }), /isn't valid/);
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

  void it('keeps the token out of JSON, spreads and inspect output', () => {
    const generator = new ReplicateImageGenerator({ apiKey: KEY });
    assert.doesNotMatch(JSON.stringify(generator), /test-key/);
    assert.doesNotMatch(JSON.stringify({ ...generator }), /test-key/);
    assert.doesNotMatch(
      inspect(generator, { showHidden: true, depth: 5 }),
      /test-key/
    );
  });
});
