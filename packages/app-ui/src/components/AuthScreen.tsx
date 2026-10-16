import { requireClient } from '../client';
import { useState, type FormEvent, type JSX } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { unwrap, userMessage } from '../client';

interface AuthScreenProps {
  onAuthenticated(): void;
  allowRegistration?: boolean;
  onDisconnect?(): void;
}

export function AuthScreen({
  onAuthenticated,
  allowRegistration = true,
  onDisconnect,
}: AuthScreenProps): JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const switchMode = (nextMode: 'login' | 'register') => {
    setMode(nextMode);
    setPassword('');
    setConfirmation('');
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const client = requireClient();
    if (!client) {
      setError('当前地址是 Electron 调试页面；浏览器请打开 Runtime Web 地址（默认端口 4317）。');
      return;
    }
    if (mode === 'register' && password !== confirmation) {
      setError('两次输入的密码不一致。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        unwrap(
          await client.register({
            loginName,
            password,
          }),
        );
      } else {
        unwrap(await client.login({ loginName, password }));
      }
      setPassword('');
      setConfirmation('');
      onAuthenticated();
    } catch (submitError) {
      setError(userMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-screen">
      <div className="auth-drag-region" aria-hidden="true" />
      <section className="auth-card" aria-label={mode === 'register' ? '创建账号' : '登录'}>
        {onDisconnect && (
          <button
            type="button"
            className="auth-back"
            aria-label="返回服务器连接"
            title="返回服务器连接"
            disabled={busy}
            onClick={onDisconnect}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        )}
        <div className="auth-brand" aria-label="Agent Harness">
          <span className="auth-brand-mark" aria-hidden="true">
            ✦
          </span>
          <span>Agent Harness</span>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>账号</span>
            <input
              autoComplete="username"
              required
              minLength={3}
              maxLength={64}
              placeholder={mode === 'login' ? '请输入账号' : '设置账号名'}
              value={loginName}
              onChange={(event) => setLoginName(event.target.value)}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'register' ? 6 : 1}
              maxLength={1024}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {mode === 'register' && (
            <label>
              <span>确认密码</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                maxLength={1024}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
          )}
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <div className="auth-actions">
            {allowRegistration && (
              <button
                className="auth-switch"
                type="button"
                onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
              >
                {mode === 'login' ? '还没有账号？创建账号' : '已有账号？返回登录'}
              </button>
            )}
            <button className="auth-submit" disabled={busy} type="submit">
              {busy && <Loader2 className="spin" size={16} />}
              {mode === 'register' ? '创建账号' : '登录'}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
