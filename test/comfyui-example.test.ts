import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { fillWorkflow, parseWorkflow } from '../src/comfyui.js';

const EXAMPLE = new URL('../examples/comfyui/image-edit.json', import.meta.url);

void describe('examples/comfyui/image-edit.json', () => {
  void it('is an API-format workflow the generator accepts', async () => {
    const text: string = await readFile(EXAMPLE, 'utf8');
    const parsed = parseWorkflow(text, 'image-edit');
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;

    // Every link ([nodeId, outputIndex]) points at a node that exists.
    const ids = new Set(Object.keys(parsed.value));
    for (const node of Object.values(parsed.value)) {
      for (const input of Object.values(node.inputs)) {
        if (
          Array.isArray(input) &&
          input.length === 2 &&
          typeof input[0] === 'string'
        ) {
          assert.ok(ids.has(input[0]), `link to missing node ${input[0]}`);
        }
      }
    }
    assert.ok(
      Object.values(parsed.value).some(
        (node) => node.class_type === 'SaveImage'
      )
    );

    const filled = fillWorkflow(parsed.value, {
      inputImage: 'uploaded.png',
      prompt: 'Make the sky orange.',
      seed: 42,
    });
    const json: string = JSON.stringify(filled);
    assert.doesNotMatch(json, /\{\{[A-Z_]+\}\}/);
    assert.equal(filled['2']?.inputs['image'], 'uploaded.png');
    assert.equal(filled['4']?.inputs['text'], 'Make the sky orange.');
    assert.equal(filled['6']?.inputs['seed'], 42);
  });
});
