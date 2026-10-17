import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import {
  BflImageGenerator,
  DEFAULT_BFL_IMAGE_MODEL,
  type ImageRequest,
} from '../src/index.js';
import { fakeFetch, json, PNG_OUTPUT } from './helpers.js';

const KEY = 'bfl-test-key-1234567890';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const SUBMIT = 'POST /v1/flux-kontext-pro';
const POLL = 'GET /v1/get_result';
const OUTPUT_URL = 'https://delivery-eu1.bfl.ai/results/abc/sample.png';

const request: ImageRequest = {
  instructions: 'RULES',
  prompt: 'PROMPT',
  images: [{ mimeType: 'image/png', data: PNG }],
  mode: null,
};

const submitted = (
  pollingUrl = 'https://api.bfl.ai/v1/get_result?id=t1'
): Response => json({ id: 't1', polling_url: pollingUrl });
const pending = (): Response => json({ id: 't1', status: 'Pending' });
const ready = (sample = OUTPUT_URL): Response =>
  json({ id: 't1', status: 'Ready', result: { sample } });
const png = (): Response =>
  new Response(PNG_OUTPUT, { headers: { 'content-type': 'image/jpeg' } });
const noSleep = (): Promise<void> => Promise.resolve();
const errorOf = (result: { ok: boolean; error?: string }): string =>
  result.ok ? '' : (result.error ?? '');

const happyRoutes = {
  [SUBMIT]: submitted,
  [POLL]: () => ready(),
  'GET /results/abc/sample.png': png,
};

