import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkProviderHost,
  isLoopbackHost,
  ok,
  parseAllowedHosts,
  providerMessage,
  toBase64,
} from '../src/index.js';

void describe('checkProviderHost', () => {
  void it('accepts loopback hosts, refuses others unless allowed', () => {
    assert.deepEqual(
      checkProviderHost('OLLAMA_HOST', 'http://localhost:11434/'),
      ok('http://localhost:11434')
    );
    assert.match(
      (
        checkProviderHost('COMFYUI_HOST', 'http://gpu.lan:8188', {
          allowedHostsLabel: 'AI_ALLOWED_HOSTS',
        }) as { error: string }
      ).error,
      /isn't this machine.*AI_ALLOWED_HOSTS/
    );
    assert.deepEqual(
      checkProviderHost('COMFYUI_HOST', 'http://gpu.lan:8188', {
        allowedHosts: ['gpu.lan'],
      }),
      ok('http://gpu.lan:8188')
    );
    assert.match(
      (checkProviderHost('X', 'nope') as { error: string }).error,
      /not a URL/
    );
    assert.match(
      (checkProviderHost('X', 'ftp://127.0.0.1') as { error: string }).error,
      /http or https/
    );
    assert.match(
      (checkProviderHost('X', 'http://127.0.0.1:1/api') as { error: string })
        .error,
      /just the address/
    );
  });

  void it('refuses a URL with a username or password and never repeats it', () => {
    for (const value of [
      'http://user:secret@127.0.0.1:8188',
      'http://user:secret@127.0.0.1/api',
      'http://user:secret@gpu.lan:8188',
      'ftp://user:secret@127.0.0.1',
      'user:secret@127.0.0.1',
    ]) {
      const result = checkProviderHost('X', value, {
        allowedHosts: ['gpu.lan'],
      });
      assert.equal(result.ok, false, value);
      assert.doesNotMatch((result as { error: string }).error, /secret/, value);
    }
    assert.match(
      (checkProviderHost('X', 'http://u:p@127.0.0.1:8188') as { error: string })
        .error,
      /must not contain a username or password; use http:\/\/127\.0\.0\.1:8188/
    );
  });

  void it('matches IPv6 allow-list entries and trailing-dot or mapped loopback names', () => {
    assert.deepEqual(
      checkProviderHost('X', 'http://[fe80::1]:8188/', {
        allowedHosts: parseAllowedHosts('fe80::1'),
      }),
      ok('http://[fe80::1]:8188')
    );
    assert.deepEqual(
      checkProviderHost('X', 'http://[FE80::1]:8188/', {
        allowedHosts: ['[fe80::1]'],
      }),
      ok('http://[fe80::1]:8188')
    );
    assert.deepEqual(
      checkProviderHost('X', 'http://gpu.lan.:8188/', {
        allowedHosts: parseAllowedHosts('GPU.lan.'),
      }),
      ok('http://gpu.lan.:8188')
    );
    assert.deepEqual(
      checkProviderHost('X', 'http://localhost./'),
      ok('http://localhost.')
    );
    assert.deepEqual(
      checkProviderHost('X', 'http://[::ffff:127.0.0.1]/'),
      ok('http://[::ffff:7f00:1]')
    );
    assert.ok(!checkProviderHost('X', 'http://[::ffff:8.8.8.8]/').ok);
    assert.ok(!checkProviderHost('X', 'http://localhost.example.com/').ok);
  });

  void it('parses allow lists and knows loopback', () => {
    assert.deepEqual(parseAllowedHosts(' GPU-box, 192.168.1.20  nas '), [
      'gpu-box',
      '192.168.1.20',
      'nas',
    ]);
    assert.ok(isLoopbackHost('LOCALHOST'));
    assert.ok(isLoopbackHost('[::1]'));
    assert.ok(isLoopbackHost('localhost.'));
    assert.ok(isLoopbackHost('127.0.0.2'));
    assert.ok(!isLoopbackHost('128.0.0.1'));
    assert.ok(!isLoopbackHost('gpu.lan'));
  });
});

void describe('http helpers', () => {
  void it('pulls the message out of a provider error body', () => {
    assert.equal(
      providerMessage('{"error":"model not found"}'),
      'model not found'
    );
    assert.equal(
      providerMessage('{"error":{"message":"bad node"}}'),
      'bad node'
    );
    assert.equal(providerMessage('{"message":"top level"}'), 'top level');
    assert.equal(providerMessage(''), 'no details');
    assert.equal(providerMessage('plain'), 'plain');
    assert.equal(providerMessage('x'.repeat(400)).length, 301);
  });

  void it('encodes base64 without Buffer, including large inputs', () => {
    const data = new Uint8Array(100_000).map((_, index) => index % 256);
    assert.equal(toBase64(data), Buffer.from(data).toString('base64'));
    assert.equal(toBase64(new Uint8Array()), '');
  });
});
