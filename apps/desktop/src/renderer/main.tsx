import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, ArrowRight, BookOpen, Globe2, Loader2, Server } from 'lucide-react';
import { App } from '../../../../packages/app-ui/src/App';
import { initializeTheme } from '../../../../packages/app-ui/src/theme';
import '../../../../packages/app-ui/src/styles.css';
import './connection.css';
import { configureClient, unwrap } from '../../../../packages/app-ui/src/client';
import type { RpcEnvelope } from '@client-contracts';

declare global {
  interface Window {
    agentConnection: {
      get(): Promise<RpcEnvelope>;
      set(baseUrl: string): Promise<RpcEnvelope>;
    };
  }
}

if (!window.agentClient) throw new Error('Desktop preload unavailable');
configureClient(window.agentClient);

function DesktopApp() {
  const [baseUrl, setBaseUrl] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void window.agentConnection
      .get()
      .then((result) => {
        setBaseUrl(unwrap<{ baseUrl: string }>(result).baseUrl);
      })
      .catch((error: unknown) => setError(String(error)));
  }, []);
  if (connected) return <App onDisconnect={() => setConnected(false)} />;
  return (
    <main className="connection-screen">
      <div className="auth-drag-region" aria-hidden="true" />
      <div className="connection-content">
        <div className="connection-brand">
          <BookOpen size={22} strokeWidth={1.8} aria-hidden="true" />
          <span>Agent Harness</span>
        </div>
        <section className="connection-card" aria-labelledby="connection-title">
          <div className="connection-symbol" aria-hidden="true">
            <Server size={26} strokeWidth={1.6} />
          </div>
          <h1 id="connection-title">连接你的工作空间</h1>
          <p className="connection-description">连接服务器，继续与你的智能体协作。</p>
          <form
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              setBusy(true);
              setError('');
              void window.agentConnection
                .set(baseUrl.trim())
                .then((result) => {
                  unwrap(result);
                  setConnected(true);
                })
                .catch((error: unknown) =>
                  setError(error instanceof Error ? error.message : String(error)),
                )
                .finally(() => setBusy(false));
            }}
          >
            <label htmlFor="server-url">服务器地址</label>
            <div className="connection-input">
              <Globe2 size={18} aria-hidden="true" />
              <input
                id="server-url"
                type="url"
                required
                disabled={busy}
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="url"
                aria-describedby={error ? 'connection-hint connection-error' : 'connection-hint'}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setError('');
                }}
                placeholder="https://agent.example.com"
              />
            </div>
            <p className="connection-hint" id="connection-hint">
              填写本地或远程服务器的完整地址
            </p>
            {error && (
              <div className="connection-error" id="connection-error" role="alert">
                <AlertCircle size={17} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}
            <button className="connection-submit" disabled={busy || !baseUrl.trim()} type="submit">
              {busy ? <Loader2 className="spin" size={18} aria-hidden="true" /> : null}
              {busy ? '正在连接…' : '连接服务器'}
              {!busy && <ArrowRight size={18} aria-hidden="true" />}
            </button>
          </form>
        </section>
        <p className="connection-footer">好的创意，值得一群人一起实现。</p>
      </div>
    </main>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('root element missing');
}
document.documentElement.dataset.client = 'electron';
initializeTheme();
createRoot(container).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);
