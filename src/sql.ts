// Optional adapter: AppServerStore over any SQLite-flavoured SQL driver. Cloudflare D1 satisfies
// `SqlDatabase` as-is; node:sqlite, better-sqlite3, libsql and sql.js need a ten-line wrapper
// (see docs/integration.md). Imported from '@erzhiqian/mcp-app-server/sql'; the core never loads it.
import type { AccessTokenRecord, ClientRecord, CodeRecord, AppServerStore, RefreshTokenRecord } from './store.js';

/** Minimal SQL surface the adapter needs: `?1 … ?n` placeholders, `first()`, `all()`, `run().meta.changes`. */
export interface SqlDatabase {
  exec(sql: string): Promise<unknown>;
  prepare(sql: string): SqlStatement;
}
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface TableNames {
  clients: string;
  codes: string;
  refreshTokens: string;
  accessTokens: string;
}

const DEFAULT_TABLES: TableNames = { clients: 'agent_clients', codes: 'agent_codes', refreshTokens: 'agent_refresh_tokens', accessTokens: 'agent_access_tokens' };

type ClientRow = { client_id: string; client_secret_hash: string | null; client_name: string; redirect_uris: string; token_endpoint_auth_method: string; scope: string | null; created_at: string; last_used_at: string | null };
type CodeRow = { code_hash: string; client_id: string; owner_uid: string; redirect_uri: string; scopes: string; code_challenge: string; resource: string | null; expires_at: string; used_at: string | null; issued_token_id: string | null };
type RefreshRow = { token_hash: string; client_id: string; owner_uid: string; access_token_id: string; scopes: string; expires_at: string; revoked: number; successor_id: string | null };
type AccessRow = { id: string; token_hash: string; token_prefix: string; name: string; owner_uid: string; scopes: string; created_at: string; expires_at: string | null; last_used_at: string | null; revoked: number; client_id: string | null; audience: string | null };

function list(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
  } catch {}
  return raw.split(/\s+/).filter(Boolean);
}

const client = (r: ClientRow): ClientRecord => ({ id: r.client_id, secretHash: r.client_secret_hash, name: r.client_name, redirectUris: list(r.redirect_uris), tokenEndpointAuthMethod: r.token_endpoint_auth_method, scope: r.scope, createdAt: r.created_at, lastUsedAt: r.last_used_at });
const code = (r: CodeRow): CodeRecord => ({ hash: r.code_hash, clientId: r.client_id, ownerId: r.owner_uid, redirectUri: r.redirect_uri, scopes: list(r.scopes), codeChallenge: r.code_challenge, resource: r.resource, expiresAt: r.expires_at, usedAt: r.used_at, issuedTokenId: r.issued_token_id });
const refresh = (r: RefreshRow): RefreshTokenRecord => ({ hash: r.token_hash, clientId: r.client_id, ownerId: r.owner_uid, accessTokenId: r.access_token_id, scopes: list(r.scopes), expiresAt: r.expires_at, revoked: r.revoked === 1, successorId: r.successor_id });
const access = (r: AccessRow): AccessTokenRecord => ({ id: r.id, hash: r.token_hash, prefix: r.token_prefix, clientId: r.client_id || '', clientName: r.name, ownerId: r.owner_uid, scopes: list(r.scopes), audience: r.audience || '', createdAt: r.created_at, expiresAt: r.expires_at || '', lastUsedAt: r.last_used_at, revoked: r.revoked === 1 });

