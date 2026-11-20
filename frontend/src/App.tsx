import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Database, LockKeyhole, LogOut } from 'lucide-react';
import { api, ApiError, problemFromError } from './api';
import type { Problem, Session } from './api';
import { ErrorNotice } from './ErrorNotice';
import { HistoryInput } from './HistoryInput';
import { useI18n } from './i18n';
import { serverKey, useLoginHistory } from './loginHistory';
import { Workspace } from './Workspace';
import type { WorkspaceProblem } from './Workspace';

export function App() {
  const { language, setLanguage, t } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState<Problem | null>(null);
  const [workspaceProblem, setWorkspaceProblem] = useState<WorkspaceProblem | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    api<Session>('/session')
      .then((value) => { if (active) setSession(value); })
      .catch((error) => {
        if (active && !(error instanceof ApiError && error.status === 401)) {
          setAuthError(problemFromError(error));
        }
      })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  const sessionExpired = useCallback(() => {
    setAuthError({ code: 'session_expired' });
    setWorkspaceProblem(null);
    setSession(null);
  }, []);

  const updateWorkspaceProblem = useCallback((source: WorkspaceProblem['source'], problem: Problem | null, database?: string) => {
    setWorkspaceProblem((current) => problem ? { source, problem, database } : current?.source === source ? null : current);
  }, []);

  async function logOut() {
    setSigningOut(true);
    updateWorkspaceProblem('logout', null);
    try {
      await api<void>('/logout', { method: 'POST' });
      setWorkspaceProblem(null);
      setSession(null);
    } catch (error) {
      updateWorkspaceProblem('logout', problemFromError(error));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="app">
      <header className="title-bar">
        <div className="app-brand">
          <div className="app-icon"><Database size={17} aria-hidden="true" /></div>
          <div><strong>zpersist</strong><span title={session?.server}>{session?.server ?? t('sqlServer')}</span></div>
        </div>
        <div className="header-actions">
          <select className="language-select" aria-label={t('language')} value={language} onChange={(event) => setLanguage(event.target.value === 'th' ? 'th' : 'en')}>
            <option value="en" lang="en">EN</option>
            <option value="th" lang="th">TH</option>
          </select>
          {session && (
            <div className="account">
              <span className="account-name">{session.username}</span>
              <button className="button button-quiet" onClick={logOut} disabled={signingOut}>
                <LogOut size={16} aria-hidden="true" /> {t('signOut')}
              </button>
            </div>
          )}
        </div>
      </header>
      {checking ? (
        <main className="sign-in-shell"><p role="status">{t('checkingSession')}</p></main>
      ) : session ? (
        <Workspace issue={workspaceProblem} updateProblem={updateWorkspaceProblem} onSessionExpired={sessionExpired} />
      ) : (
        <SignIn initialError={authError} onSignedIn={(value) => { setAuthError(null); setWorkspaceProblem(null); setSession(value); }} />
      )}
    </div>
  );
}

function SignIn({ initialError, onSignedIn }: { initialError: Problem | null; onSignedIn: (session: Session) => void }) {
  const { t } = useI18n();
  const history = useLoginHistory();
  const [server, setServer] = useState('');
  const [port, setPort] = useState('1433');
  const [username, setUsername] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [trustServerCertificate, setTrustServerCertificate] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialError);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const portText = port.trim() || '1433';
    const portNumber = Number(portText);
    if (!/^\d+$/.test(portText) || portNumber < 1 || portNumber > 65535) {
      setError({ code: 'invalid_port' });
      return;
    }

    const form = new FormData(event.currentTarget);
    const endpoint = { ip: server.trim(), port: portNumber };
    setPending(true);
    setError(null);
    try {
      const session = await api<Session>('/login', {
        method: 'POST',
        body: {
          server: endpoint.ip,
          port: endpoint.port,
          username,
          password: form.get('password'),
          trust_server_certificate: trustServerCertificate,
        },
      });
      history.remember(endpoint, username);
      onSignedIn(session);
    } catch (failure) {
      const problem = problemFromError(failure);
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 503 || problem.code === 'database_unavailable')) {
        history.remember(endpoint, username);
      }
      setError(problem);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="sign-in-shell">
      <section className="sign-in-panel" aria-labelledby="sign-in-title">
        <div className="sign-in-heading">
          <div className="sign-in-icon"><LockKeyhole size={23} aria-hidden="true" /></div>
          <h1 id="sign-in-title">{t('signIn')}</h1>
        </div>
        <form onSubmit={signIn} noValidate>
          <div className="server-fields">
            <HistoryInput
              id="server"
              label={t('serverIp')}
              historyLabel={t('serverHistory')}
              placeholder="192.168.1.10"
              value={server}
              autoFocus
              options={history.servers.map((item) => ({
                key: serverKey(item),
                value: item.ip,
                port: item.port,
                label: `${item.ip.includes(':') ? `[${item.ip}]` : item.ip}:${item.port}`,
              }))}
              onChange={(value) => {
                setServer(value);
                setTrustServerCertificate(false);
              }}
              onSelect={(item) => {
                setServer(item.value);
                setPort(String(item.port));
                setTrustServerCertificate(false);
              }}
              onRemove={history.removeServer}
            />
            <div className="sign-in-field">
              <label htmlFor="port">{t('port')}</label>
              <input
                id="port" name="port" inputMode="numeric" placeholder="1433" maxLength={5} value={port}
                onChange={(event) => {
                  setPort(event.target.value);
                  setTrustServerCertificate(false);
                }}
              />
            </div>
          </div>
          <HistoryInput
            id="username"
            label={t('username')}
            historyLabel={t('usernameHistory')}
            value={username}
            options={history.usernames.map((name) => ({ key: name, value: name }))}
            onChange={setUsername}
            onSelect={(item) => setUsername(item.value)}
            onRemove={history.removeUsername}
          />
          <div className="sign-in-field">
            <label htmlFor="password">{t('password')}</label>
            <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required />
            <label className="sign-in-option">
              <input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} aria-controls="password" />
              {t('showPassword')}
            </label>
            <label className="sign-in-option" title={t('trustServerCertificateHint')}>
              <input type="checkbox" checked={trustServerCertificate} onChange={(event) => setTrustServerCertificate(event.target.checked)} />
              {t('trustServerCertificate')}
            </label>
          </div>
          {error && <ErrorNotice problem={error} />}
          <button type="submit" className="button button-primary" disabled={pending}>
            {t(pending ? 'signingIn' : 'signIn')}
          </button>
        </form>
      </section>
    </main>
  );
}
