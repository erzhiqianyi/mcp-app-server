// Access tokens issued to agents: opaque, hashed at rest, bound to an owner, client, scope set and audience.
import type { AuthenticatedGrant, Grant } from './types.js';
import { AppServerError } from './types.js';
import type { AccessTokenRecord, AppServerStore } from './store.js';
import { nowIso, sha256Hex } from './util.js';

export interface TokenStore {
  issue(input: { ownerId: string; clientId: string; clientName: string; scopes: string[]; audience: string }): Promise<{ id: string; token: string; expiresAt: string }>;
  verify(token: string, audience: string): Promise<AuthenticatedGrant>;
  /** Returns the token's identity when it was active and is now revoked; null otherwise. */
  revoke(id: string): Promise<{ ownerId: string; clientId: string; clientName: string } | null>;
  list(ownerId: string): Promise<Grant[]>;
  owns(ownerId: string, id: string): Promise<boolean>;
}

function randomToken(prefix: string) {
  return prefix + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

const toGrant = (row: AccessTokenRecord): Grant => ({
  id: row.id,
  name: row.clientName,
  ownerId: row.ownerId,
  scopes: row.scopes,
  clientId: row.clientId,
  createdAt: row.createdAt,
  expiresAt: row.expiresAt,
  lastUsedAt: row.lastUsedAt || '',
  revoked: row.revoked,
  expired: !!row.expiresAt && row.expiresAt < nowIso(),
  prefix: row.prefix,
});

export function createTokenStore(store: AppServerStore, prefix: string, ttlDays: number, allowedScopes: readonly string[]): TokenStore {
  const tokens = store.accessTokens;
  return {
    async issue(input) {
      const scopes = input.scopes.filter((scope) => allowedScopes.includes(scope));
      if (!scopes.length) throw new AppServerError(400, 'Invalid token scopes');
      const raw = randomToken(prefix);
      const id = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000).toISOString();
      await tokens.create({ id, hash: await sha256Hex(raw), prefix: raw.slice(0, 8), clientId: input.clientId, clientName: input.clientName.slice(0, 200), ownerId: input.ownerId, scopes, audience: input.audience, createdAt: nowIso(), expiresAt, lastUsedAt: null, revoked: false });
      return { id, token: raw, expiresAt };
    },
    async verify(token, audience) {
      const row = await tokens.getByHash(await sha256Hex(token));
      if (!row) throw new AppServerError(401, 'Invalid agent token');
      if (row.revoked) throw new AppServerError(401, 'Agent token revoked');
      if (row.expiresAt && row.expiresAt < nowIso()) throw new AppServerError(401, 'Agent token expired');
      if (row.audience !== audience) throw new AppServerError(401, 'Agent token audience mismatch; authorize again');
      await tokens.touch(row.id, nowIso());
      return { grantId: row.id, ownerId: row.ownerId, scopes: row.scopes, clientId: row.clientId, clientName: row.clientName, audience };
    },
    async revoke(id) {
      const row = await tokens.get(id);
      if (!row) return null;
      const changed = await tokens.revoke(id);
      return changed ? { ownerId: row.ownerId, clientId: row.clientId, clientName: row.clientName } : null;
    },
    async list(ownerId) {
      return (await tokens.listByOwner(ownerId)).map(toGrant);
    },
    async owns(ownerId, id) {
      const row = await tokens.get(id);
      return !!row && row.ownerId === ownerId;
    },
  };
}
