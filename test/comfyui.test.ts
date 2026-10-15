import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ComfyUiImageGenerator,
  fillWorkflow,
  type ImageRequest,
  memoryWorkflowSource,
  ok,
  parseWorkflow,
  readHistory,
} from '../src/index.js';
import { fakeFetch, json } from './helpers.js';

const PHOTO = {
  mimeType: 'image/png',
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

const WORKFLOW = {
  '1': { class_type: 'LoadImage', inputs: { image: '{{INPUT_IMAGE}}' } },
  '2': {
    class_type: 'CLIPTextEncode',
    inputs: { text: 'studio photo, {{PROMPT}}, soft light' },
  },
  '3': {
    class_type: 'KSampler',
    inputs: { seed: '{{SEED}}', model: ['4', 0] },
  },
  '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
};

void describe('ComfyUI workflows', () => {
  void it('parses API-format workflows and explains UI saves and a missing input token', () => {
    assert.ok(parseWorkflow(JSON.stringify(WORKFLOW), 'touch-up').ok);
    assert.match(
      (
        parseWorkflow(JSON.stringify({ nodes: [], links: [] }), 'ui') as {
          error: string;
        }
      ).error,
      /UI save.*Export \(API\)/
    );
    assert.match(
      (
        parseWorkflow(
          JSON.stringify({
            '1': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
          }),
          'fixed'
        ) as { error: string }
      ).error,
      /has no \{\{INPUT_IMAGE\}\}/
    );
    assert.match(
      (parseWorkflow('{', 'bad') as { error: string }).error,
      /isn't valid JSON/
    );
  });

  void it('fills tokens in values, the seed as a number, the prompt inside text', () => {
    const parsed = parseWorkflow(JSON.stringify(WORKFLOW), 'touch-up');
    assert.ok(parsed.ok);
    const filled = fillWorkflow(parsed.value, {
      inputImage: 'photo.png',
      prompt: 'a "quoted" prompt',
      seed: 42,
    });
    assert.equal(filled['1']?.inputs['image'], 'photo.png');
    assert.equal(
      filled['2']?.inputs['text'],
      'studio photo, a "quoted" prompt, soft light'
    );
    assert.equal(filled['3']?.inputs['seed'], 42);
    assert.deepEqual(filled['3']?.inputs['model'], ['4', 0]);
  });

  void it('reads history: pending, failed, done', () => {
    assert.deepEqual(readHistory({}, 'p1'), ok(null));
    assert.match(
      (
        readHistory(
          {
            p1: {
              status: {
                status_str: 'error',
                messages: [
                  [
                    'execution_error',
                    {
                      node_type: 'KSampler',
                      exception_message: 'CUDA out of memory',
                    },
                  ],
                ],
              },
            },
          },
          'p1'
        ) as { error: string }
      ).error,
      /KSampler: CUDA out of memory/
    );
    assert.deepEqual(
      readHistory(
        {
          p1: {
            status: { status_str: 'success', completed: true },
            outputs: {
              '7': {
                images: [
                  { filename: 'preview.png', subfolder: '', type: 'temp' },
                ],
              },
              '9': {
                images: [
                  {
                    filename: 'out_0001.png',
                    subfolder: 'shop',
                    type: 'output',
                  },
                ],
              },
            },
          },
        },
        'p1'
      ),
      ok({ filename: 'out_0001.png', subfolder: 'shop', type: 'output' })
    );
    assert.match(
      (
        readHistory(
          { p1: { status: { completed: true }, outputs: {} } },
          'p1'
        ) as { error: string }
      ).error,
      /no image; add a SaveImage node/
    );
  });
});

void describe('ComfyUiImageGenerator host check', () => {
  void it('refuses a remote or malformed host before reading workflows or sending anything', async () => {
    for (const host of [
      'https://example.com',
      'nope',
      'http://u:p@127.0.0.1:8188',
    ]) {
      const fake = fakeFetch({});
      const result = await new ComfyUiImageGenerator({
        workflows: memoryWorkflowSource({ a: JSON.stringify(WORKFLOW) }),
        host,
        fetch: fake.fetch,
      }).generateImage({
        instructions: '',
        prompt: 'p',
        images: [{ mimeType: 'image/png', data: new Uint8Array([1]) }],
        mode: null,
      });
      assert.equal(result.ok, false, host);
      assert.match((result as { error: string }).error, /^The ComfyUI host /);
      assert.equal(fake.calls.length, 0, host);
    }
  });

  void it('accepts a host on the allow list', async () => {
    const fake = fakeFetch({ 'POST /upload/image': json({}, 500) });
    await new ComfyUiImageGenerator({
      workflows: memoryWorkflowSource({ a: JSON.stringify(WORKFLOW) }),
      host: 'http://gpu.lan:8188',
      allowedHosts: ['gpu.lan'],
      fetch: fake.fetch,
    }).generateImage({
      instructions: '',
      prompt: 'p',
      images: [{ mimeType: 'image/png', data: new Uint8Array([1]) }],
      mode: null,
    });
    assert.equal(fake.calls[0]?.url.origin, 'http://gpu.lan:8188');
  });
});

void describe('ComfyUiImageGenerator', () => {
  void it('uploads, queues the filled workflow, waits, and downloads the output', async () => {
    const fake = fakeFetch({
      'POST /upload/image': json({
        name: 'etsy.png',
        subfolder: '',
        type: 'input',
      }),
      'POST /prompt': json({ prompt_id: 'p1', number: 1, node_errors: {} }),
      'GET /history/p1': [
        () => json({}),
        () =>
          json({
            p1: {
              status: { status_str: 'success', completed: true },
              outputs: {
                '9': {
                  images: [
                    { filename: 'out.png', subfolder: '', type: 'output' },
                  ],
                },
              },
            },
          }),
      ],
      'GET /view': () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' },
        }),
    });
    const slept: number[] = [];
    const generator = new ComfyUiImageGenerator({
      workflows: memoryWorkflowSource({ 'touch-up': JSON.stringify(WORKFLOW) }),
      label: 'test workflows',
      uploadPrefix: 'shop',
      fetch: fake.fetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
      randomSeed: () => 7,
    });
    assert.deepEqual(await generator.listModes(), ok(['touch-up']));
    const result = await generator.generateImage({
      instructions: 'RULES',
      prompt: 'brighter',
      images: [PHOTO],
      mode: null,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual([...result.value.image.data], [1, 2, 3]);
    assert.equal(result.value.image.mimeType, 'image/png');
    assert.match(result.value.notes ?? '', /touch-up/);
    assert.deepEqual(slept, [1000]);

    const queued = JSON.parse(String(fake.calls[1]?.init?.body)) as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(queued.prompt['1']?.inputs['image'], 'etsy.png');
    assert.equal(
      queued.prompt['2']?.inputs['text'],
      'studio photo, RULES\n\nbrighter, soft light'
    );
    assert.equal(queued.prompt['3']?.inputs['seed'], 7);
    const form = fake.calls[0]?.init?.body as FormData;
    assert.match((form.get('image') as File).name, /^shop-[0-9a-f-]{36}\.png$/);
    assert.equal(generator.model, 'test workflows');
    const view = fake.calls.at(-1)?.url;
    assert.equal(view?.searchParams.get('filename'), 'out.png');
    assert.equal(view?.searchParams.get('type'), 'output');
  });

  void it('names an unknown mode and a rejected workflow', async () => {
    const generator = new ComfyUiImageGenerator({
      workflows: memoryWorkflowSource({ 'touch-up': JSON.stringify(WORKFLOW) }),
      fetch: fakeFetch({
        'POST /upload/image': json({ name: 'etsy.png' }),
        'POST /prompt': json(
          { error: { message: 'Prompt outputs failed validation' } },
          400
        ),
      }).fetch,
    });
    const unknown = await generator.generateImage({
      instructions: '',
      prompt: '',
      images: [PHOTO],
      mode: 'scene',
    });
    assert.match(
      (unknown as { error: string }).error,
      /No ComfyUI workflow named "scene"; there are: touch-up/
    );
    const rejected = await generator.generateImage({
      instructions: '',
      prompt: '',
      images: [PHOTO],
      mode: 'touch-up',
    });
    assert.match(
      (rejected as { error: string }).error,
      /Queuing ComfyUI workflow "touch-up" failed \(HTTP 400\): Prompt outputs failed validation/
    );
  });

  void it('stops a workflow that runs past the limit', async () => {
    let clock = 0;
    const generator = new ComfyUiImageGenerator({
      workflows: memoryWorkflowSource({ a: JSON.stringify(WORKFLOW) }),
      runTimeoutMs: 3_000,
      fetch: fakeFetch({
        'POST /upload/image': json({ name: 'in.png' }),
        'POST /prompt': json({ prompt_id: 'p1' }),
        'GET /history/p1': json({}),
      }).fetch,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    const result = await generator.generateImage({
      instructions: '',
      prompt: '',
      images: [PHOTO],
      mode: null,
    });
    assert.match(
      (result as { error: string }).error,
      /didn't finish within 3 s/
    );
  });

  void it('needs an image and at least one workflow', async () => {
    const none = new ComfyUiImageGenerator({
      workflows: memoryWorkflowSource({}),
    });
    assert.match(
      (
        (await none.generateImage({
          instructions: '',
          prompt: '',
          images: [],
          mode: null,
        })) as { error: string }
      ).error,
      /No image was given/
    );
    assert.match(
      (
        (await none.generateImage({
          instructions: '',
          prompt: '',
          images: [PHOTO],
          mode: null,
        })) as { error: string }
      ).error,
      /No ComfyUI workflows found/
    );
  });
});

void describe('ComfyUiImageGenerator instructions and cancellation', () => {
  const request = (overrides: Partial<ImageRequest> = {}): ImageRequest => ({
    instructions: '',
    prompt: 'brighter',
    images: [PHOTO],
    mode: null,
    ...overrides,
  });
  const generatorWith = (
    routes: Parameters<typeof fakeFetch>[0],
    extra: Partial<ConstructorParameters<typeof ComfyUiImageGenerator>[0]> = {}
  ) => {
    const fake = fakeFetch({
      'POST /upload/image': json({ name: 'in.png' }),
      'POST /prompt': json({ prompt_id: 'p1' }),
      ...routes,
    });
    return {
      fake,
      generator: new ComfyUiImageGenerator({
        workflows: memoryWorkflowSource({ a: JSON.stringify(WORKFLOW) }),
        fetch: fake.fetch,
        sleep: async () => undefined,
        ...extra,
      }),
    };
  };
  const posted = (fake: ReturnType<typeof fakeFetch>): string[] =>
    fake.calls
      .filter((call) => call.init?.method === 'POST')
      .map((call) => call.url.pathname);

  void it('puts only the prompt in the workflow when there are no instructions', async () => {
    const { fake, generator } = generatorWith({
      'GET /history/p1': json({
        p1: {
          status: { completed: true },
          outputs: { '4': { images: [{ filename: 'o.png' }] } },
        },
      }),
      'GET /view': new Response(new Uint8Array([1])),
    });
    const result = await generator.generateImage(
      request({ instructions: '  ' })
    );
    assert.equal(result.ok, true);
    const queued = JSON.parse(String(fake.calls[1]?.init?.body)) as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    assert.equal(
      queued.prompt['2']?.inputs['text'],
      'studio photo, brighter, soft light'
    );
  });

  void it('removes a queued prompt from the queue when the caller aborts', async () => {
    const controller = new AbortController();
    const { fake, generator } = generatorWith(
      {
        'GET /history/p1': json({}),
        'GET /queue': json({
          queue_running: [],
          queue_pending: [[1, 'p1', {}]],
        }),
        'POST /queue': json({}),
      },
      {
        sleep: async () => {
          controller.abort();
        },
      }
    );
    const result = await generator.generateImage(
      request({ signal: controller.signal })
    );
    assert.match((result as { error: string }).error, /was cancelled/);
    assert.deepEqual(posted(fake).slice(-1), ['/queue']);
    const del = fake.calls.at(-1)?.init?.body;
    assert.deepEqual(JSON.parse(String(del)), { delete: ['p1'] });
    assert.ok(!posted(fake).includes('/interrupt'));
  });

  void it('interrupts a running prompt on timeout', async () => {
    let clock = 0;
    const { fake, generator } = generatorWith(
      {
        'GET /history/p1': json({}),
        'GET /queue': json({
          queue_running: [[0, 'p1', {}]],
          queue_pending: [],
        }),
        'POST /interrupt': json({}),
      },
      {
        runTimeoutMs: 3000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }
    );
    const result = await generator.generateImage(request());
    assert.match(
      (result as { error: string }).error,
      /didn't finish within 3 s, so ComfyUI was asked to stop it/
    );
    assert.deepEqual(posted(fake).slice(-1), ['/interrupt']);
  });

  void it("leaves someone else's job alone and survives a failing cancel", async () => {
    const controller = new AbortController();
    const other = generatorWith(
      {
        'GET /history/p1': json({}),
        'GET /queue': json({
          queue_running: [[0, 'other', {}]],
          queue_pending: [],
        }),
      },
      { sleep: async () => controller.abort() }
    );
    const first = await other.generator.generateImage(
      request({ signal: controller.signal })
    );
    assert.match((first as { error: string }).error, /was cancelled/);
    assert.deepEqual(posted(other.fake), ['/upload/image', '/prompt']);

    const again = new AbortController();
    const broken = generatorWith(
      { 'GET /history/p1': json({}), 'GET /queue': json({}, 500) },
      { sleep: async () => again.abort() }
    );
    const second = await broken.generator.generateImage(
      request({ signal: again.signal })
    );
    assert.match((second as { error: string }).error, /was cancelled/);
  });

  void it('stops waiting between polls as soon as the caller aborts', async () => {
    const controller = new AbortController();
    const { generator } = generatorWith(
      { 'GET /history/p1': json({}), 'GET /queue': json({}) },
      { sleep: () => new Promise<void>(() => undefined) }
    );
    const running = generator.generateImage(
      request({ signal: controller.signal })
    );
    setTimeout(() => controller.abort(), 10);
    const result = await running;
    assert.match((result as { error: string }).error, /was cancelled/);
  });
});
