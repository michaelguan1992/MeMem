import { createMemoryService } from '../core/service.ts';
import { createD1Store } from '../storage/d1.ts';
import type { D1Binding } from '../storage/d1.ts';

/** Composition for a future Worker transport AFTER authentication succeeds.
 * No unauthenticated HTTP endpoint is exposed by this scaffold.
 */
export function createCloudflareMemory(env: { DB: D1Binding }, authenticatedOwner: string) {
  return createMemoryService({ store: createD1Store(env.DB), owner: authenticatedOwner,
    newId: () => crypto.randomUUID(), now: () => new Date().toISOString() });
}