void describe('BflImageGenerator', () => {
  void it('submits with an x-key header, polls the returned URL and downloads without the key', async () => {
    const fake = fakeFetch(happyRoutes);
    const generator = new BflImageGenerator({
      apiKey: ` ${KEY} `,
      input: { output_format: 'png' },
      fetch: fake.fetch,
      sleep: noSleep,
    });
    assert.deepEqual(await generator.listModes(), {
      ok: true,
      value: [DEFAULT_BFL_IMAGE_MODEL],
    });
    const result = await generator.generateImage(request);
    assert.deepEqual(result, {
      ok: true,
      value: {
        image: { mimeType: 'image/png', data: PNG_OUTPUT },
        notes: null,
      },
    });
    const [submit, poll, download] = fake.calls;
    assert.ok(submit && poll && download);
    assert.equal(
      submit.url.toString(),
      'https://api.bfl.ai/v1/flux-kontext-pro'
    );
    assert.equal(new Headers(submit.init?.headers).get('x-key'), KEY);
    assert.equal(new Headers(poll.init?.headers).get('x-key'), KEY);
    assert.equal(poll.url.toString(), 'https://api.bfl.ai/v1/get_result?id=t1');
    assert.deepEqual(JSON.parse(String(submit.init?.body)), {
      output_format: 'png',
      prompt: 'RULES\n\nPROMPT',
      input_image: 'iVBORw==',
    });
    assert.equal(download.url.toString(), OUTPUT_URL);
    assert.equal(new Headers(download.init?.headers).get('x-key'), null);
  });

  void it('polls while the task is pending', async () => {
    const fake = fakeFetch({
      ...happyRoutes,
      [POLL]: [pending, pending, () => ready()],
    });
    const sleeps: number[] = [];
    const result = await new BflImageGenerator({
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

  void it('sends the configured input names and one field per reference image', async () => {
    const fake = fakeFetch({
      'POST /v1/flux-kontext-max': submitted(),
      [POLL]: () => ready(),
      'GET /results/abc/sample.png': png,
    });
    const result = await new BflImageGenerator({
      apiKey: KEY,
      model: 'flux-kontext-max',
      imageInput: 'source',
      promptInput: 'text',
      referenceImageInputs: ['input_image_2', 'input_image_3'],
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
      source: 'iVBORw==',
      input_image_2: 'CQ==',
    });
  });

  void it('explains moderation, errors and unknown tasks', async () => {
    const run = async (status: string): Promise<string> =>
      errorOf(
        await new BflImageGenerator({
          apiKey: KEY,
          fetch: fakeFetch({
            ...happyRoutes,
            [POLL]: () => json({ status }),
          }).fetch,
        }).generateImage(request)
      );
    assert.match(
      await run('Content Moderated'),
      /declined by Black Forest Labs' moderation \(Content Moderated\)/
    );
    assert.match(
      await run('Request Moderated'),
      /moderation \(Request Moderated\)/
    );
    assert.match(await run('Error'), /failed on Black Forest Labs' side/);
    assert.match(await run('Task not found'), /doesn't know this task/);
    assert.match(await run('Weird'), /unexpected status: Weird/);
  });

  void it('turns HTTP errors on submit into specific messages without the key', async () => {
    const result = await new BflImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        [SUBMIT]: json({ detail: 'Not authenticated' }, 403),
      }).fetch,
    }).generateImage(request);
    const error = errorOf(result);
    assert.match(error, /failed \(HTTP 403\): Not authenticated/);
    assert.doesNotMatch(error, /test-key/);
  });

  void it('stops waiting after runTimeoutMs and says the task may still run', async () => {
    let clock = 0;
    const fake = fakeFetch({ ...happyRoutes, [POLL]: pending });
    const result = await new BflImageGenerator({
      apiKey: KEY,
      runTimeoutMs: 3000,
      fetch: fake.fetch,
      now: () => clock,
      sleep: () => {
        clock += 1500;
        return Promise.resolve();
      },
    }).generateImage(request);
    assert.match(
      errorOf(result),
      /didn't finish within 3 s; .*no cancel call, so it may still be running/
    );
  });

  void it('stops waiting when the caller aborts', async () => {
    const controller = new AbortController();
    const result = await new BflImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({ ...happyRoutes, [POLL]: pending }).fetch,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    }).generateImage({ ...request, signal: controller.signal });
    assert.match(errorOf(result), /was cancelled/);
  });

  void it('accepts a regional polling URL but never sends the key outside bfl.ai', async () => {
    const regional = await new BflImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        [SUBMIT]: () => submitted('https://api.eu.bfl.ai/v1/get_result?id=t1'),
      }).fetch,
    }).generateImage(request);
    assert.equal(regional.ok, true);

    for (const url of [
      'https://evil.example/poll',
      'http://api.bfl.ai/v1/get_result?id=t1',
      'https://bfl.ai.evil.example/poll',
      'not a url',
    ]) {
      const fake = fakeFetch({ [SUBMIT]: () => submitted(url) });
      const result = await new BflImageGenerator({
        apiKey: KEY,
        fetch: fake.fetch,
      }).generateImage(request);
      assert.match(errorOf(result), /polling_url/, url);
      assert.equal(fake.calls.length, 1, url);
    }
    const missing = await new BflImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({ [SUBMIT]: json({ id: 't1' }) }).fetch,
    }).generateImage(request);
    assert.match(errorOf(missing), /didn't return a polling_url/);
  });

  void it('downloads only from bfl.ai hosts, following a redirect only to one', async () => {
    for (const url of [
      'https://evil.example/out.png',
      'http://delivery-eu1.bfl.ai/out.png',
      'https://bfl.ai.evil.example/out.png',
    ]) {
      const fake = fakeFetch({ ...happyRoutes, [POLL]: () => ready(url) });
      const result = await new BflImageGenerator({
        apiKey: KEY,
        fetch: fake.fetch,
      }).generateImage(request);
      assert.match(errorOf(result), /isn't bfl\.ai/, url);
      assert.equal(fake.calls.length, 2, url);
    }
    const good = await new BflImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        'GET /results/abc/sample.png': () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://delivery-us1.bfl.ai/moved/out.png' },
          }),
        'GET /moved/out.png': png,
      }).fetch,
    }).generateImage(request);
    assert.equal(good.ok, true);
    const bad = await new BflImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        'GET /results/abc/sample.png': () =>
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
          }),
      }).fetch,
    }).generateImage(request);
    assert.match(errorOf(bad), /isn't bfl\.ai/);
  });

  void it('accepts extra output hosts you list', async () => {
    const result = await new BflImageGenerator({
      apiKey: KEY,
      outputHosts: ['blob.example.com'],
      fetch: fakeFetch({
        ...happyRoutes,
        [POLL]: () =>
          ready('https://files.blob.example.com/results/abc/sample.png'),
      }).fetch,
    }).generateImage(request);
    assert.equal(result.ok, true);
  });

  void it('rejects output that is not PNG, JPEG or WebP, or is missing', async () => {
    const svg = await new BflImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        'GET /results/abc/sample.png': () =>
          new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
            headers: { 'content-type': 'image/png' },
          }),
      }).fetch,
    }).generateImage(request);
    assert.match(errorOf(svg), /isn't a PNG, JPEG or WebP image/);
    const none = await new BflImageGenerator({
      apiKey: KEY,
      fetch: fakeFetch({
        ...happyRoutes,
        [POLL]: () => json({ status: 'Ready', result: {} }),
      }).fetch,
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
        await new BflImageGenerator({
          apiKey: KEY,
          fetch: fake.fetch,
          ...options,
        }).generateImage({ ...request, ...overrides })
      );
    assert.match(
      await run({}, { apiKey: ' ' }),
      /No Black Forest Labs API key/
    );
    assert.match(await run({ mode: 'other' }), /has no mode "other"/);
    assert.match(await run({}, { model: 'not a model' }), /isn't valid/);
    assert.match(await run({}, { model: '../x' }), /isn't valid/);
    assert.match(await run({ images: [] }), /needs an image to edit/);
    assert.match(
      await run({
        images: [
          { mimeType: 'image/png', data: PNG },
          { mimeType: 'image/png', data: PNG },
        ],
      }),
      /referenceImageInputs names 0 extra inputs/
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
    const generator = new BflImageGenerator({ apiKey: KEY });
    assert.doesNotMatch(JSON.stringify(generator), /test-key/);
    assert.doesNotMatch(JSON.stringify({ ...generator }), /test-key/);
    assert.doesNotMatch(
      inspect(generator, { showHidden: true, depth: 5 }),
      /test-key/
    );
  });
});
