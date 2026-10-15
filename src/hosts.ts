import { err, ok, type Result } from './result.js';

/**
 * Where a self-hosted provider (Ollama, ComfyUI) may live. By default only
 * this machine: a typo'd or copied address can't send prompts and images to
 * someone else's server. Extra hosts (say, a GPU box on the home network)
 * must be listed explicitly.
 */

/**
 * A host in one comparable form: lower case, one pair of IPv6 brackets and
 * one trailing dot removed, so `[FE80::1]`, `fe80::1` and `Localhost.` match
 * their plain spellings.
 */
export function normalizeHost(hostname: string): string {
  let host: string = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/**
 * Loopback: `localhost`, anything in 127.0.0.0/8, `::1`, and the
 * IPv4-mapped form of a 127 address (`::ffff:7f00:1`, which is how the URL
 * parser writes `[::ffff:127.0.0.1]`).
 */
export function isLoopbackHost(hostname: string): boolean {
  const host: string = normalizeHost(hostname);
  return (
    host === 'localhost' ||
    host === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
  );
}

export interface ProviderHostOptions {
  /** Host names allowed besides loopback, lower case (see parseAllowedHosts). */
  readonly allowedHosts?: readonly string[];
  /** What to call the allow list in messages, e.g. an env variable name. */
  readonly allowedHostsLabel?: string;
}

/**
 * Checks a provider's base URL: http(s), just an origin, on loopback or an
 * allowed host. Returns the origin without a trailing slash. `name` is what
 * the setting is called in messages, e.g. OLLAMA_HOST.
 */
export function checkProviderHost(
  name: string,
  value: string,
  options: ProviderHostOptions = {}
): Result<string> {
  const allowedHosts: readonly string[] = (options.allowedHosts ?? []).map(
    normalizeHost
  );
  const label: string = options.allowedHostsLabel ?? 'the allowed hosts';
  // Messages never repeat `value`: a pasted URL may carry a password.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return err(
      `${name} is not a URL; use e.g. http://127.0.0.1:11434 (the value is not shown in case it holds a password)`
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return err(`${name} must use http or https, not ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    return err(
      `${name} must not contain a username or password; use ${url.origin}`
    );
  }
  const host: string = normalizeHost(url.hostname);
  if (!isLoopbackHost(host) && !allowedHosts.includes(host)) {
    return err(
      `${name} points at ${host}, which isn't this machine. Use 127.0.0.1, or add ${host} to ${label} if it's your own server.`
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return err(`${name} should be just the address, e.g. ${url.origin}`);
  }
  return ok(url.origin);
}

/** "gpu-box, 192.168.1.20" → ['gpu-box', '192.168.1.20']. */
export function parseAllowedHosts(value: string): readonly string[] {
  return value
    .split(/[\s,]+/)
    .map(normalizeHost)
    .filter((host) => host !== '');
}
