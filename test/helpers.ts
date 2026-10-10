import type { FetchLike } from '../src/index.js';

export interface Call {
  url: URL;
  init: RequestInit | undefined;
}

/** Answers by "METHOD pathname"; a list of answers is used in order. */
export function fakeFetch(
  routes: Record<string, Response | (() => Response) | Array<() => Response>>
): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const counters = new Map<string, number>();
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      const key = `${init?.method ?? 'GET'} ${url.pathname}`;
      const route = routes[key];
      if (route === undefined) return new Response('no route', { status: 404 });
      if (Array.isArray(route)) {
        const index: number = counters.get(key) ?? 0;
        counters.set(key, index + 1);
        const next = route[Math.min(index, route.length - 1)];
        return next === undefined ? new Response('', { status: 500 }) : next();
      }
      return typeof route === 'function' ? route() : route.clone();
    },
  };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
