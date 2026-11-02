import type { BlobStore } from '../core/contracts.ts';

/** Structural subset of an R2 bucket binding; provider types stay out of core. */
export interface R2Binding {
  put(key: string, value: Uint8Array, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; httpMetadata?: { contentType?: string } } | null>;
  delete(keys: string[]): Promise<void>;
}

export function createR2BlobStore(bucket: R2Binding): BlobStore {
  return {
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(key);
      return object ? { body: object.body, contentType: object.httpMetadata?.contentType ?? 'application/octet-stream' } : null;
    },
    async delete(keys) {
      if (keys.length) await bucket.delete(keys);
    },
  };
}
