'use client';
// Headless consent flow. The host renders its own login and layout; this hook loads what the
// agent is asking for, tracks the user's scope choices and posts the decision.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

export interface ConsentClient {
  clientId: string;
  clientName: string;
  redirectHosts: string[];
  scopes: string[];
  scopesSupported: string[];
  scopeDetails: { name: string; description: string; required: boolean; default: boolean }[];
}

export interface UseAgentConsentOptions {
  /** Same `basePath` the server was created with. */
  basePath: string;
  /** Headers proving who is signed in (e.g. `Authorization: Bearer <host JWT>`); read at approve time. */
  authHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Defaults to `window.location.search`. */
  search?: string;
  fetcher?: typeof fetch;
}

const subscribeNever = () => () => {};

export function useAgentConsent(options: UseAgentConsentOptions) {
  const { basePath, authHeaders, fetcher } = options;
  // The query string is a client-only value; the server snapshot is null so hydration matches.
  const search = useSyncExternalStore(
    subscribeNever,
    () => options.search ?? window.location.search,
    () => options.search ?? null,
  );
  const params = useMemo(() => (search === null ? null : new URLSearchParams(search)), [search]);
  const [client, setClient] = useState<ConsentClient | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [redirect, setRedirect] = useState('');
  const doFetch = useMemo(() => fetcher ?? globalThis.fetch.bind(globalThis), [fetcher]);

  useEffect(() => {
    const clientId = params?.get('client_id') || '';
    if (!clientId) return;
    let cancelled = false;
    void doFetch(basePath + '/oauth/client?' + new URLSearchParams({ client_id: clientId, scope: params?.get('scope') || '' }))
      .then(async (response) => {
        const data = (await response.json()) as ConsentClient & { error?: string; error_description?: string };
        if (!response.ok) throw new Error(data.error_description || data.error || 'Unknown client');
        if (cancelled) return;
        setClient(data);
        setChosen(data.scopeDetails.filter((s) => s.default).map((s) => s.name));
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [basePath, params, doFetch]);

  const destination = useMemo(() => {
    try {
      const url = new URL(params?.get('redirect_uri') || '');
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : url.protocol.replace(/:$/, '://');
    } catch {
      return '';
    }
  }, [params]);

  const toggle = useCallback((scope: string, on: boolean) => {
    setChosen((current) => (on ? [...new Set([...current, scope])] : current.filter((s) => s !== scope)));
  }, []);

  const decide = useCallback(
    async (decision: 'approve' | 'deny') => {
      if (!params) return;
      setBusy(true);
      setError('');
      try {
        const headers = { 'content-type': 'application/json', ...(await authHeaders?.()) };
        const body = { ...Object.fromEntries(params.entries()), decision, scopes: chosen };
        const response = await doFetch(basePath + '/oauth/approve', { method: 'POST', headers, body: JSON.stringify(body) });
        const data = (await response.json()) as { redirect?: string; error?: string; error_description?: string };
        if (!response.ok || !data.redirect) throw new Error(data.error_description || data.error || 'Authorization failed');
        setRedirect(data.redirect);
        window.location.href = data.redirect;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Authorization failed');
      } finally {
        setBusy(false);
      }
    },
    [params, chosen, basePath, authHeaders, doFetch],
  );

  return { params, client, chosen, toggle, decide, error, setError, busy, redirect, destination, missingClient: params !== null && !params.get('client_id') };
}
