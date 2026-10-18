import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  callProvider,
  downloadImage,
  err,
  isAborted,
  loadOptionalPackage,
  pollClock,
  pollPause,
  ok,
  readBytes,
  readHistory,
  readJson,
  type FetchLike,
} from '../src/index.js';
import { fakeFetch, PNG_OUTPUT } from './helpers.js';

const errorOf = (result: { ok: boolean; error?: string }): string =>
  result.ok ? '' : (result.error ?? '');

const redirect = (location: string | null, status = 307): Response =>
  new Response(null, {
    status,
    headers: location === null ? {} : { location },
  });

/** A body that yields `chunks` and then fails, like a dropped connection. */
function brokenBody(chunks: Uint8Array[]): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined)
          controller.error(new Error('connection reset'));
        else controller.enqueue(chunk);
      },
    })
  );
}

void describe('callProvider redirects', () => {
  void it('asks fetch not to follow redirects', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = init;
      return new Response('fine');
    };
    const result = await callProvider(
      fetchImpl,
      'http://127.0.0.1/a',
      { method: 'POST' },
      'W',
      1000
    );
    assert.equal(result.ok, true);
    assert.equal(seen?.redirect, 'manual');
    assert.equal(seen?.method, 'POST');
  });

  void it('refuses a redirect and names where it pointed, without following it', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return redirect('https://evil.example/collect?token=1');
    };
    const result = await callProvider(
      fetchImpl,
      'http://127.0.0.1:8188/prompt',
      {},
      'ComfyUI',
      1000
    );
    assert.match(
      errorOf(result),
      /ComfyUI answered with a redirect \(HTTP 307\) to https:\/\/evil\.example; redirects aren't followed/
    );
    assert.doesNotMatch(errorOf(result), /token/);
    assert.deepEqual(calls, ['http://127.0.0.1:8188/prompt']);
  });

  void it('also refuses a redirect with no usable Location', async () => {
    const result = await callProvider(
      async () => redirect(null, 302),
      'http://127.0.0.1/a',
      {},
      'W',
      1000
    );
    assert.match(
      errorOf(result),
      /redirect \(HTTP 302\); redirects aren't followed/
    );
  });

  void it('follows a redirect only when the caller approves each hop', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return url === 'https://a.example/x'
        ? redirect('/y')
        : new Response('final');
    };
    const approved: string[] = [];
    const result = await callProvider(
      fetchImpl,
      'https://a.example/x',
      {},
      'W',
      1000,
      undefined,
      {
        followRedirect: (target) => {
          approved.push(target);
          return ok(target);
        },
      }
    );
    assert.equal(result.ok && (await result.value.text()), 'final');
    assert.deepEqual(approved, ['https://a.example/y']);
    assert.deepEqual(calls, ['https://a.example/x', 'https://a.example/y']);

    const refused = await callProvider(
      fetchImpl,
      'https://a.example/x',
      {},
      'W',
      1000,
      undefined,
      {
        followRedirect: () => err('not allowed'),
      }
    );
    assert.equal(errorOf(refused), 'not allowed');
  });

  void it('stops after a few redirects', async () => {
    const result = await callProvider(
      async () => redirect('/again'),
      'https://a.example/x',
      {},
      'W',
      1000,
      undefined,
      {
        followRedirect: (target) => ok(target),
      }
    );
    assert.match(errorOf(result), /redirected more than 3 times/);
  });
});

void describe('callProvider does not throw', () => {
  void it('returns an error for an unusable timeoutMs', async () => {
    for (const timeoutMs of [
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 40,
    ]) {
      const result = await callProvider(
        async () => new Response('x'),
        'http://127.0.0.1/a',
        {},
        'W',
        timeoutMs
      );
      assert.match(
        errorOf(result),
        /^W: timeoutMs must be a number of milliseconds/
      );
    }
  });

  void it('keeps the fetch error when the URL is not absolute', async () => {
    const result = await callProvider(
      async () => {
        throw new Error('boom');
      },
      'not a url',
      {},
      'W',
      1000
    );
    assert.match(
      errorOf(result),
      /Could not reach W at the configured address: boom/
    );
  });

  void it('reads an error body only up to a cap', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(32 * 1024).fill(97));
      },
    });
    const result = await callProvider(
      async () => new Response(body, { status: 500 }),
      'http://127.0.0.1/a',
      {},
      'W',
      1000
    );
    assert.match(errorOf(result), /failed \(HTTP 500\): a{300}…$/);
    assert.ok(pulled < 10, `read ${pulled} chunks of an endless body`);
  });
});

