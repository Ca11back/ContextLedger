import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/server/config';
import { SCHEMA_VERSION } from '../src/server/linking';
import { Ledger } from '../src/server/storage';

// Before an approved deployment, stop the collector and run this command with
// --backup <new-path>. The backup is taken BEFORE Ledger opens/migrates old schemas.
// --rebuild explicitly recomputes membership; conversation/turn ids
// may change. Original request ids, exact evidence, charges and CAS stay intact.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    `bun run scripts/backfill-conversations.ts [--backup <new-path>] [--rebuild]\nStop the collector and back up before deployment. Opening schema2/3/4/5/6 migrates to schema${SCHEMA_VERSION}; schema5/6 preserves conversation/turn ids. --rebuild recomputes membership and may change derived conversation/turn ids.`,
  );
} else {
  if (
    args.some(
      (arg, index) => arg !== '--rebuild' && arg !== '--backup' && args[index - 1] !== '--backup',
    )
  )
    throw new Error('Unknown argument');
  const config = loadConfig();
  const backupAt = args.indexOf('--backup');
  if (backupAt !== -1) {
    const destination = args[backupAt + 1];
    if (!destination || destination.startsWith('--'))
      throw new Error('Supply --backup destination');
    if (existsSync(destination)) throw new Error('Backup destination exists');
    const source = new Database(config.database, { readonly: true, strict: true });
    try {
      source.query('VACUUM INTO ?').run(destination);
    } finally {
      source.close();
    }
  }
  const ledger = new Ledger(config);
  try {
    if (args.includes('--rebuild')) ledger.rebuildConversations();
    console.log(
      JSON.stringify({
        schema: SCHEMA_VERSION,
        records: ledger.metrics().records,
        conversations: ledger.db.query('SELECT count(*) AS count FROM conversations').get(),
      }),
    );
  } finally {
    ledger.close();
  }
}
