import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkImageInput,
  checkImageOutput,
  IMAGE_TYPES,
  sniffImageType,
} from '../src/index.js';

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0];
const WEBP = [...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP'), 0, 0];

void describe('sniffImageType', () => {
  void it('recognises PNG, JPEG and WebP from their bytes', () => {
    assert.equal(sniffImageType(new Uint8Array(PNG)), 'image/png');
    assert.equal(sniffImageType(new Uint8Array(JPEG)), 'image/jpeg');
    assert.equal(sniffImageType(new Uint8Array(WEBP)), 'image/webp');
  });

  void it('requires the whole signature, not just its first bytes', () => {
    // Four PNG bytes, the old Grok-style prefix check.
    assert.equal(sniffImageType(new Uint8Array(PNG.slice(0, 4))), null);
    // "RI" at 0-1 and "WE" at 8-9, but not RIFF…WEBP.
    const partial = [...ascii('RIXX'), 0, 0, 0, 0, ...ascii('WEXX')];
    assert.equal(sniffImageType(new Uint8Array(partial)), null);
    assert.equal(
      sniffImageType(
        new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')])
      ),
      null
    );
    assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8])), null);
  });

  void it('rejects SVG, HTML, GIF, empty and short data', () => {
    for (const text of [
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      '<html>',
      'GIF89a',
    ]) {
      assert.equal(sniffImageType(new Uint8Array(ascii(text))), null, text);
    }
    assert.equal(sniffImageType(new Uint8Array()), null);
    assert.equal(sniffImageType(new Uint8Array([0x89])), null);
  });
});

void describe('checkImageOutput', () => {
  void it('takes the type from the bytes and names the provider on failure', () => {
    const png = new Uint8Array(PNG);
    assert.deepEqual(checkImageOutput(png, 'X'), {
      ok: true,
      value: { mimeType: 'image/png', data: png },
    });
    const result = checkImageOutput(
      new Uint8Array(ascii('<svg/>')),
      'Gemini (model "m")'
    );
    assert.deepEqual(result, {
      ok: false,
      error: `Gemini (model "m") returned data that isn't a PNG, JPEG or WebP image`,
    });
  });

  void it('allows exactly PNG, JPEG and WebP', () => {
    assert.deepEqual([...IMAGE_TYPES].sort(), [
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });
});

void describe('checkImageInput', () => {
  const png = { mimeType: 'image/png', data: new Uint8Array(PNG) };

  void it('passes a non-empty PNG, JPEG or WebP', () => {
    assert.equal(checkImageInput(png, 'Image 1', 'Test').ok, true);
  });

  void it('names the label, type and provider for a type it does not take', () => {
    const result = checkImageInput(
      { mimeType: 'image/gif', data: new Uint8Array(PNG) },
      'Image 2',
      'Test'
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error,
        'Image 2 is image/gif; Test takes PNG, JPEG or WebP.'
      );
    }
  });

  void it('accepts the extra types a provider passes in', () => {
    const allowed = new Set([...IMAGE_TYPES, 'image/gif']);
    const gif = { mimeType: 'image/gif', data: new Uint8Array(PNG) };
    assert.equal(checkImageInput(gif, 'Image 1', 'Test', allowed).ok, true);
  });

  void it('refuses an empty image', () => {
    const result = checkImageInput(
      { mimeType: 'image/png', data: new Uint8Array() },
      'Image 1',
      'Test'
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'Image 1 is empty.');
  });
});
