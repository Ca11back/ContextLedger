import '@tanstack/react-start/server-only';
import { loadConfig } from './config';
import { Ledger } from './storage';
import { Transport } from './transport';

const state = globalThis as typeof globalThis & {
  contextLedger?: Ledger;
  contextLedgerTransport?: Transport;
  contextLedgerTimer?: ReturnType<typeof setInterval>;
};
export function ledger() {
  state.contextLedger ??= new Ledger(loadConfig());
  return state.contextLedger;
}
export function transport() {
  state.contextLedgerTransport ??= new Transport(ledger());
  return state.contextLedgerTransport;
}
export function startMaintenance() {
  const store = ledger();
  state.contextLedgerTimer ??= setInterval(() => {
    void transport()
      .maintain()
      .then(() => store.maintain())
      .catch(() => console.error('{"event":"maintenance_failed"}'));
  }, store.config.maintenanceMs);
  state.contextLedgerTimer.unref();
}
