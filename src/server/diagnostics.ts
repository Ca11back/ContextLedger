// Only fixed codes and bounded numbers cross the diagnostic logging boundary.
const statuses: Record<string, number | number[]> = {
  stored: 200,
  duplicate: 200,
  staged: 202,
  ingest_auth_required: 401,
  json_required: 415,
  empty_body: 400,
  invalid_envelope: 400,
  body_too_large: 413,
  upload_id_conflict: 409,
  ingestion_busy: 503,
  object_changed_during_preparation: 503,
  maintenance_lease_lost: 503,
  record_exceeds_storage_budget: 507,
  storage_pressure: 507,
  invalid_wire: 400,
  unsupported_wire_version: 400,
  invalid_manifest: 400,
  inconsistent_length: [400, 409],
  envelope_length_mismatch: 400,
  invalid_hint: 400,
  invalid_priority: 400,
  invalid_objects: 400,
  invalid_object: 400,
  unrequested_object: 400,
  object_hash_mismatch: 400,
  envelope_too_large: 413,
  manifest_too_large: 413,
  staging_limit: 507,
  staging_pressure: 507,
  upload_expired: 410,
  upload_record_evicted: 410,
  upload_not_found: 404,
  object_integrity_error: 500,
  manifest_integrity_error: 500,
  body_integrity_error: 500,
  refcount_integrity_error: 500,
  internal_error: 500,
};
const bounded = (value: number, max: number) =>
  Number.isFinite(value) && value >= 0 ? Math.min(max, Math.floor(value)) : 0;
export function ingestDiagnostic(
  status: number,
  code: string,
  receivedBytes: number,
  durationMs: number,
) {
  const allowed = Object.hasOwn(statuses, code) ? statuses[code] : undefined;
  const safeCode =
    allowed !== undefined &&
    (Array.isArray(allowed) ? allowed.includes(status) : allowed === status)
      ? code
      : 'internal_error';
  console.info(
    JSON.stringify({
      event: 'ingest_outcome',
      status: safeCode === 'internal_error' ? 500 : status,
      code: safeCode,
      received_bytes: bounded(receivedBytes, 1024 * 1024 * 1024),
      duration_ms: bounded(durationMs, 86_400_000),
    }),
  );
}
