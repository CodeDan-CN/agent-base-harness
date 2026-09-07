import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import type {
  BootstrapResult,
  InboxItem,
  ModelManagementSnapshot,
  PermissionPreset,
  RuntimeProjection,
  RuntimeWorkerStatus,
  Session,
} from '@client-contracts';
import { ClientApiError, command, query, requireClient, userMessage } from './client';
import { ChatArea } from './components/ChatArea';
import { AuthScreen } from './components/AuthScreen';
import { ConfirmDialog, TextPromptDialog } from './components/Dialogs';
import { SettingsModal } from './components/SettingsModal';
import { Sidebar } from './components/Sidebar';
import { hasAcknowledgedFullAccess, rememberFullAccessAcknowledgement } from './permission-consent';
import { applyEventBatch, hydrateProjection } from './projection';
import { deriveInputSubmissionPolicy, shouldRefreshSessionList } from './runtime-wiring-policy';
import {
  applyTheme,
  persistThemePreference,
  readThemePreference,
  type ThemePreference,
} from './theme';
import type { BannerState, SessionSnapshotPayload } from './types';

export function App(): JSX.Element {
  const [authentication, setAuthentication] = useState<'checking' | 'required' | 'ready'>(
    'checking',
  );

  useEffect(() => {
    const client = window.agentClient;
    if (!client) {
      setAuthentication('required');
      return;
    }
    void client
      .currentAuth()
      .then((envelope) => setAuthentication(envelope.ok ? 'ready' : 'required'))
      .catch(() => setAuthentication('required'));
  }, []);

  if (authentication === 'checking') {
    return (
      <div className="boot-screen">
        <Loader2 className="spin" />
        <strong>正在连接本机 Runtime...</strong>
      </div>
    );
  }
  if (authentication === 'required') {
    return <AuthScreen onAuthenticated={() => setAuthentication('ready')} />;
  }
  return <RuntimeApp onAuthenticationRequired={() => setAuthentication('required')} />;
}

