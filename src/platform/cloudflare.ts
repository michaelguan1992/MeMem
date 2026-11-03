import { createMediaService } from '../core/media.ts';
import { createMemoryService } from '../core/service.ts';
import { createD1Store } from '../storage/d1.ts';
import type { D1Binding } from '../storage/d1.ts';
import { createD1MediaStore } from '../storage/media-d1.ts';
import { createR2BlobStore, type R2Binding } from './r2.ts';

export function createCloudflareMedia(env: { DB: D1Binding; MEDIA: R2Binding }, authenticatedOwner: string) {
  return createMediaService({ media: createD1MediaStore(env.DB), blobs: createR2BlobStore(env.MEDIA), memories: createD1Store(env.DB),
    owner: authenticatedOwner, newId: () => crypto.randomUUID(), now: () => new Date().toISOString() });
}

/** Composition for a future Worker transport AFTER authentication succeeds.
 * No unauthenticated HTTP endpoint is exposed by this scaffold.
 */
export function createCloudflareMemory(env: { DB: D1Binding; MEDIA: R2Binding }, authenticatedOwner: string) {
  const memory = createMemoryService({ store: createD1Store(env.DB), owner: authenticatedOwner,
    newId: () => crypto.randomUUID(), now: () => new Date().toISOString() });
  const media = createCloudflareMedia(env, authenticatedOwner);
  return {
    ...memory,
    // Design section 4.3: forgetting a memory unlinks its photos; the photos themselves stay.
    // If the unlink fails, this rejects and the client retries. The retry finds the memory already gone, which
    // memory.forget reports as success, and then unlinks again; unlinkMemory is idempotent.
    async forget(id: string, expectedVersion: number): Promise<void> {
      await memory.forget(id, expectedVersion);
      await media.unlinkMemory(id);
    },
  };
}
