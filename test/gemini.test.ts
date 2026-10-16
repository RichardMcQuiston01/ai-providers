import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';

import {
  DEFAULT_GEMINI_IMAGE_MODEL,
  DEFAULT_GEMINI_TEXT_MODEL,
  GeminiImageGenerator,
  GeminiTextGenerator,
  type GeminiModule,
} from '../src/gemini.js';
import { ok } from '../src/index.js';
import { PNG_OUTPUT, PNG_OUTPUT_BASE64 } from './helpers.js';

const PHOTO = { mimeType: 'image/jpeg', data: new Uint8Array([1, 2, 3]) };
const EDITED_BASE64 = PNG_OUTPUT_BASE64;

type TextCall = Parameters<GeminiModule['generateText']>[0];
type EditCall = Parameters<GeminiModule['editImage']>[0];

function fakeGemini(overrides: Partial<GeminiModule> = {}): {
  load: () => Promise<GeminiModule>;
  textCalls: TextCall[];
  editCalls: EditCall[];
} {
  const textCalls: TextCall[] = [];
  const editCalls: EditCall[] = [];
  const module: GeminiModule = {
    generateText: async (request) => {
      textCalls.push(request);
      return { success: true, text: '  A caption  ' };
    },
    editImage: async (request) => {
      editCalls.push(request);
      return { success: true, imageData: EDITED_BASE64, mimeType: 'image/png' };
    },
    ...overrides,
  };
  return { load: async () => module, textCalls, editCalls };
}

