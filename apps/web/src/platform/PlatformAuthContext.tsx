import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import {
  platformClient,
  clearPlatformToken,
  getPlatformToken,
  setPlatformToken,
  setPlatformUnauthorizedHandler,
} from '../lib/platform-client';
import { PlatformAdmin } from '../lib/types';

type PlatformAuthStatus = 'loading' | 'authed' | 'anon';

interface PlatformAuthContextValue {
  admin: PlatformAdmin | null;
  status: PlatformAuthStatus;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

// Phase 1K-B (plan §5.3). A SECOND auth context, deliberately separate from the
// tenant AuthContext: its own token key (kd_platform_token via platform-client),
// its own 401 hook, its own login route. The two never share state, so a
// platform admin session can never be confused with a tenant-user session
// (CLAUDE.md §4 no-impersonation).
const PlatformAuthContext = createContext<PlatformAuthContextValue | null>(null);

export function PlatformAuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<PlatformAdmin | null>(null);
  const [status, setStatus] = useState<PlatformAuthStatus>(getPlatformToken() ? 'loading' : 'anon');

  function reset() {
    clearPlatformToken();
    setAdmin(null);
    setStatus('anon');
  }

  useEffect(() => {
    setPlatformUnauthorizedHandler(reset);
    return () => setPlatformUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!getPlatformToken()) return;
    platformClient
      .getMe()
      .then((me) => {
        setAdmin(me);
        setStatus('authed');
      })
      .catch(() => setStatus('anon'));
  }, []);

  async function login(email: string, password: string) {
    const { accessToken, admin: who } = await platformClient.login(email, password);
    setPlatformToken(accessToken);
    setAdmin({ id: who.id, email: who.email });
    setStatus('authed');
  }

  async function logout() {
    try {
      await platformClient.logout();
    } catch {
      // best-effort; clear local state regardless
    }
    reset();
  }

  return (
    <PlatformAuthContext.Provider value={{ admin, status, login, logout }}>
      {children}
    </PlatformAuthContext.Provider>
  );
}

export function usePlatformAuth(): PlatformAuthContextValue {
  const ctx = useContext(PlatformAuthContext);
  if (!ctx) throw new Error('usePlatformAuth must be used within PlatformAuthProvider');
  return ctx;
}
