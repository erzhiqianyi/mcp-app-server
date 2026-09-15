'use client';
// Minimal consent page. Mount it at `consentPath` on `webOrigin` (default /oauth/authorize).
// The gateway redirects the user here with the OAuth query string intact; the hook does the rest.
import { useAgentConsent } from '@erzhiqian/agent-gateway/react';

export default function ConsentPage({ sessionToken }: { sessionToken: string | null }) {
  const { client, chosen, toggle, decide, error, busy, destination, missingClient } = useAgentConsent({
    basePath: '/api/notes',
    // Whatever proves the user is signed in to *your* app. Omit if your session is a cookie.
    authHeaders: () => (sessionToken ? { authorization: 'Bearer ' + sessionToken } : {}),
  });

  if (missingClient) return <p>Open this page from an AI agent that wants to connect.</p>;
  if (!client) return <p>{error || 'Loading…'}</p>;

  return (
    <form onSubmit={(e) => { e.preventDefault(); void decide('approve'); }}>
      <h1>{client.clientName} wants to access your notes</h1>
      <p>After approval you will be sent back to {destination}.</p>
      {client.scopeDetails.map((scope) => (
        <label key={scope.name} style={{ display: 'block' }}>
          <input type="checkbox" checked={chosen.includes(scope.name)} disabled={scope.required || busy} onChange={(e) => toggle(scope.name, e.target.checked)} />
          {scope.description}
        </label>
      ))}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>Allow</button>
      <button type="button" disabled={busy} onClick={() => void decide('deny')}>Deny</button>
    </form>
  );
}