void describe('GeminiTextGenerator', () => {
  void it('passes rules, prompt, model and key, and trims the reply', async () => {
    const fake = fakeGemini();
    const generator = new GeminiTextGenerator({
      apiKey: ' key ',
      loadModule: fake.load,
    });
    const result = await generator.generateText({
      instructions: 'RULES',
      prompt: 'PROMPT',
    });
    assert.deepEqual(result, ok({ text: 'A caption' }));
    assert.equal(generator.model, DEFAULT_GEMINI_TEXT_MODEL);
    assert.deepEqual(fake.textCalls, [
      {
        input: 'PROMPT',
        instructions: 'RULES',
        model: DEFAULT_GEMINI_TEXT_MODEL,
        apiKey: 'key',
      },
    ]);
  });

  void it('uses the model it was given', async () => {
    const fake = fakeGemini();
    const generator = new GeminiTextGenerator({
      apiKey: 'key',
      model: 'gemini-2.5-pro',
      loadModule: fake.load,
    });
    await generator.generateText({ instructions: 'R', prompt: 'P' });
    assert.equal(fake.textCalls[0]?.model, 'gemini-2.5-pro');
  });

  void it('refuses a missing key, images and blank instructions without loading', async () => {
    let loaded = false;
    const load = async (): Promise<GeminiModule> => {
      loaded = true;
      return fakeGemini().load();
    };
    const noKey = await new GeminiTextGenerator({
      apiKey: ' ',
      loadModule: load,
    }).generateText({ instructions: 'R', prompt: 'P' });
    assert.match(noKey.ok ? '' : noKey.error, /No Gemini API key/);

    const generator = new GeminiTextGenerator({
      apiKey: 'k',
      loadModule: load,
    });
    const images = await generator.generateText({
      instructions: 'R',
      prompt: 'P',
      images: [PHOTO],
    });
    assert.match(images.ok ? '' : images.error, /doesn't take images/);
    const blank = await generator.generateText({
      instructions: ' ',
      prompt: 'P',
    });
    assert.match(blank.ok ? '' : blank.error, /needs instructions/);
    assert.equal(loaded, false);
  });

  void it('names the package when it is not installed', async () => {
    const generator = new GeminiTextGenerator({
      apiKey: 'k',
      loadModule: () => Promise.reject(new Error('Cannot find module')),
    });
    const result = await generator.generateText({
      instructions: 'R',
      prompt: 'P',
    });
    assert.equal(result.ok, false);
    assert.match(
      result.ok ? '' : result.error,
      /needs the optional package @richardmcquiston01\/gemini-icon-gen .*Cannot find module/
    );
  });

  void it('passes on Gemini errors and empty replies with the model', async () => {
    const failing = new GeminiTextGenerator({
      apiKey: 'k',
      loadModule: fakeGemini({
        generateText: async () => ({ success: false, error: 'quota exceeded' }),
      }).load,
    });
    assert.deepEqual(
      await failing.generateText({ instructions: 'R', prompt: 'P' }),
      {
        ok: false,
        error: `Gemini (model "${DEFAULT_GEMINI_TEXT_MODEL}"): quota exceeded`,
      }
    );
    const empty = new GeminiTextGenerator({
      apiKey: 'k',
      loadModule: fakeGemini({
        generateText: async () => ({ success: true, text: '  ' }),
      }).load,
    });
    const result = await empty.generateText({ instructions: 'R', prompt: 'P' });
    assert.match(result.ok ? '' : result.error, /empty reply/);
  });

  void it('turns a thrown error into a Result', async () => {
    const generator = new GeminiTextGenerator({
      apiKey: 'k',
      loadModule: fakeGemini({
        generateText: () => Promise.reject(new Error('socket hang up')),
      }).load,
    });
    const result = await generator.generateText({
      instructions: 'R',
      prompt: 'P',
    });
    assert.match(result.ok ? '' : result.error, /failed: socket hang up/);
  });

  void it('stops a call that takes too long, and honours the signal', async () => {
    const slow = fakeGemini({
      generateText: () => new Promise(() => undefined),
    });
    const timed = new GeminiTextGenerator({
      apiKey: 'k',
      timeoutMs: 10,
      loadModule: slow.load,
    });
    const result = await timed.generateText({ instructions: 'R', prompt: 'P' });
    assert.match(result.ok ? '' : result.error, /took longer than/);

    const controller = new AbortController();
    const cancelled = new GeminiTextGenerator({
      apiKey: 'k',
      loadModule: slow.load,
    });
    const pending = cancelled.generateText({
      instructions: 'R',
      prompt: 'P',
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await pending;
    assert.match(outcome.ok ? '' : outcome.error, /was cancelled/);
  });
});

void describe('GeminiImageGenerator', () => {
  void it('has one mode, named after the model', async () => {
    const generator = new GeminiImageGenerator({ apiKey: 'k' });
    assert.deepEqual(
      await generator.listModes(),
      ok([DEFAULT_GEMINI_IMAGE_MODEL])
    );
  });

  void it('sends the image, references, rules and prompt, and decodes the result', async () => {
    const fake = fakeGemini({
      editImage: async (request) => {
        fake.editCalls.push(request);
        return {
          success: true,
          imageData: EDITED_BASE64,
          mimeType: 'image/png',
          text: ' Done. ',
        };
      },
    });
    const generator = new GeminiImageGenerator({
      apiKey: 'k',
      loadModule: fake.load,
    });
    const reference = { mimeType: 'image/webp', data: new Uint8Array([9]) };
    const result = await generator.generateImage({
      instructions: 'Keep the product as it is.',
      prompt: 'Wooden table',
      images: [PHOTO, reference],
      mode: DEFAULT_GEMINI_IMAGE_MODEL,
    });
    assert.deepEqual(
      result,
      ok({
        image: {
          mimeType: 'image/png',
          data: PNG_OUTPUT,
        },
        notes: 'Done.',
      })
    );
    assert.deepEqual(fake.editCalls, [
      {
        image: { data: 'AQID', mimeType: 'image/jpeg' },
        prompt: 'Wooden table',
        instructions: 'Keep the product as it is.',
        referenceImages: [{ data: 'CQ==', mimeType: 'image/webp' }],
        model: DEFAULT_GEMINI_IMAGE_MODEL,
        apiKey: 'k',
      },
    ]);
  });

  void it('leaves out blank instructions and no references; notes null without text', async () => {
    const fake = fakeGemini();
    const generator = new GeminiImageGenerator({
      apiKey: 'k',
      loadModule: fake.load,
    });
    const result = await generator.generateImage({
      instructions: '',
      prompt: 'P',
      images: [PHOTO],
      mode: null,
    });
    assert.equal(result.ok && result.value.notes, null);
    assert.deepEqual(Object.keys(fake.editCalls[0] ?? {}).sort(), [
      'apiKey',
      'image',
      'model',
      'prompt',
    ]);
  });

  void it('checks the request before loading the package', async () => {
    let loaded = false;
    const generator = new GeminiImageGenerator({
      apiKey: 'k',
      loadModule: async () => {
        loaded = true;
        return fakeGemini().load();
      },
    });
    const cases: Array<
      [Parameters<GeminiImageGenerator['generateImage']>[0], RegExp]
    > = [
      [
        { instructions: '', prompt: 'P', images: [], mode: null },
        /needs an image/,
      ],
      [
        { instructions: '', prompt: 'P', images: [PHOTO], mode: 'other' },
        /no mode "other"/,
      ],
      [
        {
          instructions: '',
          prompt: 'P',
          images: [{ mimeType: 'image/gif', data: new Uint8Array([1]) }],
          mode: null,
        },
        /The image to edit is image\/gif/,
      ],
      [
        {
          instructions: '',
          prompt: 'P',
          images: [PHOTO, { mimeType: 'image/png', data: new Uint8Array() }],
          mode: null,
        },
        /Reference image 1 is empty/,
      ],
    ];
    for (const [request, expected] of cases) {
      const result = await generator.generateImage(request);
      assert.match(result.ok ? '' : result.error, expected);
    }
    assert.equal(loaded, false);
  });

  void it('reports a reply without an image or with bad base64', async () => {
    const noImage = new GeminiImageGenerator({
      apiKey: 'k',
      loadModule: fakeGemini({
        editImage: async () => ({
          success: false,
          error: 'returned no edited image (finish reason: IMAGE_SAFETY)',
        }),
      }).load,
    });
    const first = await noImage.generateImage({
      instructions: '',
      prompt: 'P',
      images: [PHOTO],
      mode: null,
    });
    assert.match(first.ok ? '' : first.error, /IMAGE_SAFETY/);

    const badData = new GeminiImageGenerator({
      apiKey: 'k',
      loadModule: fakeGemini({
        editImage: async () => ({
          success: true,
          imageData: '%%%',
          mimeType: 'image/png',
        }),
      }).load,
    });
    const second = await badData.generateImage({
      instructions: '',
      prompt: 'P',
      images: [PHOTO],
      mode: null,
    });
    assert.match(second.ok ? '' : second.error, /isn't valid base64/);
  });
});

void describe('Gemini API key', () => {
  void it('stays out of JSON, keys, spreads and inspect output', () => {
    const secret = 'AIza-secret-test-key';
    for (const generator of [
      new GeminiTextGenerator({ apiKey: secret }),
      new GeminiImageGenerator({ apiKey: secret }),
    ]) {
      assert.doesNotMatch(JSON.stringify(generator), /secret-test-key/);
      assert.doesNotMatch(
        inspect(generator, { showHidden: true, depth: 5 }),
        /secret-test-key/
      );
      assert.doesNotMatch(JSON.stringify({ ...generator }), /secret-test-key/);
      assert.ok(
        !Object.getOwnPropertyNames(generator).some((name) => /key/i.test(name))
      );
    }
  });
});

void describe('GeminiImageGenerator output types', () => {
  const run = async (
    reply: Awaited<ReturnType<GeminiModule['editImage']>>
  ): Promise<{ ok: boolean; mimeType?: string; error?: string }> => {
    const fake = fakeGemini({ editImage: async () => reply });
    const result = await new GeminiImageGenerator({
      apiKey: 'k',
      loadModule: fake.load,
    }).generateImage({
      instructions: '',
      prompt: 'p',
      images: [PHOTO],
      mode: null,
    });
    return result.ok
      ? { ok: true, mimeType: result.value.image.mimeType }
      : { ok: false, error: result.error };
  };

  void it('takes the type from the bytes, whatever the package says', async () => {
    assert.deepEqual(
      await run({
        success: true,
        imageData: PNG_OUTPUT_BASE64,
        mimeType: 'image/svg+xml',
      }),
      { ok: true, mimeType: 'image/png' }
    );
    assert.deepEqual(
      await run({ success: true, imageData: PNG_OUTPUT_BASE64 }),
      {
        ok: true,
        mimeType: 'image/png',
      }
    );
  });

  void it('refuses bytes that are not PNG, JPEG or WebP', async () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const result = await run({
      success: true,
      imageData: svg,
      mimeType: 'image/png',
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /isn't a PNG, JPEG or WebP image/);
  });
});
