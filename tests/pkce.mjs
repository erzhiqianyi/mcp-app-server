import { createHash, randomBytes } from 'node:crypto';

/** PKCE pair exactly as an MCP client generates it. */
export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