void describe('readBytes and readJson', () => {
  void it('returns the body when it fits and an error when it does not', async () => {
    const fits = await readBytes(
      new Response(new Uint8Array([1, 2, 3])),
      'W',
      10
    );
    assert.deepEqual(fits, ok(new Uint8Array([1, 2, 3])));
    const over = await readBytes(new Response(new Uint8Array(11)), 'W', 10);
    assert.match(
      errorOf(over),
      /^W: the reply is .* MB or more; the limit is 0 MB/
    );
  });

  void it('stops reading an endless body at the cap', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const result = await readBytes(new Response(body), 'W', 4096);
    assert.equal(result.ok, false);
    assert.ok(pulled < 20);
  });

  void it('refuses early when Content-Length is over the cap', async () => {
    const response = new Response('x', {
      headers: { 'content-length': '999999' },
    });
    assert.match(errorOf(await readBytes(response, 'W', 100)), /limit is/);
  });

  void it('turns a failed read into an error', async () => {
    const result = await readBytes(brokenBody([new Uint8Array([1])]), 'W', 100);
    assert.match(
      errorOf(result),
      /^W: reading the reply failed: connection reset/
    );
    const json = await readJson(brokenBody([]), 'W');
    assert.match(errorOf(json), /reading the reply failed/);
  });

  void it('still parses JSON and reports non-JSON', async () => {
    assert.deepEqual(
      await readJson(Response.json({ a: 1 }), 'W'),
      ok({ a: 1 })
    );
    assert.match(
      errorOf(await readJson(new Response('<html>'), 'W')),
      /isn't JSON/
    );
  });
});

