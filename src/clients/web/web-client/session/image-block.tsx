/**
 * Inline image content block (spec C.7 / AC-8).
 *
 * Renders an `ImageContent` ({ data: base64, mimeType }) as a bounded inline
 * `<img>` via a `data:` URL. The mime type is whitelisted to known image types
 * so a hostile `mimeType` cannot smuggle a `data:text/html` document into the
 * src; the base64 payload itself is inert in an `<img>`.
 */

import type { ImageContent } from '@/shared/protocol.js';

const SAFE_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif',
  'image/bmp',
]);

export interface ImageBlockProps {
  image: ImageContent;
}

export function ImageBlock({ image }: ImageBlockProps) {
  const rawMime = (image.mimeType || '').toLowerCase();
  const mime = SAFE_IMAGE_MIME.has(rawMime) ? rawMime : 'image/png';
  const src = `data:${mime};base64,${image.data ?? ''}`;
  return (
    <img
      // .cw-img equivalent: bounded display block, rounded, contained.
      className="block max-w-[min(100%,520px)] max-h-[26rem] rounded-md my-1.5 object-contain"
      src={src}
      alt="image content"
      loading="lazy"
      decoding="async"
    />
  );
}
