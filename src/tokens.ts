// Access tokens issued to agents: opaque, hashed at rest, bound to an owner, client, scope set and audience.
import type { AuthenticatedGrant, Grant, SqlDatabase, TableNames } from './types.js';
import { GatewayError } from './types.js';
import { nowIso, parseJsonList, sha256Hex } from './util.js';

type AccessRow = {
  id: string;
  token_hash: string;
  token_prefix: string;
  name: string;
  owner_uid: string;
  scopes: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked: number;
  client_id: string | null;
  audience: string | null;
};

export interface TokenStore {
  issue(input: { ownerId: string; clientId: string; clientName: string; scopes: string[]; audience: string }): Promise<{ id: string; token: string; expiresAt: string }>;
  verify(token: string, audience: string): Promise<AuthenticatedGrant>;
  revoke(id: string): Promise<{ ownerId: string; clientId: string; clientName: string } | null>;
  list(ownerId: string): Promise<Grant[]>;
  owns(ownerId: string, id: string): Promise<boolean>;
  lookup(id: string): Promise<{ clientId: string; clientName: string } | null>;
}

function randomToken(prefix: string) {
  return prefix + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

export function createTokenStore(db: SqlDatabase, table: TableNames['accessTokens'], prefix: string, ttlDays: number, allowedScopes: readonly string[]): TokenStore {
  return {
    async issue(input) {
      const scopes = input.scopes.filter((scope) => allowedScopes.includes(scope));
      if (!scopes.length) throw new GatewayError(400, 'Invalid token scopes');
      const raw = randomToken(prefix);
      const id = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000).toISOString();
      await db
        .prepare(`INSERT INTO ${table}(id, token_hash, token_prefix, name, owner_uid, scopes, created_at, expires_at, revoked, last_used_at, client_id, audience) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, ?9, ?10)`)
        .bind(id, await sha256Hex(raw), raw.slice(0, 8), input.clientName.slice(0, 200), input.ownerId, JSON.stringify(scopes), nowIso(), expiresAt, input.clientId, input.audience)
        .run();
      return { id, token: raw, expiresAt };
    },
    async verify(token, audience) {
      const row = await db.prepare(`SELECT * FROM ${table} WHERE token_hash = ?1`).bind(await sha256Hex(token)).first<AccessRow>();
      if (!row) throw new GatewayError(401, 'Invalid agent token');
      if (row.revoked === 1) throw new GatewayError(401, 'Agent token revoked');
      if (row.expires_at && row.expires_at < nowIso()) throw new GatewayError(401, 'Agent token expired');
      if (row.audience !== audience) throw new GatewayError(401, 'Agent token audience mismatch; authorize again');
      await db.prepare(`UPDATE ${table} SET last_used_at = ?1 WHERE id = ?2`).bind(nowIso(), row.id).run();
      return { grantId: row.id, ownerId: row.owner_uid, scopes: parseJsonList(row.scopes), clientId: row.client_id || '', clientName: row.name, audience };
    },
    async revoke(id) {
      const row = await db.prepare(`SELECT owner_uid, client_id, name, revoked FROM ${table} WHERE id = ?1`).bind(id).first<Pick<AccessRow, 'owner_uid' | 'client_id' | 'name' | 'revoked'>>();
      await db.prepare(`UPDATE ${table} SET revoked = 1 WHERE id = ?1`).bind(id).run();
      return row && !row.revoked ? { ownerId: row.owner_uid, clientId: row.client_id || '', clientName: row.name } : null;
    },
    async list(ownerId) {
      const result = await db.prepare(`SELECT * FROM ${table} WHERE owner_uid = ?1 ORDER BY created_at DESC`).bind(ownerId).all<AccessRow>();
      // Rows without a client_id predate OAuth-only access and can never be used again; hide them.
      return (result.results || [])
        .filter((row) => row.client_id)
        .map((row) => ({
          id: row.id,
          name: row.name,
          ownerId: row.owner_uid,
          scopes: parseJsonList(row.scopes),
          clientId: row.client_id || '',
          createdAt: row.created_at,
          expiresAt: row.expires_at || '',
          lastUsedAt: row.last_used_at || '',
          revoked: row.revoked === 1,
          expired: !!row.expires_at && row.expires_at < nowIso(),
          prefix: row.token_prefix,
        }));
    },
    async owns(ownerId, id) {
      return !!(await db.prepare(`SELECT id FROM ${table} WHERE id = ?1 AND owner_uid = ?2`).bind(id, ownerId).first());
    },
    async lookup(id) {
      const row = await db.prepare(`SELECT client_id, name FROM ${table} WHERE id = ?1`).bind(id).first<Pick<AccessRow, 'client_id' | 'name'>>();
      return row ? { clientId: row.client_id || '', clientName: row.name } : null;
    },
  };
}

export async function ensureTokenSchema(db: SqlDatabase, table: string) {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, name TEXT NOT NULL, owner_uid TEXT NOT NULL, scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, client_id TEXT, audience TEXT);`,
  );
}
