import { loadConfig } from '../src/server/config';
import { Ledger } from '../src/server/storage';

const store = new Ledger(loadConfig());
try {
  const backupAt = process.argv.indexOf('--backup');
  if (backupAt !== -1) {
    const path = process.argv[backupAt + 1];
    if (!path) throw new Error('Supply --backup destination');
    store.backup(path);
  }
  console.log(JSON.stringify(store.integrity(process.argv.includes('--rebuild'))));
} finally {
  store.close();
}