function RuntimeApp({
  onAuthenticationRequired,
}: {
  onAuthenticationRequired(): void;
}): JSX.Element {
  const [bootstrap, setBootstrap] = useState<BootstrapResult | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [projection, setProjection] = useState<RuntimeProjection | null>(null);
  const [modelSnapshot, setModelSnapshot] = useState<ModelManagementSnapshot | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeWorkerStatus>('starting');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Session | null>(null);
  const [queueEditTarget, setQueueEditTarget] = useState<InboxItem | null>(null);
  const [queueEditContent, setQueueEditContent] = useState('');
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [pendingPermissionPreset, setPendingPermissionPreset] = useState<PermissionPreset | null>(
    null,
  );
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [retryingRuntime, setRetryingRuntime] = useState(false);
  const cursorRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  const userEpochRef = useRef(0);
  const initializeRef = useRef<Promise<void> | null>(null);
  const retryingRuntimeRef = useRef(false);

  const notify = useCallback((message: string, tone: BannerState['tone'] = 'info') => {
    setBanner({ message, tone });
  }, []);

  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), banner.tone === 'error' ? 6500 : 3500);
    return () => window.clearTimeout(timer);
  }, [banner]);

  useEffect(() => {
    persistThemePreference(themePreference);
    applyTheme(themePreference);
    if (themePreference !== 'system') return;

    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const syncSystemTheme = () => applyTheme('system');
    systemTheme.addEventListener('change', syncSystemTheme);
    return () => systemTheme.removeEventListener('change', syncSystemTheme);
  }, [themePreference]);

  const loadSessions = useCallback(async (preferred?: string | null) => {
    const next = await query<Session[]>('session.list');
    setSessions(next);
    const active = next.filter((session) => session.status === 'active');
    const target =
      preferred && active.some((session) => session.id === preferred)
        ? preferred
        : (active[0]?.id ?? null);
    setActiveSessionId(target);
    return target;
  }, []);

  const loadModelSnapshot = useCallback(async () => {
    try {
      setModelSnapshot(await query<ModelManagementSnapshot>('model-management.snapshot'));
    } catch {
      setModelSnapshot(null);
    }
  }, []);

  const applyBootstrap = useCallback(
    async (boot: BootstrapResult) => {
      setBootstrap(boot);
      setRuntimeStatus(boot.runtime.status);
      setBootError(null);
      const target = await loadSessions(activeSessionId);
      await loadModelSnapshot();
      if (!target) setProjection(null);
      document.documentElement.dataset.smoke = 'ok';
    },
    [activeSessionId, loadModelSnapshot, loadSessions],
  );

  const initialize = useCallback((): Promise<void> => {
    if (initializeRef.current) return initializeRef.current;
    setLoading(true);
    const task = (async () => {
      try {
        const boot = await query<BootstrapResult>('app.bootstrap');
        await applyBootstrap(boot);
      } catch (error) {
        document.documentElement.dataset.smoke = 'error';
        if (error instanceof ClientApiError && error.code === 'AUTHENTICATION_REQUIRED') {
          onAuthenticationRequired();
          return;
        }
        if (error instanceof ClientApiError && error.code === 'RUNTIME_NOT_READY') return;
        const message = userMessage(error);
        setBootError(message);
        if (error instanceof ClientApiError && error.code === 'RUNTIME_UNAVAILABLE') {
          setRuntimeStatus('failed');
        }
        notify(message, 'error');
      } finally {
        setLoading(false);
      }
    })();
    initializeRef.current = task;
    void task.finally(() => {
      if (initializeRef.current === task) initializeRef.current = null;
    });
    return task;
  }, [applyBootstrap, notify, onAuthenticationRequired]);

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    let current = true;
    const epoch = userEpochRef.current;
    const client = window.agentClient;
    if (!client) return;
    const unsubscribe = client.subscribeLifecycle((event) => {
      if (!current || epoch !== userEpochRef.current) return;
      if (event.type === 'runtime') {
        setRuntimeStatus(event.status);
        if (event.status === 'ready') {
          if (!bootstrap && !retryingRuntimeRef.current) {
            void initialize();
          } else {
            void Promise.all([loadSessions(sessionRef.current), loadModelSnapshot()]).catch(
              (error) => notify(userMessage(error), 'error'),
            );
          }
        } else if (event.status === 'failed') {
          setBootError('后台运行服务未能启动，请重试。');
        }
      }
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [bootstrap, initialize, loadModelSnapshot, loadSessions, notify]);

  const retryRuntime = useCallback(async () => {
    retryingRuntimeRef.current = true;
    setRetryingRuntime(true);
    setBootError(null);
    setRuntimeStatus('starting');
    try {
      // Runtime is an independent service. Main reconnects/restarts it from
      // the lifecycle probe; reloading lets the auth/bootstrap flow run again
      // without exposing a legacy runtime.retry command through Gateway.
      window.location.reload();
    } catch (error) {
      const message = userMessage(error);
      setRuntimeStatus('failed');
      setBootError(message);
      notify(message, 'error');
    } finally {
      retryingRuntimeRef.current = false;
      setRetryingRuntime(false);
    }
  }, [applyBootstrap, notify]);

  const loadSnapshot = useCallback(
    async (sessionId: string) => {
      setLoading(true);
      try {
        const snapshot = await query<SessionSnapshotPayload>('session.snapshot', { sessionId });
        if (sessionRef.current !== sessionId) return;
        cursorRef.current = snapshot.throughSeq;
        setProjection(hydrateProjection(snapshot));
        setSessions((items) =>
          items.map((item) => (item.id === sessionId ? snapshot.session : item)),
        );
      } catch (error) {
        notify(userMessage(error), 'error');
      } finally {
        if (sessionRef.current === sessionId) setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    sessionRef.current = activeSessionId;
    cursorRef.current = 0;
    setProjection(null);
    if (activeSessionId) void loadSnapshot(activeSessionId);
    else setLoading(false);
  }, [activeSessionId, loadSnapshot]);

  useEffect(() => {
    if (!activeSessionId || !projection || runtimeStatus !== 'ready') return;
    const sessionId = activeSessionId;
    const unsubscribe = requireClient().subscribeSession(sessionId, cursorRef.current, (event) => {
      if (sessionRef.current !== sessionId) return;
      if (event.type === 'resync-required' || event.fromSeq !== cursorRef.current + 1) {
        setProjection(null);
        void loadSnapshot(sessionId);
        return;
      }
      cursorRef.current = event.toSeq;
      setProjection((current) => (current ? applyEventBatch(current, event.events) : current));
      if (shouldRefreshSessionList(event.events)) {
        void loadSessions(sessionId).catch(() => undefined);
      }
    });
    return unsubscribe;
  }, [activeSessionId, Boolean(projection), loadSessions, loadSnapshot, runtimeStatus]);

  const createSession = useCallback(async (): Promise<Session | null> => {
    try {
      const session = await command<Session>('session.create', {
        sessionId: crypto.randomUUID(),
        title: '新对话',
      });
      setSessions((items) => [session, ...items]);
      setActiveSessionId(session.id);
      return session;
    } catch (error) {
      notify(userMessage(error), 'error');
      return null;
    }
  }, [notify]);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const activeModel = useMemo(
    () => modelSnapshot?.models.find((item) => item.id === modelSnapshot.defaultModelId) ?? null,
    [modelSnapshot],
  );
  const modelLabel = useMemo(() => {
    return activeModel?.displayName ?? '未配置模型';
  }, [activeModel]);
  const modelContextLimit = useMemo(() => {
    const contextWindow = activeModel?.contextWindow;
    if (!contextWindow) return null;
    return Math.min(contextWindow, activeModel.inputCapability ?? Number.POSITIVE_INFINITY);
  }, [activeModel]);

  const send = async (content: string, mode: 'queue' | 'steer'): Promise<boolean> => {
    let sessionId = activeSessionId;
    if (!sessionId) sessionId = (await createSession())?.id ?? null;
    if (!sessionId) return false;
    try {
      const policy = deriveInputSubmissionPolicy(mode, Boolean(projection?.activeTurn));
      await command('input.submit', {
        sessionId,
        content,
        idempotencyKey: crypto.randomUUID(),
        ...policy,
      });
      return true;
    } catch (error) {
      notify(userMessage(error), 'error');
      return false;
    }
  };

  const withInbox = async (
    item: InboxItem,
    method: 'inbox.remove' | 'inbox.replace' | 'inbox.promote',
    extra: Record<string, unknown> = {},
  ) => {
    if (!activeSessionId) return;
    setBusyActionId(item.id);
    try {
      await command(method, { sessionId: activeSessionId, inboxItemId: item.id, ...extra });
    } catch (error) {
      notify(userMessage(error), 'error');
    } finally {
      setBusyActionId(null);
    }
  };

  const changePermissionPreset = async (preset: PermissionPreset) => {
    if (!activeSessionId) return;
    setPermissionBusy(true);
    try {
      await command('permission.preset.set', { sessionId: activeSessionId, preset });
      if (preset === 'full-access' && bootstrap?.activeUser.id) {
        rememberFullAccessAcknowledgement(bootstrap.activeUser.id);
      }
      await loadSessions(activeSessionId);
      notify(
        preset === 'approval-required'
          ? '已切换为请求批准。'
          : preset === 'guarded'
            ? '已切换为受控自动。'
            : '已开启完全访问。',
        'success',
      );
    } catch (error) {
      notify(userMessage(error), 'error');
    } finally {
      setPermissionBusy(false);
      setPendingPermissionPreset(null);
    }
  };

  const openRename = (session = activeSession) => {
    if (!session) return;
    setRenameTarget(session);
    setRenameTitle(session.title);
  };

  const rename = async () => {
    if (!renameTarget) return;
    const title = renameTitle.trim();
    if (!title || title.length > 200) return;
    if (title === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    setRenaming(true);
    try {
      const latestSessions = await query<Session[]>('session.list');
      const latest = latestSessions.find((session) => session.id === renameTarget.id);
      if (!latest) throw new ClientApiError('INVALID_REQUEST', '会话不存在或已归档');
      await command('session.rename', {
        sessionId: renameTarget.id,
        title,
        expectedVersion: latest.version,
      });
      await loadSessions(renameTarget.id);
      setRenameTarget(null);
      notify('会话名称已更新。', 'success');
    } catch (error) {
      notify(userMessage(error), 'error');
    } finally {
      setRenaming(false);
    }
  };

  const logout = () => {
    setLoggingOut(true);
    setProjection(null);
    void requireClient()
      .logout()
      .then((envelope) => {
        if (!envelope.ok) {
          throw new ClientApiError(envelope.error.code, envelope.error.message);
        }
        userEpochRef.current += 1;
        setActiveSessionId(null);
        onAuthenticationRequired();
      })
      .catch((error) => notify(userMessage(error), 'error'))
      .finally(() => setLoggingOut(false));
  };

  if (!bootstrap) {
    const failed = runtimeStatus === 'failed';
    return (
      <div className="boot-screen">
        <div className="boot-logo">✦</div>
        {failed ? <AlertCircle className="boot-error-icon" /> : <Loader2 className="spin" />}
        <strong>{failed ? '智能体客户端启动失败' : '正在启动智能体客户端...'}</strong>
        {failed && <p>{bootError ?? '后台运行服务未能启动，请重试。'}</p>}
        {failed && (
          <button
            className="boot-retry"
            disabled={retryingRuntime}
            onClick={() => void retryRuntime()}
          >
            {retryingRuntime && <Loader2 className="spin" size={14} />}
            {retryingRuntime ? '正在重试...' : '重新启动'}
          </button>
        )}
        {!failed && banner && <p>{banner.message}</p>}
      </div>
    );
  }

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <Sidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          activeUser={bootstrap.activeUser}
          onSelectSession={setActiveSessionId}
          onNewSession={() => void createSession()}
          onRename={openRename}
          onArchive={setArchiveTarget}
          onToggle={() => setSidebarOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={logout}
        />
      )}
      <ChatArea
        sessionId={activeSessionId}
        title={activeSession?.title ?? '新对话'}
        modelLabel={modelLabel}
        modelContextLimit={modelContextLimit}
        sidebarOpen={sidebarOpen}
        loading={loading}
        runtimeReady={runtimeStatus === 'ready'}
        projection={projection}
        busyActionId={busyActionId}
        permissionPreset={activeSession?.permissionPreset ?? 'guarded'}
        onToggleSidebar={() => setSidebarOpen(true)}
        onRename={() => openRename()}
        onNotifyError={(message) => notify(message, 'error')}
        onSend={send}
        onStop={() => {
          const turn = projection?.activeTurn;
          if (!turn || !activeSessionId) return;
          void command('turn.cancel', {
            sessionId: activeSessionId,
            turnId: turn.id,
            keepNextTurn: true,
            keepNextStep: false,
            reason: 'user_cancelled',
          }).catch((error) => notify(userMessage(error), 'error'));
        }}
        onRemove={(item) => void withInbox(item, 'inbox.remove')}
        onReplace={(item) => {
          setQueueEditTarget(item);
          setQueueEditContent(item.content);
        }}
        onPromote={(item) => {
          const turnId = projection?.activeTurn?.id;
          if (turnId) void withInbox(item, 'inbox.promote', { expectedTurnId: turnId });
        }}
        onResolveInteraction={(interactionId, value, resolution = 'submitted') => {
          if (!activeSessionId) return;
          void command('interaction.resolve', {
            sessionId: activeSessionId,
            interactionId,
            value,
            resolution,
            idempotencyKey: crypto.randomUUID(),
          }).catch((error) => notify(userMessage(error), 'error'));
        }}
        onResolveApproval={(approvalId, resolution) => {
          if (!activeSessionId) return;
          void command('approval.resolve', {
            sessionId: activeSessionId,
            approvalId,
            resolution,
            idempotencyKey: crypto.randomUUID(),
          }).catch((error) => notify(userMessage(error), 'error'));
        }}
        onPermissionPresetChange={(preset) => {
          if (preset === activeSession?.permissionPreset) return;
          if (
            preset === 'full-access' &&
            (!bootstrap?.activeUser.id || !hasAcknowledgedFullAccess(bootstrap.activeUser.id))
          ) {
            setPendingPermissionPreset(preset);
            return;
          }
          void changePermissionPreset(preset);
        }}
      />
      {banner && <Banner banner={banner} onClose={() => setBanner(null)} />}
      {loggingOut && (
        <div className="switch-overlay">
          <Loader2 className="spin" /> 正在退出登录...
        </div>
      )}
      {settingsOpen && (
        <SettingsModal
          themePreference={themePreference}
          onThemePreferenceChange={setThemePreference}
          onClose={() => setSettingsOpen(false)}
          onModelChanged={setModelSnapshot}
          onNotify={(message, tone = 'info') => notify(message, tone)}
        />
      )}
      {renameTarget && (
        <RenameSessionDialog
          title={renameTitle}
          busy={renaming}
          onTitleChange={setRenameTitle}
          onCancel={() => !renaming && setRenameTarget(null)}
          onSave={() => void rename()}
        />
      )}
      <ConfirmDialog
        open={pendingPermissionPreset === 'full-access'}
        title="开启完全访问？"
        description="Agent 将自主采用合理默认值，并能以当前登录用户权限访问工作区外文件。只有缺少不可推断且任务必需的事实时才会询问；密码、验证码和 API Key 等秘密应通过专用安全入口提供。此本地用户只需确认一次。"
        acknowledgementLabel="我理解这可能修改工作区外的文件"
        confirmLabel="开启完全访问"
        tone="warning"
        busy={permissionBusy}
        onCancel={() => !permissionBusy && setPendingPermissionPreset(null)}
        onConfirm={() => void changePermissionPreset('full-access')}
      />
      <ConfirmDialog
        open={Boolean(archiveTarget)}
        title="归档这段对话？"
        description={
          archiveTarget ? `“${archiveTarget.title}”会从会话列表中移除，但历史记录仍会保留。` : ''
        }
        confirmLabel="归档"
        tone="danger"
        onCancel={() => setArchiveTarget(null)}
        onConfirm={() => {
          const target = archiveTarget;
          if (!target) return;
          setArchiveTarget(null);
          void command('session.archive', { sessionId: target.id })
            .then(() => loadSessions(null))
            .catch((error) => notify(userMessage(error), 'error'));
        }}
      />
      <TextPromptDialog
        open={Boolean(queueEditTarget)}
        title="修改排队消息"
        description="修改后仍会保留原来的队列位置和执行范围。"
        label="消息内容"
        value={queueEditContent}
        multiline
        onChange={setQueueEditContent}
        onCancel={() => setQueueEditTarget(null)}
        onConfirm={() => {
          const target = queueEditTarget;
          const content = queueEditContent.trim();
          setQueueEditTarget(null);
          if (target && content && content !== target.content) {
            void withInbox(target, 'inbox.replace', { content });
          }
        }}
      />
    </div>
  );
}

