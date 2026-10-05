// Saving the same rule twice keeps one copy.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_DB = 'nivara_test_memory_dedupe';
process.env.LOG_LEVEL = 'silent';
delete process.env.BACKBOARD_API_KEY;
const { client, col } = await import('../src/db.ts');
const ops = await import('../src/ops.ts');
const { publicActivity } = await import('../src/present.ts');
const mongoOk = await client.connect().then(() => true, () => false);
const skip = !mongoOk && 'MongoDB not reachable';
after(async () => { if (mongoOk) await client.db(process.env.MONGODB_DB).dropDatabase(); await client.close(); });

test('saveMemory: same words (any case, spaces) are not saved twice', { skip }, async () => {
  await col.preferences.deleteMany({});
  await ops.saveMemory('Prefer suppliers that deliver within 5 days.');
  const again = await ops.saveMemory('  prefer suppliers that deliver within 5 days. ');
  assert.equal(again.note, 'Already remembered.');
  assert.equal(await col.preferences.countDocuments(), 1);
});

test('activity names voice notes as voice notes', () => {
  const a = publicActivity({ kind: 'voice_order', input: 'राहुल भाई को 2 MB Biozyme', at: new Date(), ms: 2500, spans: [] });
  assert.equal(a.what, 'Read a voice note');
  assert.match(a.question, /राहुल/);
});
