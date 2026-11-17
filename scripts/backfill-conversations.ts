import { loadConfig } from '../src/server/config';
import { Ledger } from '../src/server/storage';

// Opening schema-v2 verifies every root and atomically publishes the v3 index.
// A v3 database is left intact: rebuilding it could renumber retained deep links.
const ledger = new Ledger(loadConfig());
try {
  console.log(
    JSON.stringify({
      schema: 3,
      records: ledger.metrics().records,
      conversations: ledger.db.query('SELECT count(*) AS count FROM conversations').get(),
    }),
  );
} finally {
  ledger.close();
}
