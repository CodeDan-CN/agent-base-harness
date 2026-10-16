import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowRight, Loader2, Server } from 'lucide-react';
import { App } from '@ui/App';
import { configureClient } from '@ui/client';
import { createMobileClient } from './mobile-client';
import { createNativeTransport } from './native-transport';
import '@ui/styles.css';
import './mobile.css';

function MobileRoot() {
  const native = window.HarnessNative;
  const [url, setUrl] = useState(() => localStorage.getItem('mobile-server-url') || '');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connection = useRef<ReturnType<typeof createMobileClient> | null>(null);
  useEffect(() => {
    const resize = () =>
      document.documentElement.style.setProperty(
        '--mobile-height',
        `${window.visualViewport?.height ?? window.innerHeight}px`,
      );
    resize();
    window.visualViewport?.addEventListener('resize', resize);
    return () => window.visualViewport?.removeEventListener('resize', resize);
  }, []);
  const connect = async () => {
    setBusy(true);
    setError('');
    let candidate: ReturnType<typeof createMobileClient> | undefined;
    try {
      let baseUrl = window.location.origin;
      if (native) {
        const result = JSON.parse(native.configure(url.trim())) as { url?: string; error?: string };
        if (!result.url) throw new Error(result.error || '服务器地址无效');
        baseUrl = result.url;
      }
      const fetcher = native ? createNativeTransport(native) : window.fetch.bind(window);
      const transport: typeof fetch = (input, init) =>
        fetcher(input, {
          ...init,
          signal: init?.signal ?? AbortSignal.timeout(15000),
        });
      candidate = createMobileClient(baseUrl, transport);
      const health = await candidate.health();
      if (health.protocolVersion !== 1) throw new Error('Runtime 协议版本不兼容，请更新服务器');
      configureClient(candidate.api);
      connection.current = candidate;
      if (native) localStorage.setItem('mobile-server-url', baseUrl);
      setReady(true);
    } catch (failure) {
      void candidate?.dispose();
      setError(failure instanceof Error ? failure.message : '连接失败');
    } finally {
      setBusy(false);
    }
  };
  const disconnect = () => {
    setReady(false);
    setBusy(true);
    const old = connection.current;
    connection.current = null;
    void (old?.dispose() ?? Promise.resolve()).finally(() => setBusy(false));
  };
  if (ready) return <App mobile onDisconnect={disconnect} />;
  return (
    <main className="mobile-connect">
      <div className="mobile-brand">
        ✦ <span>Agent Harness</span>
      </div>
      <section>
        <Server size={32} strokeWidth={1.4} />
        <h1>连接你的 Runtime</h1>
        <p>对话随身，任务留在服务器。</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          {native ? (
            <label>
              服务器地址
              <input
                type="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://agent.example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
          ) : (
            <p className="mobile-preview-note">
              手机界面开发预览 · 通过开发代理连接已运行的 Runtime，不会启动本地服务。
            </p>
          )}
          {error && (
            <p role="alert" className="mobile-error">
              {error}
            </p>
          )}
          <button className="mobile-connect-button" disabled={busy}>
            {busy ? <Loader2 className="spin" size={20} /> : <ArrowRight size={20} />}
            {busy ? '正在连接…' : '连接服务器'}
          </button>
        </form>
      </section>
      <footer>
        账号和密码摘要保存在本机，登录状态仅保留至断开连接。
        <br />
        可创建或登录本地账号。模型与工具请在 Web 或桌面端配置。
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<MobileRoot />);