/** @param tables Override table names only when adopting an existing schema. */
export function sqlStore(db: SqlDatabase, tables: Partial<TableNames> = {}): AppServerStore {
  const t = { ...DEFAULT_TABLES, ...tables };
  const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  return {
    clients: {
      async create(c) {
        await q(`INSERT INTO ${t.clients}(client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, scope, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`, c.id, c.secretHash, c.name, JSON.stringify(c.redirectUris), c.tokenEndpointAuthMethod, c.scope, c.createdAt).run();
      },
      async get(id) {
        const row = await q(`SELECT * FROM ${t.clients} WHERE client_id = ?1`, id).first<ClientRow>();
        return row ? client(row) : null;
      },
      async touch(id, usedAt) {
        await q(`UPDATE ${t.clients} SET last_used_at = ?1 WHERE client_id = ?2`, usedAt, id).run();
      },
    },
    codes: {
      async create(c) {
        await q(`INSERT INTO ${t.codes}(code_hash, client_id, owner_uid, redirect_uri, scopes, code_challenge, resource, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`, c.hash, c.clientId, c.ownerId, c.redirectUri, JSON.stringify(c.scopes), c.codeChallenge, c.resource, c.expiresAt).run();
      },
      async get(hash) {
        const row = await q(`SELECT * FROM ${t.codes} WHERE code_hash = ?1`, hash).first<CodeRow>();
        return row ? code(row) : null;
      },
      async consume(hash, usedAt) {
        return !!(await q(`UPDATE ${t.codes} SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL`, usedAt, hash).run()).meta.changes;
      },
      async setIssuedToken(hash, id) {
        await q(`UPDATE ${t.codes} SET issued_token_id = ?1 WHERE code_hash = ?2`, id, hash).run();
      },
    },
    refreshTokens: {
      async create(r) {
        await q(`INSERT INTO ${t.refreshTokens}(token_hash, client_id, owner_uid, access_token_id, scopes, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`, r.hash, r.clientId, r.ownerId, r.accessTokenId, JSON.stringify(r.scopes), r.expiresAt).run();
      },
      async get(hash) {
        const row = await q(`SELECT * FROM ${t.refreshTokens} WHERE token_hash = ?1`, hash).first<RefreshRow>();
        return row ? refresh(row) : null;
      },
      async getByAccessToken(id) {
        const row = await q(`SELECT * FROM ${t.refreshTokens} WHERE access_token_id = ?1`, id).first<RefreshRow>();
        return row ? refresh(row) : null;
      },
      async revoke(hash) {
        return !!(await q(`UPDATE ${t.refreshTokens} SET revoked = 1 WHERE token_hash = ?1 AND revoked = 0`, hash).run()).meta.changes;
      },
      async revokeByAccessToken(id) {
        await q(`UPDATE ${t.refreshTokens} SET revoked = 1 WHERE access_token_id = ?1`, id).run();
      },
      async setSuccessor(hash, id) {
        await q(`UPDATE ${t.refreshTokens} SET successor_id = ?1 WHERE token_hash = ?2`, id, hash).run();
      },
    },
    accessTokens: {
      async create(a) {
        await q(`INSERT INTO ${t.accessTokens}(id, token_hash, token_prefix, name, owner_uid, scopes, created_at, expires_at, revoked, last_used_at, client_id, audience) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, NULL, ?9, ?10)`, a.id, a.hash, a.prefix, a.clientName, a.ownerId, JSON.stringify(a.scopes), a.createdAt, a.expiresAt, a.clientId, a.audience).run();
      },
      async get(id) {
        const row = await q(`SELECT * FROM ${t.accessTokens} WHERE id = ?1`, id).first<AccessRow>();
        return row ? access(row) : null;
      },
      async getByHash(hash) {
        const row = await q(`SELECT * FROM ${t.accessTokens} WHERE token_hash = ?1`, hash).first<AccessRow>();
        return row ? access(row) : null;
      },
      async listByOwner(ownerId) {
        const rows = (await q(`SELECT * FROM ${t.accessTokens} WHERE owner_uid = ?1 ORDER BY created_at DESC`, ownerId).all<AccessRow>()).results || [];
        // Rows without a client_id predate OAuth-only access and can never be used again; hide them.
        return rows.filter((row) => row.client_id).map(access);
      },
      async touch(id, usedAt) {
        await q(`UPDATE ${t.accessTokens} SET last_used_at = ?1 WHERE id = ?2`, usedAt, id).run();
      },
      async revoke(id) {
        return !!(await q(`UPDATE ${t.accessTokens} SET revoked = 1 WHERE id = ?1 AND revoked = 0`, id).run()).meta.changes;
      },
    },
    async prune(now) {
      await q(`DELETE FROM ${t.codes} WHERE expires_at < ?1`, now).run();
      await q(`DELETE FROM ${t.refreshTokens} WHERE expires_at < ?1`, now).run();
    },
    async ensureSchema() {
      await db.exec(`CREATE TABLE IF NOT EXISTS ${t.accessTokens} (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, token_prefix TEXT NOT NULL, name TEXT NOT NULL, owner_uid TEXT NOT NULL, scopes TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked INTEGER NOT NULL DEFAULT 0, last_used_at TEXT, client_id TEXT, audience TEXT);`);
      await db.exec(`CREATE TABLE IF NOT EXISTS ${t.clients} (client_id TEXT PRIMARY KEY, client_secret_hash TEXT, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL, token_endpoint_auth_method TEXT NOT NULL, scope TEXT, created_at TEXT NOT NULL, last_used_at TEXT);`);
      await db.exec(`CREATE TABLE IF NOT EXISTS ${t.codes} (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, owner_uid TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL, code_challenge TEXT NOT NULL, resource TEXT, expires_at TEXT NOT NULL, used_at TEXT, issued_token_id TEXT);`);
      await db.exec(`CREATE TABLE IF NOT EXISTS ${t.refreshTokens} (token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, owner_uid TEXT NOT NULL, access_token_id TEXT NOT NULL, scopes TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, successor_id TEXT);`);
    },
  };
}
