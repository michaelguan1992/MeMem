import { openSqliteStore } from '../src/storage/sqlite.ts';
import { createMemoryService } from '../src/core/service.ts';

const db = openSqliteStore(':memory:');
const memory = createMemoryService({ store: db.store, owner: 'demo',
  newId: () => crypto.randomUUID(), now: () => new Date().toISOString() });
try {
  const matthew = await memory.record({ kind: 'person', text: 'Matthew，朋友聚餐时认识。' });
  await memory.record({ kind: 'fact', text: 'Matthew 的妻子叫 Linda。', relatedIds: [matthew.id] });
  console.log(JSON.stringify(await memory.search({ relatedTo: matthew.id }), null, 2));
} finally { db.close(); }
