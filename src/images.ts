import type { AiImage } from './port.js';
import { err, ok, type Result } from './result.js';

/**
 * The image types providers accept as input and return as output. SVG and
 * every other `image/*` type are left out on purpose: how a caller saves
 * or serves the bytes depends on the type, and only these three are
 * raster formats with no scripting.
 */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const PNG_SIGNATURE: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
];

function startsWith(data: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => data[index] === byte);
}

function hasAscii(data: Uint8Array, offset: number, text: string): boolean {
  return [...text].every(
    (character, index) => data[offset + index] === character.charCodeAt(0)
  );
}

/**
 * The image type from the file's first bytes, or null when they aren't PNG,
 * JPEG or WebP. A declared type is never trusted: it can name one format
 * for another's bytes, or for no image at all.
 */
export function sniffImageType(data: Uint8Array): string | null {
  if (startsWith(data, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (hasAscii(data, 0, 'RIFF') && hasAscii(data, 8, 'WEBP')) {
    return 'image/webp';
  }
  return null;
}

/**
 * An image a provider returned: its type comes from the bytes, and
 * anything that isn't PNG, JPEG or WebP is an error. `what` names the
 * provider and call for the message.
 */
export function checkImageOutput(
  data: Uint8Array,
  what: string
): Result<AiImage> {
  const mimeType: string | null = sniffImageType(data);
  if (mimeType === null) {
    return err(`${what} returned data that isn't a PNG, JPEG or WebP image`);
  }
  return ok({ mimeType, data });
}

const IMAGE_TYPE_NAMES: ReadonlyMap<string, string> = new Map([
  ['image/png', 'PNG'],
  ['image/jpeg', 'JPEG'],
  ['image/webp', 'WebP'],
  ['image/gif', 'GIF'],
]);

/**
 * An image a caller passed in: PNG, JPEG or WebP (or `allowed`, for a
 * provider that takes more), and not empty. `label` names the image
 * ("Image 2") and `providerLabel` the provider, for the message.
 */
export function checkImageInput(
  image: AiImage,
  label: string,
  providerLabel: string,
  allowed: ReadonlySet<string> = IMAGE_TYPES
): Result<AiImage> {
  if (!allowed.has(image.mimeType)) {
    const names: string[] = [...allowed].map(
      (type: string) => IMAGE_TYPE_NAMES.get(type) ?? type
    );
    const list: string =
      names.length > 1
        ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
        : (names[0] ?? 'no image types');
    return err(
      `${label} is ${image.mimeType}; ${providerLabel} takes ${list}.`
    );
  }
  if (image.data.length === 0) return err(`${label} is empty.`);
  return ok(image);
}
