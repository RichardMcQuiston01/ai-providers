import { err, ok, type Result } from './result.js';

/**
 * Where a self-hosted provider (Ollama, ComfyUI) may live. By default only
 * this machine: a typo'd or copied address can't send prompts and images to
 * someone else's server. Extra hosts (say, a GPU box on the home network)
 * must be listed explicitly.
 */

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
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
  const allowedHosts: readonly string[] = options.allowedHosts ?? [];
  const label: string = options.allowedHostsLabel ?? 'the allowed hosts';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return err(
      `${name} "${value}" is not a URL; use e.g. http://127.0.0.1:11434`
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return err(`${name} "${value}" must use http or https`);
  }
  const host: string = url.hostname.toLowerCase();
  if (!isLoopbackHost(host) && !allowedHosts.includes(host)) {
    return err(
      `${name} points at ${host}, which isn't this machine. Use 127.0.0.1, or add ${host} to ${label} if it's your own server.`
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return err(
      `${name} "${value}" should be just the address, e.g. ${url.origin}`
    );
  }
  return ok(url.origin);
}

/** "gpu-box, 192.168.1.20" → ['gpu-box', '192.168.1.20']. */
export function parseAllowedHosts(value: string): readonly string[] {
  return value
    .split(/[\s,]+/)
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');
}
