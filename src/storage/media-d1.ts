import type { MediaStore } from '../core/contracts.ts';
import { createD1Driver, type D1Binding } from './d1.ts';
import { createSqlMediaStore } from './media-sql.ts';

export function createD1MediaStore(db: D1Binding): MediaStore {
  return createSqlMediaStore(createD1Driver(db));
}
