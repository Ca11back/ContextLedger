import { type Envelope, object } from '../contracts';
import { hash } from './codec';

export interface IsolationDomain {
  source: string;
  userId: string;
  tokenId: string;
  protocol: string;
}
export interface DeclaredIdentity {
  clientKind: 'codex';
  threadKey: string;
  sessionKey: string | null;
  parentThreadKey: string | null;
  windowKey: string | null;
  agentName: string | null;
  subagentKind: string | null;
}
export function identityId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
export function isolationDomain(envelope: Envelope, protocol: string): IsolationDomain | null {
  const userId = identityId(object(envelope.report.user).id);
  const tokenId = identityId(object(envelope.report.token).id);
  return userId === null || tokenId === null
    ? null
    : { source: envelope.source, userId, tokenId, protocol };
}
function identityValue(value: unknown, limit = 256): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
    ? value
    : null;
}
export function identityKey(
  domain: IsolationDomain,
  namespace: 'thread' | 'session' | 'window',
  value: string,
): string {
  return hash(
    JSON.stringify([
      'cl-id-v1',
      domain.source,
      domain.userId,
      domain.tokenId,
      domain.protocol,
      namespace,
      value,
    ]),
  );
}
export function parseCodexIdentity(
  body: unknown,
  domain: IsolationDomain | null,
): DeclaredIdentity | null {
  if (!domain) return null;
  const metadata = object(object(body).client_metadata);
  const encoded = metadata['x-codex-turn-metadata'];
  if (typeof encoded !== 'string') return null;
  let declaration: Record<string, unknown>;
  try {
    declaration = object(JSON.parse(encoded));
  } catch {
    return null;
  }
  const thread = identityValue(declaration.thread_id);
  if (thread === null) return null;
  const key = (namespace: 'thread' | 'session' | 'window', value: unknown) => {
    const valid = identityValue(value);
    return valid === null ? null : identityKey(domain, namespace, valid);
  };
  return {
    clientKind: 'codex',
    threadKey: identityKey(domain, 'thread', thread),
    sessionKey: key('session', declaration.session_id),
    parentThreadKey: key('thread', declaration.parent_thread_id),
    windowKey: key('window', identityValue(declaration.window_id) ?? metadata['x-codex-window-id']),
    agentName: identityValue(declaration.agent_name, 64),
    subagentKind: identityValue(declaration.subagent_kind, 32),
  };
}