function RenameSessionDialog(props: {
  title: string;
  busy: boolean;
  onTitleChange(value: string): void;
  onCancel(): void;
  onSave(): void;
}): JSX.Element {
  const valid = props.title.trim().length > 0 && props.title.trim().length <= 200;
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && props.onCancel()}
    >
      <form
        className="rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !props.busy) props.onSave();
        }}
      >
        <div className="rename-dialog-heading">
          <div>
            <h2 id="rename-dialog-title">重命名会话</h2>
            <p>新名称会同步显示在侧栏、对话顶部和调用统计中。</p>
          </div>
          <button type="button" className="icon-button" onClick={props.onCancel} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <label>
          <span>会话名称</span>
          <input
            autoFocus
            maxLength={200}
            value={props.title}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => props.onTitleChange(event.target.value)}
            aria-label="会话名称"
          />
          <small>{props.title.trim().length}/200</small>
        </label>
        <div className="rename-dialog-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            取消
          </button>
          <button type="submit" className="dark-button" disabled={!valid || props.busy}>
            {props.busy && <Loader2 className="spin" size={14} />}
            {props.busy ? '保存中...' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Banner({ banner, onClose }: { banner: BannerState; onClose(): void }): JSX.Element {
  const Icon =
    banner.tone === 'success' ? CheckCircle2 : banner.tone === 'error' ? AlertCircle : Info;
  return (
    <div className={`banner ${banner.tone}`} role="status">
      <Icon size={17} />
      <span>{banner.message}</span>
      <button onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}
