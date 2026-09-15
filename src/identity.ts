// Ready-made IdentityProviders. Each answers one question on the consent page: who is signed in?
import type { Identity, IdentityProvider } from './types.js';
import { AppServerError } from './types.js';

function bearer(request: Request) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!header.startsWith('Bearer ') || !token) throw new AppServerError(401, 'Sign in first');
  return token;
}

export interface JwtIdentityOptions {
  /** JWKS endpoint of the issuer (any OIDC provider publishes one). */
  jwksUrl: string;
  issuer: string;
  audience: string;
  /** Claim that carries the stable user id. Default `sub`. */
  subjectClaim?: string;
  algorithms?: string[];
  /** Extra checks on the verified payload; throw AppServerError to reject. */
  assert?: (payload: Record<string, unknown>) => void;
}

/**
 * The host front end holds a JWT for the signed-in user (Firebase, Supabase, Auth0, Clerk, Cognito…)
 * and sends it as `Authorization: Bearer` when approving. Requires the optional `jose` peer dependency.
 */
export function jwtIdentity(options: JwtIdentityOptions): IdentityProvider {
  let keys: unknown;
  return {
    async resolve(request) {
      const token = bearer(request);
      const jose = await import('jose');
      keys ??= jose.createRemoteJWKSet(new URL(options.jwksUrl));
      let payload: Record<string, unknown>;
      try {
        payload = (await jose.jwtVerify(token, keys as Parameters<typeof jose.jwtVerify>[1], { issuer: options.issuer, audience: options.audience, algorithms: options.algorithms ?? ['RS256'] })).payload;
      } catch {
        throw new AppServerError(401, 'Sign-in expired; sign in again');
      }
      options.assert?.(payload);
      const id = payload[options.subjectClaim ?? 'sub'];
      if (typeof id !== 'string' || !id) throw new AppServerError(401, 'Token missing subject');
      return { id, email: typeof payload.email === 'string' ? payload.email : undefined, displayName: typeof payload.name === 'string' ? payload.name : undefined };
    },
  };
}

/** Firebase Authentication preset over jwtIdentity. */
export function firebaseIdentity(projectId: string, options: Pick<JwtIdentityOptions, 'assert'> = {}): IdentityProvider {
  return jwtIdentity({
    jwksUrl: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    ...options,
  });
}

/**
 * The host keeps a server-side session (cookie, framework session store). Supply the lookup;
 * return null when nobody is signed in.
 */
export function sessionIdentity(lookup: (request: Request) => Promise<Identity | null>): IdentityProvider {
  return {
    async resolve(request) {
      const identity = await lookup(request);
      if (!identity) throw new AppServerError(401, 'Sign in first');
      return identity;
    },
  };
}

/** Single-user / local development: every consent is attributed to one fixed id. Never use behind a public origin. */
export function fixedIdentity(id: string, displayName = 'Local workspace'): IdentityProvider {
  return { resolve: async () => ({ id, displayName }) };
}
