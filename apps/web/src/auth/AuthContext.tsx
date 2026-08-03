import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import {
  apiClient,
  clearToken,
  getToken,
  setToken,
  setUnauthorizedHandler,
} from '../lib/api-client';
import { MeResponse } from '../lib/types';

type AuthStatus = 'loading' | 'authed' | 'anon';

interface AuthContextValue {
  user: MeResponse | null;
  status: AuthStatus;
  login: (email: string, password: string, tenantSlug: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (code: string) => boolean;
  hasAnyPermission: (codes: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [status, setStatus] = useState<AuthStatus>(getToken() ? 'loading' : 'anon');

  // Clears local session state. Registered as the client's 401 handler so an
  // expired token anywhere forces a return to the login screen.
  function reset() {
    clearToken();
    setUser(null);
    setStatus('anon');
  }

  useEffect(() => {
    setUnauthorizedHandler(reset);
    return () => setUnauthorizedHandler(null);
  }, []);

  // On mount with a stored token, validate it by fetching the current user.
  useEffect(() => {
    if (!getToken()) return;
    apiClient
      .getMe()
      .then((me) => {
        setUser(me);
        setStatus('authed');
      })
      .catch(() => {
        // 401 already cleared the token via the handler; ensure anon state.
        setStatus('anon');
      });
  }, []);

  async function login(email: string, password: string, tenantSlug: string) {
    const { accessToken } = await apiClient.login(email, password, tenantSlug);
    setToken(accessToken);
    const me = await apiClient.getMe();
    setUser(me);
    setStatus('authed');
  }

  async function logout() {
    try {
      await apiClient.logout();
    } catch {
      // Best-effort; clear local state regardless of server response.
    }
    reset();
  }

  const hasPermission = (code: string) => Boolean(user?.permissions[code]);
  const hasAnyPermission = (codes: string[]) => codes.some(hasPermission);

  return (
    <AuthContext.Provider value={{ user, status, login, logout, hasPermission, hasAnyPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