void describe('readHistory with unexpected shapes', () => {
  void it('skips non-object images and outputs', () => {
    assert.deepEqual(
      readHistory(
        { p: { outputs: { a: { images: [null, 3, 'x'] }, b: null } } },
        'p'
      ),
      ok(null)
    );
    assert.deepEqual(
      readHistory(
        { p: { outputs: { a: { images: [null, { filename: 'a.png' }] } } } },
        'p'
      ),
      ok({ filename: 'a.png', subfolder: '', type: 'output' })
    );
  });

  void it('reports an execution error whatever its payload', () => {
    for (const messages of [
      [['execution_error', null]],
      [['execution_error']],
      [null, 'x', ['execution_error', 'text']],
    ]) {
      const result = readHistory(
        { p: { status: { status_str: 'error', messages } } },
        'p'
      );
      assert.match(errorOf(result), /^ComfyUI couldn't run the workflow/);
    }
    assert.match(
      errorOf(
        readHistory(
          {
            p: {
              status: {
                status_str: 'error',
                messages: [
                  [
                    'execution_error',
                    {
                      node_type: 'KSampler',
                      exception_message: 'out of memory',
                    },
                  ],
                ],
              },
            },
          },
          'p'
        )
      ),
      /KSampler: out of memory/
    );
  });

  void it('reports a history entry that is not an object', () => {
    assert.match(errorOf(readHistory({ p: null }, 'p')), /not an object/);
    assert.match(errorOf(readHistory({ p: 'x' }, 'p')), /not an object/);
  });
});

void describe('isAborted and loadOptionalPackage', () => {
  void it('isAborted is true only once the signal has fired', () => {
    const controller = new AbortController();
    assert.equal(isAborted(undefined), false);
    assert.equal(isAborted(controller.signal), false);
    controller.abort();
    assert.equal(isAborted(controller.signal), true);
  });

  void it('loadOptionalPackage names the package and how to install it', async () => {
    const result = await loadOptionalPackage(
      () => Promise.reject(new Error('Cannot find module')),
      'Demo',
      'demo-sdk',
      ' (1.0 or later)'
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(
        result.error,
        /^The Demo provider needs the optional package demo-sdk \(1\.0 or later\)/
      );
      assert.match(result.error, /bun add demo-sdk/);
      assert.match(result.error, /Cannot find module/);
    }
  });
});

void describe('downloadImage', () => {
  const OPTIONS = { maxBytes: 1024, timeoutMs: 1000 };

  void it('downloads a PNG without credentials', async () => {
    const { fetch, calls } = fakeFetch({
      'GET /out.png': new Response(PNG_OUTPUT),
    });
    const result = await downloadImage(
      fetch,
      'https://files.example/out.png',
      'Downloading x',
      OPTIONS
    );
    assert.equal(result.ok && result.value.mimeType, 'image/png');
    assert.equal(
      new Headers(calls[0]?.init?.headers).has('authorization'),
      false
    );
  });

  void it('refuses empty data, non-images and oversize replies by name', async () => {
    const cases: Array<[Response, RegExp]> = [
      [new Response(new Uint8Array()), /Downloading x: the image is empty/],
      [new Response('plain text'), /isn't a PNG, JPEG or WebP/],
      [new Response(new Uint8Array(2048)), /the limit is/],
      [new Response('gone', { status: 404 }), /HTTP 404/],
    ];
    for (const [response, expected] of cases) {
      const { fetch } = fakeFetch({ 'GET /out.png': response });
      const result = await downloadImage(
        fetch,
        'https://files.example/out.png',
        'Downloading x',
        OPTIONS
      );
      assert.equal(result.ok, false);
      assert.match((result as { error: string }).error, expected);
    }
  });

  void it('follows a redirect only where followRedirect allows', async () => {
    const redirect = (): Response =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example/out.png' },
      });
    const { fetch } = fakeFetch({
      'GET /out.png': [redirect, () => new Response(PNG_OUTPUT)],
    });
    const refused = await downloadImage(
      fetch,
      'https://files.example/out.png',
      'D',
      OPTIONS
    );
    assert.equal(!refused.ok && /redirect/.test(refused.error), true);
    const seen: string[] = [];
    const { fetch: fetch2 } = fakeFetch({
      'GET /out.png': [redirect, () => new Response(PNG_OUTPUT)],
    });
    const followed = await downloadImage(
      fetch2,
      'https://files.example/out.png',
      'D',
      {
        ...OPTIONS,
        followRedirect: (target) => {
          seen.push(target);
          return ok(target);
        },
      }
    );
    assert.equal(followed.ok, true);
    assert.deepEqual(seen, ['https://cdn.example/out.png']);
  });
});

void describe('pollPause', () => {
  void it('sleeps, then says continue, cancelled or timed out', async () => {
    const slept: number[] = [];
    let time = 0;
    const clock = pollClock({
      sleep: (ms) => {
        slept.push(ms);
        time += ms;
        return Promise.resolve();
      },
      now: () => time,
    });
    assert.equal(await pollPause(clock, 1000, 5000, undefined), 'continue');
    assert.equal(await pollPause(clock, 1000, 2000, undefined), 'timed out');
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await pollPause(clock, 1000, 99999, controller.signal),
      'cancelled'
    );
    assert.deepEqual(slept, [1000, 1000, 1000]);
  });

  void it('pollClock defaults to a real sleep and the system clock', async () => {
    const clock = pollClock({});
    const before = clock.now();
    await clock.sleep(5);
    assert.equal(clock.now() >= before, true);
  });
});

void describe('readJson maxBytes', () => {
  void it('allows a bigger reply than the default when asked', async () => {
    const big = JSON.stringify({ image: 'a'.repeat(9 * 1024 * 1024) });
    const small = await readJson(new Response(big), 'x');
    assert.equal(!small.ok && /the limit is 8 MB/.test(small.error), true);
    const raised = await readJson(new Response(big), 'x', 16 * 1024 * 1024);
    assert.equal(raised.ok, true);
  });
});
