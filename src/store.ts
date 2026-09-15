// Storage contract. the server core never touches a database: everything it needs to remember
// (registered clients, authorization codes, refresh chains, access tokens) goes through this
// interface. Implement it over whatever you already run — SQL, KV, Redis, Mongo, an ORM.
//
// Records are plain objects. Secrets (codes, tokens, client secrets) arrive already hashed;
// the store never sees a raw credential. Timestamps are ISO-8601 strings and compare lexically.

export interface ClientRecord {
  id: string;
  /** SHA-256 of the client secret, or null for public clients (`token_endpoint_auth_method: none`). */
  secretHash: string | null;
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  /** Default scope string the client asked for at registration, if any. */
  scope: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface CodeRecord {
  /** SHA-256 of the authorization code; the primary key. */
  hash: string;
  clientId: string;
  ownerId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  resource: string | null;
  expiresAt: string;
  usedAt: string | null;
  /** Access token issued when the code was exchanged; used to revoke on replay. */
  issuedTokenId: string | null;
}

export interface RefreshTokenRecord {
  /** SHA-256 of the refresh token; the primary key. */
  hash: string;
  clientId: string;
  ownerId: string;
  /** The access token this refresh token was issued together with. Unique per record. */
  accessTokenId: string;
  scopes: string[];
  expiresAt: string;
  revoked: boolean;
  /** Access token id of the pair that replaced this one after rotation. */
  successorId: string | null;
}

export interface AccessTokenRecord {
  id: string;
  /** SHA-256 of the access token. Unique. */
  hash: string;
  /** First characters of the raw token, shown to users so they can recognise it. */
  prefix: string;
  clientId: string;
  clientName: string;
  ownerId: string;
  scopes: string[];
  audience: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface AppServerStore {
  clients: {
    create(client: ClientRecord): Promise<void>;
    get(clientId: string): Promise<ClientRecord | null>;
    /** Record that the client obtained a token. */
    touch(clientId: string, usedAt: string): Promise<void>;
  };
  codes: {
    create(code: CodeRecord): Promise<void>;
    get(hash: string): Promise<CodeRecord | null>;
    /**
     * Mark the code used **atomically**: return true only for the first caller; false if it was
     * already consumed. Two concurrent exchanges of the same code must not both succeed.
     */
    consume(hash: string, usedAt: string): Promise<boolean>;
    setIssuedToken(hash: string, accessTokenId: string): Promise<void>;
  };
  refreshTokens: {
    create(token: RefreshTokenRecord): Promise<void>;
    get(hash: string): Promise<RefreshTokenRecord | null>;
    getByAccessToken(accessTokenId: string): Promise<RefreshTokenRecord | null>;
    /**
     * Mark the token revoked **atomically**: return true only if it was active. Refresh-token
     * rotation relies on this so a replayed token cannot be redeemed twice.
     */
    revoke(hash: string): Promise<boolean>;
    revokeByAccessToken(accessTokenId: string): Promise<void>;
    setSuccessor(hash: string, accessTokenId: string): Promise<void>;
  };
  accessTokens: {
    create(token: AccessTokenRecord): Promise<void>;
    get(id: string): Promise<AccessTokenRecord | null>;
    getByHash(hash: string): Promise<AccessTokenRecord | null>;
    /** Newest first. */
    listByOwner(ownerId: string): Promise<AccessTokenRecord[]>;
    touch(id: string, usedAt: string): Promise<void>;
    /** Return true if the token was active and is now revoked. */
    revoke(id: string): Promise<boolean>;
  };
  /** Optional: delete codes and refresh tokens whose `expiresAt` is before `now`. Called opportunistically. */
  prune?(now: string): Promise<void>;
  /** Optional: idempotent setup (create tables, indexes…). Exposed as `mcp.ensureSchema()`. */
  ensureSchema?(): Promise<void>;
}

/**
 * Reference implementation backed by Maps. Suitable for tests, local development and
 * single-process servers; state is lost on restart. Also the smallest correct example
 * of the contract for anyone writing their own store.
 */
export function memoryStore(): AppServerStore {
  const clients = new Map<string, ClientRecord>();
  const codes = new Map<string, CodeRecord>();
  const refresh = new Map<string, RefreshTokenRecord>();
  const access = new Map<string, AccessTokenRecord>();
  const accessByHash = new Map<string, string>();
  const copy = <T>(value: T | undefined): T | null => (value ? { ...value } : null);
  return {
    clients: {
      async create(client) {
        clients.set(client.id, { ...client });
      },
      async get(id) {
        return copy(clients.get(id));
      },
      async touch(id, usedAt) {
        const row = clients.get(id);
        if (row) row.lastUsedAt = usedAt;
      },
    },
    codes: {
      async create(code) {
        codes.set(code.hash, { ...code });
      },
      async get(hash) {
        return copy(codes.get(hash));
      },
      async consume(hash, usedAt) {
        const row = codes.get(hash);
        if (!row || row.usedAt) return false;
        row.usedAt = usedAt;
        return true;
      },
      async setIssuedToken(hash, id) {
        const row = codes.get(hash);
        if (row) row.issuedTokenId = id;
      },
    },
    refreshTokens: {
      async create(token) {
        refresh.set(token.hash, { ...token });
      },
      async get(hash) {
        return copy(refresh.get(hash));
      },
      async getByAccessToken(id) {
        for (const row of refresh.values()) if (row.accessTokenId === id) return { ...row };
        return null;
      },
      async revoke(hash) {
        const row = refresh.get(hash);
        if (!row || row.revoked) return false;
        row.revoked = true;
        return true;
      },
      async revokeByAccessToken(id) {
        for (const row of refresh.values()) if (row.accessTokenId === id) row.revoked = true;
      },
      async setSuccessor(hash, id) {
        const row = refresh.get(hash);
        if (row) row.successorId = id;
      },
    },
    accessTokens: {
      async create(token) {
        access.set(token.id, { ...token });
        accessByHash.set(token.hash, token.id);
      },
      async get(id) {
        return copy(access.get(id));
      },
      async getByHash(hash) {
        const id = accessByHash.get(hash);
        return id ? copy(access.get(id)) : null;
      },
      async listByOwner(ownerId) {
        return [...access.values()].filter((row) => row.ownerId === ownerId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((row) => ({ ...row }));
      },
      async touch(id, usedAt) {
        const row = access.get(id);
        if (row) row.lastUsedAt = usedAt;
      },
      async revoke(id) {
        const row = access.get(id);
        if (!row || row.revoked) return false;
        row.revoked = true;
        return true;
      },
    },
    async prune(now) {
      for (const [hash, row] of codes) if (row.expiresAt < now) codes.delete(hash);
      for (const [hash, row] of refresh) if (row.expiresAt < now) refresh.delete(hash);
    },
  };
}
