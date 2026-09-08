import { cpSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, currentSchemaVersion } from '../infrastructure/sqlite/connection';
import { runMigrations } from '../infrastructure/sqlite/migration';
import { STAGE47_MIGRATIONS } from '../infrastructure/sqlite/schema';
import { SqliteRepositories } from '../infrastructure/sqlite/repositories';
import { ProcessRunner } from '../infrastructure/process/process-runner';
import { ShellExecutor } from '../infrastructure/process/shell-executor';
import type { BundledRuntimeSnapshot } from '../infrastructure/runtime/bundled-runtime-registry';
import { ScopedFileSystem } from '../infrastructure/filesystem/scoped-file-system';
import { ensureUserMemoryProfile } from '../infrastructure/workspace/session-workspace';
import { EnvironmentDetector } from '../infrastructure/process/environment-detector';
import { SkillCatalogService } from './skill-catalog-service';
import { SkillManagementService } from './skill-management-service';
import { parseSkillDirectory } from '../infrastructure/skills/parser';
import {
  BUILTIN_SKILL_CREATOR_NAME,
  GeneratedSkillPublisher,
} from '../infrastructure/skills/generated-skill-publisher';
import { FakeCredentialStore } from '../infrastructure/credential/fake-credential-store';
import { MacKeychainCredentialStore } from '../infrastructure/credential/mac-keychain-store';
import { OpenAiCompatibleAdapter } from '../infrastructure/llm/openai-compatible-adapter';
import {
  credentialRefOf,
  type CredentialScope,
  type CredentialStore,
} from '../infrastructure/credential/credential-store';
import { SystemClock, UuidIdProvider } from '../shared/domain/ports';
import type { Clock, IdProvider } from '../shared/domain/ports';
import { DEFAULT_USER_ID } from '../shared/domain/user';
import type { LocalUserId } from '../shared/domain/user';
import type { CapabilityCategoryType } from '../shared/domain/capability-category';
import { BridgeError } from '../shared/contracts/errors';
import type { BootstrapResult } from '../shared/contracts/bootstrap';
import type { HealthSnapshot, InterpreterHealth } from '../shared/contracts/health';
import type { SkillCatalogSnapshot } from '../shared/domain/skill';
import type { Model, ModelService } from '../shared/domain/model';
import type { Logger } from '../infrastructure/logging/logger';
import { LlmAdapterRegistry } from '../runtime/model';
import { ToolRegistry } from '../runtime/tools';
import { registerBuiltinRuntimeTools } from '../runtime/builtin-tools';
import { RuntimeService, type RuntimeServiceOptions } from '../runtime/runtime-service';
import { McpManager } from '../runtime/mcp/mcp-manager';
import { seedBundledMemoryServers } from '../runtime/mcp/bundled-memory';
import type { ModelSnapshot } from '../runtime/model';
import bundledCatalog from '../../resources/model-catalog.json';
import {
  matchModelCapability,
  validateCatalog,
  type CapabilityMatchKind,
  type ModelCatalog,
} from '../runtime/model-catalog';
import {
  applyThinkingSettings,
  getProviderPreset,
  inferProviderPresetFromEndpoint,
  normalizeReasoningEffort,
  supportedReasoningEffortsFor,
  validatePresetEndpoint,
} from '../runtime/provider-presets';
import type { SessionEventBatch } from '../shared/contracts/ipc';
import type {
  CredentialMutation,
  ModelDiscoveryResult,
  ModelManagementSnapshot,
  ModelSaveParams,
  ModelServiceSaveParams,
  ModelServiceTestParams,
  SkillManagementSnapshot,
  SkillDescriptionUpdateParams,
  McpManagementSnapshot,
  McpServerSaveParams,
  McpServerTestParams,
} from '../shared/contracts/management';
import type { McpServer, McpToolCatalogEntry } from '../shared/domain/mcp';
import type {
  ModelCallStatisticsParams,
  ModelCallStatisticsSnapshot,
} from '../shared/contracts/statistics';
import { buildModelCallStatistics } from './model-call-statistics';
import { AgentManagementService } from './agent-management-service';
import { AgentNavigationService } from './agent-navigation-service';
import { createAgentCallTool } from '../runtime/delegation/agent-call-tool';
import { createModelCapabilitySelector } from '../runtime/capability-selector';
import {
  maximumManualOutputBudget,
  recommendedOutputBudget,
} from '../client-contracts/model-output-policy';

export interface CreateWorkerAppDeps {
  appDataDir: string;
  generation: number;
  logger: Logger;
  clock?: Clock;
  idProvider?: IdProvider;
  credentialStore?: CredentialStore;
  env?: {
    nodePath?: string;
    pythonPaths?: string[];
    shellPath?: string;
  };
  runtime?: BundledRuntimeSnapshot;
  useSystemCredential?: boolean;
  llmAdapters?: LlmAdapterRegistry;
  tools?: ToolRegistry;
  runtimeOptions?: RuntimeServiceOptions;
  onEventsAppended?: (batch: SessionEventBatch) => void;
}

export interface WorkerApplication {
  readonly generation: number;
  readonly schemaVersion: number;
  readonly repos: SqliteRepositories;
  readonly credentialStore: CredentialStore;
  readonly processRunner: ProcessRunner;
  readonly detector: EnvironmentDetector;
  readonly logger: Logger;
  readonly appDataDir: string;
  readonly runtime: RuntimeService;
  readonly mcp: McpManager;
  readonly agentManagement: AgentManagementService;
  readonly agentNavigation: AgentNavigationService;
  initializeUser(userId: LocalUserId): Promise<void>;
  bootstrap(userId: LocalUserId): BootstrapResult;
  health(userId: LocalUserId): Promise<HealthSnapshot>;
  skillCatalog(userId: LocalUserId): SkillCatalogSnapshot;
  modelManagement(userId: LocalUserId): Promise<ModelManagementSnapshot>;
  modelCallStatistics(
    userId: LocalUserId,
    params: ModelCallStatisticsParams,
  ): ModelCallStatisticsSnapshot;
  saveModelService(userId: LocalUserId, input: ModelServiceSaveParams): Promise<{ id: string }>;
  testModelService(
    userId: LocalUserId,
    input: ModelServiceTestParams,
  ): Promise<{ status: 'success' | 'auth' | 'network' | 'timeout' | 'protocol' }>;
  archiveModelService(userId: LocalUserId, id: string, expectedRevision: number): { id: string };
  saveModel(userId: LocalUserId, input: ModelSaveParams): { id: string };
  archiveModel(userId: LocalUserId, id: string, expectedRevision: number): { id: string };
  setDefaultModel(
    userId: LocalUserId,
    modelId: string,
    expectedRevision: number,
  ): { modelId: string };
  discoverModels(userId: LocalUserId, serviceId: string): Promise<ModelDiscoveryResult>;
  skillManagement(userId: LocalUserId): SkillManagementSnapshot;
  updateSkillDescription(
    userId: LocalUserId,
    input: SkillDescriptionUpdateParams,
  ): { skillName: string };
  deleteSkill(
    userId: LocalUserId,
    skillName: string,
    expectedRevision: number,
  ): { skillName: string };
  setSkillEnabled(
    userId: LocalUserId,
    skillName: string,
    enabled: boolean,
    expectedRevision: number,
  ): { skillName: string; enabled: boolean };
  setSkillCategory(
    userId: LocalUserId,
    skillName: string,
    categoryId: string,
    expectedRevision: number,
  ): { skillName: string; categoryId: string };
  createCapabilityCategory(
    userId: LocalUserId,
    type: CapabilityCategoryType,
    name: string,
    expectedRevision: number,
  ): { id: string };
  renameCapabilityCategory(
    userId: LocalUserId,
    type: CapabilityCategoryType,
    id: string,
    name: string,
    expectedRevision: number,
  ): { id: string };
  deleteCapabilityCategory(
    userId: LocalUserId,
    type: CapabilityCategoryType,
    id: string,
    expectedRevision: number,
  ): { id: string };
  installSkillDirectory(userId: LocalUserId, sourcePath: string): { skillName: string };
  mcpManagement(userId: LocalUserId): Promise<McpManagementSnapshot>;
  saveMcpServer(userId: LocalUserId, input: McpServerSaveParams): Promise<{ id: string }>;
  testMcpServer(
    userId: LocalUserId,
    input: McpServerTestParams,
  ): Promise<{ status: 'success' | 'network' | 'protocol'; toolCount: number }>;
  archiveMcpServer(
    userId: LocalUserId,
    id: string,
    expectedRevision: number,
  ): Promise<{ id: string }>;
  refreshMcpServer(userId: LocalUserId, id: string): Promise<{ id: string; toolCount: number }>;
  setMcpToolEnabled(
    userId: LocalUserId,
    serverId: string,
    rawName: string,
    enabled: boolean,
    expectedRevision: number,
  ): { serverId: string; rawName: string; enabled: boolean };
  registerSecret(secret: string): void;
  close(): void;
}

export function createWorkerApplication(deps: CreateWorkerAppDeps): WorkerApplication {
  const clock = deps.clock ?? new SystemClock();
  const modelCatalog = validateCatalog(bundledCatalog);

  mkdirSync(path.join(deps.appDataDir, 'database'), { recursive: true });
  const dbPath = path.join(deps.appDataDir, 'database', 'app.db');
  const db = openDatabase(dbPath);

  let schemaVersion: number;
  try {
    schemaVersion = runMigrations(db, STAGE47_MIGRATIONS, { clock: () => clock.nowIso() });
  } catch (err) {
    try {
      db.close();
    } catch {
      // 关闭失败不掩盖原始迁移错误。
    }
    throw err;
  }

  const repos = new SqliteRepositories(db);
  repos.users.seedUsers(clock.nowIso());
  for (const user of repos.users.listUsers()) {
    repos.categories.ensureDefaults(user.id, 'skill', clock.nowIso());
    repos.categories.ensureDefaults(user.id, 'mcp', clock.nowIso());
    ensureUserMemoryProfile(deps.appDataDir, user.id);
  }
  seedBundledMemoryServers(repos, deps.runtime, clock.nowIso());
  const initialUserId = DEFAULT_USER_ID;

  const processRunner = new ProcessRunner({ allowedRoots: [deps.appDataDir, os.tmpdir()] });
  const detector = new EnvironmentDetector(
    processRunner,
    {
      ...deps.env,
      ...(deps.runtime
        ? {
            nodePath: deps.runtime.node.executable,
            nodeSource: 'bundled' as const,
            pythonPaths: [deps.runtime.python.executable],
            pythonSource: 'bundled' as const,
            allowSystemFallback: false,
          }
        : {}),
    },
    deps.appDataDir,
  );
  const fileSystem = new ScopedFileSystem(deps.appDataDir);
  const shell = new ShellExecutor(deps.appDataDir, processRunner, deps.runtime?.binDir);

  const logger = deps.logger.child({ workerGeneration: deps.generation });

  const credentialStore =
    deps.credentialStore ??
    (deps.useSystemCredential ? new MacKeychainCredentialStore() : new FakeCredentialStore());

  const skillRoot = (userId: LocalUserId) => path.join(deps.appDataDir, 'skills', userId);
  const skillCatalog = new SkillCatalogService({ repos, skillRoot, clock });
  const skillManagement = new SkillManagementService({
    repos,
    skillRoot,
    clock,
    appDataDir: deps.appDataDir,
  });
  const ids = deps.idProvider ?? new UuidIdProvider();
  const generatedSkills = new GeneratedSkillPublisher({
    appDataDir: deps.appDataDir,
    repos,
    clock,
    ids,
    skillRoot,
  });
  skillCatalog.refresh(initialUserId);
  generatedSkills.seedBuiltinCreator(repos.users.listUsers().map((user) => user.id));
  const agentManagement = new AgentManagementService({
    repos,
    appDataDir: deps.appDataDir,
    clock,
    ids,
  });
  const agentNavigation = new AgentNavigationService(repos);
  for (const user of repos.users.listUsers()) agentManagement.initializeUser(user.id);

  const llmAdapters = deps.llmAdapters ?? new LlmAdapterRegistry();
  if (!deps.llmAdapters) {
    llmAdapters.register(
      new OpenAiCompatibleAdapter({
        credentialStore,
        onCredentialLoaded: (secret) => logger.registerSecret(secret),
        logger: logger.child({ component: 'model-provider' }),
      }),
    );
  }
  const tools = deps.tools ?? new ToolRegistry();
  const resolveModel = (userId: LocalUserId, agentId: string) =>
    resolveRuntimeModel(repos, modelCatalog, userId, agentId);
  if (!deps.tools) {
    registerBuiltinRuntimeTools(tools, {
      appDataDir: deps.appDataDir,
      repos,
      fileSystem,
      shell,
      selectCapabilities: createModelCapabilitySelector({ llmAdapters, resolveModel, ids }),
      publishSkill: (userId, input) => generatedSkills.publish(userId, input),
    });
  }
  const runtime = new RuntimeService({
    appDataDir: deps.appDataDir,
    repos,
    clock,
    ids,
    logger,
    workerId: `worker-${deps.generation}`,
    llmAdapters,
    tools,
    resolveModel,
    options: deps.runtimeOptions,
    onEventsAppended: deps.onEventsAppended,
  });
  tools.register(createAgentCallTool((context, input) => runtime.delegateAgent(context, input)));
  const mcp = new McpManager({
    repos,
    tools,
    credentialStore,
    logger: logger.child({ component: 'mcp' }),
    clock,
    appDataDir: deps.appDataDir,
    runtime: deps.runtime,
  });

  const app: WorkerApplication = {
    generation: deps.generation,
    schemaVersion,
    repos,
    credentialStore,
    processRunner,
    detector,
    logger,
    appDataDir: deps.appDataDir,
    runtime,
    mcp,
    agentManagement,
    agentNavigation,

    async initializeUser(userId: LocalUserId): Promise<void> {
      const now = clock.nowIso();
      repos.categories.ensureDefaults(userId, 'skill', now);
      repos.categories.ensureDefaults(userId, 'mcp', now);
      ensureUserMemoryProfile(deps.appDataDir, userId);
      seedBundledMemoryServers(repos, deps.runtime, now);
      generatedSkills.seedBuiltinCreator([userId]);
      agentManagement.initializeUser(userId);
      skillCatalog.refresh(userId);
      mcp.rebuildUserTools(userId);
    },

    bootstrap(userId: LocalUserId): BootstrapResult {
      const user = repos.users.getUser(userId);
      if (!user) {
        throw new BridgeError('USER_NOT_FOUND', 'User not found');
      }
      return {
        activeUser: user,
        users: repos.users.listUsers(),
        runtime: { status: 'ready', generation: deps.generation },
        schemaVersion,
        defaultAgentId: repos.agents.getDefault(userId).id,
        revisions: repos.users.getRevisions(userId),
        capabilities: {
          model: 'foundation',
          skill: 'foundation',
          runtime: 'ready',
          agentProfiles: 'ready',
          agentDelegation: 'ready',
          scopedMcpInstances: 'pending',
        },
      };
    },

    async health(userId: LocalUserId): Promise<HealthSnapshot> {
      const interpreters = await detector.detect();
      const credentialStatus = await detectCredentialHealth(credentialStore);
      skillCatalog.refresh(userId);
      const skillRoot = skillCatalog.skillRootHealth(userId);
      return {
        worker: { status: 'ready', generation: deps.generation },
        database: { status: 'ok', schemaVersion: currentSchemaVersion(db) },
        credential: { status: credentialStatus },
        skillRoot,
        interpreters: {
          node: toHealth(interpreters.node),
          python: toHealth(interpreters.python),
          shell: toHealth(interpreters.shell),
        },
      };
    },

    skillCatalog(userId: LocalUserId): SkillCatalogSnapshot {
      return skillCatalog.catalog(userId);
    },

    async modelManagement(userId: LocalUserId): Promise<ModelManagementSnapshot> {
      const services = repos.models
        .listServices(userId)
        .filter((service) => service.status !== 'archived');
      const models = repos.models.listModels(userId).filter((model) => model.status !== 'archived');
      return {
        revision: repos.users.getRevisions(userId).modelRevision,
        defaultModelId: repos.models.getDefaultModelId(userId),
        services: await Promise.all(
          services.map(async (service) => {
            const serviceModels = models.filter((model) => model.serviceId === service.id);
            const credentialStatus = service.credentialRef
              ? await credentialStatusOf(credentialStore, service.credentialRef)
              : ('missing' as const);
            return {
              id: service.id,
              name: service.name,
              providerType: service.providerType,
              providerPresetId:
                service.providerPresetId ??
                inferProviderPresetFromEndpoint(service.endpoint)?.id ??
                null,
              endpoint: service.endpoint,
              status: service.status,
              credentialStatus,
              config: service.config,
              modelCount: serviceModels.length,
              agentReady:
                service.status === 'enabled' &&
                serviceModels.some((model) => model.status === 'enabled'),
            };
          }),
        ),
        models: models.map((model) => {
          const service = services.find((candidate) => candidate.id === model.serviceId);
          const presetId =
            service?.providerPresetId ??
            (service ? inferProviderPresetFromEndpoint(service.endpoint)?.id : null) ??
            null;
          const capabilities = effectiveModelCapabilities(modelCatalog, service, model);
          const effectiveContextWindow = capabilities.contextWindow ?? 32_768;
          const recommendedMaxOutputTokens = recommendedOutputBudget({
            contextWindow: effectiveContextWindow,
            compactionTriggerRatio: model.compactionTriggerRatio,
            maxOutputCapability: capabilities.maxOutputCapability,
          });
          return {
            id: model.id,
            serviceId: model.serviceId,
            remoteModelId: model.remoteModelId,
            displayName: model.displayName,
            contextWindow: capabilities.contextWindow,
            automaticContextWindow: capabilities.automaticContextWindow,
            contextWindowOverride: model.contextWindowOverride,
            compactionTriggerRatio: model.compactionTriggerRatio,
            maxOutputTokens: model.requestMaxOutputTokens ?? recommendedMaxOutputTokens,
            inputCapability: capabilities.inputCapability,
            maxOutputCapability: capabilities.maxOutputCapability,
            requestMaxOutputTokens: model.requestMaxOutputTokens,
            metadataSource: capabilities.metadataSource,
            automaticMetadataSource: capabilities.automaticMetadataSource,
            catalogVersion: capabilities.catalogVersion,
            capabilityProfileRef: model.capabilityProfileRef,
            capabilityMatchKind: capabilities.capabilityMatchKind,
            thinkingMode: model.thinkingMode,
            reasoningEffort: normalizeReasoningEffort(
              presetId,
              model.remoteModelId,
              model.reasoningEffort,
            ),
            supportedReasoningEfforts: [
              ...supportedReasoningEffortsFor(presetId, model.remoteModelId),
            ],
            capabilities: model.capabilities,
            defaultParams: model.defaultParams,
            source: model.source,
            status: model.status,
          };
        }),
      };
    },

    modelCallStatistics(userId, params) {
      const sessions = repos.sessions.listSessions(userId);
      return buildModelCallStatistics(
        sessions.map((session) => ({
          session,
          events: repos.sessions.listEvents(userId, session.id),
        })),
        params,
      );
    },

    async saveModelService(userId, input) {
      assertRevision(repos.users.getRevisions(userId).modelRevision, input.expectedRevision);
      const id = input.id ?? ids.newId();
      const existing = input.id ? repos.models.getService(userId, input.id) : undefined;
      if (input.id && !existing) throw new BridgeError('INVALID_REQUEST', 'Service not found');
      const scope = { userId, purpose: 'model-service', entityId: id };
      const credentialRef = await applyCredentialMutation(
        credentialStore,
        logger,
        scope,
        existing?.credentialRef ?? null,
        input.credential,
      );
      const endpoint = validateModelEndpoint(input.endpoint);
      const preset =
        getProviderPreset(input.providerPresetId) ?? inferProviderPresetFromEndpoint(endpoint);
      if (preset && !validatePresetEndpoint(preset, endpoint)) {
        throw new BridgeError('INVALID_REQUEST', 'Endpoint does not match the provider preset');
      }
      if (existing) {
        repos.models.updateService(
          userId,
          id,
          {
            name: input.name,
            endpoint,
            providerPresetId: preset?.id ?? null,
            providerPresetVersion: preset?.version ?? null,
            config: sanitizeModelParams(input.config),
            credentialRef,
            status: input.enabled ? 'enabled' : 'disabled',
          },
          clock.nowIso(),
        );
      } else {
        repos.models.createService({
          id,
          userId,
          name: input.name,
          providerType: input.providerType,
          endpoint,
          credentialRef,
          providerPresetId: preset?.id ?? null,
          providerPresetVersion: preset?.version ?? null,
          config: sanitizeModelParams(input.config),
          now: clock.nowIso(),
        });
        if (!input.enabled) {
          repos.models.updateService(userId, id, { status: 'disabled' }, clock.nowIso());
        }
      }
      return { id };
    },

    async testModelService(userId, input) {
      const existing = input.id ? repos.models.getService(userId, input.id) : undefined;
      const credential = await credentialForDraft(
        credentialStore,
        existing?.credentialRef ?? null,
        input.credential,
      );
      if (credential) logger.registerSecret(credential);
      return { status: await testOpenAiService(input.endpoint, credential) };
    },

    archiveModelService(userId, id, expectedRevision) {
      assertRevision(repos.users.getRevisions(userId).modelRevision, expectedRevision);
      repos.models.archiveService(userId, id, clock.nowIso());
      return { id };
    },

    saveModel(userId, input) {
      assertRevision(repos.users.getRevisions(userId).modelRevision, input.expectedRevision);
      const service = repos.models.getService(userId, input.serviceId);
      if (!service || service.status === 'archived') {
        throw new BridgeError('INVALID_REQUEST', 'Service not found');
      }
      const matchingRemoteModel = repos.models.getModelByRemoteId(
        userId,
        input.serviceId,
        input.remoteModelId,
      );
      const id = input.id ?? matchingRemoteModel?.id ?? ids.newId();
      const existing = input.id ? repos.models.getModel(userId, input.id) : matchingRemoteModel;
      if (input.id && (!existing || existing.serviceId !== input.serviceId)) {
        throw new BridgeError('INVALID_REQUEST', 'Model not found');
      }
      const defaultParams = sanitizeModelParams(input.defaultParams);
      const effectivePreset =
        getProviderPreset(service.providerPresetId) ??
        inferProviderPresetFromEndpoint(service.endpoint);
      if (
        effectivePreset &&
        ['thinking', 'enable_thinking', 'reasoning_effort'].some((key) => key in defaultParams)
      ) {
        throw new BridgeError(
          'INVALID_REQUEST',
          'Thinking parameters must be configured with the preset controls',
        );
      }
      const thinkingMode = input.thinkingMode ?? 'auto';
      const reasoningEffort =
        thinkingMode === 'enabled'
          ? normalizeReasoningEffort(
              effectivePreset?.id,
              input.remoteModelId,
              input.reasoningEffort ?? 'medium',
            )
          : null;
      const catalogCapabilities = trustedCatalogCapabilities(modelCatalog, service, {
        remoteModelId: input.remoteModelId,
        capabilityProfileRef: input.capabilityProfileRef ?? null,
      });
      const contextWindow =
        catalogCapabilities?.context ?? existing?.contextWindow ?? input.contextWindow;
      const contextWindowOverride =
        input.contextWindowOverride === undefined
          ? (existing?.contextWindowOverride ?? null)
          : input.contextWindowOverride;
      const compactionTriggerRatio =
        input.compactionTriggerRatio ?? existing?.compactionTriggerRatio ?? 0.8;
      const inputCapability =
        catalogCapabilities?.input ?? existing?.inputCapability ?? input.inputCapability ?? null;
      const maxOutputCapability =
        catalogCapabilities?.output ??
        existing?.maxOutputCapability ??
        input.maxOutputCapability ??
        null;
      const metadataSource = catalogCapabilities
        ? ('catalog' as const)
        : (existing?.metadataSource ?? input.metadataSource);
      const catalogVersion = catalogCapabilities
        ? modelCatalog.generatedAt
        : (existing?.catalogVersion ?? input.catalogVersion);
      const capabilityMatchKind =
        catalogCapabilities?.matchKind ??
        existing?.capabilityMatchKind ??
        input.capabilityMatchKind;
      const requestedOutputOverride =
        input.requestMaxOutputTokens === undefined
          ? existing
            ? existing.requestMaxOutputTokens
            : input.maxOutputTokens
          : input.requestMaxOutputTokens;
      const effectiveContextWindow = contextWindowOverride ?? contextWindow;
      const requestMaxOutputTokens =
        requestedOutputOverride === null
          ? null
          : Math.min(
              requestedOutputOverride,
              maximumManualOutputBudget({
                contextWindow: effectiveContextWindow,
                maxOutputCapability,
              }),
            );
      const maxOutputTokens =
        requestMaxOutputTokens ??
        recommendedOutputBudget({
          contextWindow: effectiveContextWindow,
          compactionTriggerRatio,
          maxOutputCapability,
        });
      if (existing) {
        repos.models.updateModel(
          userId,
          id,
          {
            remoteModelId: input.remoteModelId,
            displayName: input.displayName,
            contextWindow,
            contextWindowOverride,
            compactionTriggerRatio,
            maxOutputTokens,
            inputCapability,
            maxOutputCapability,
            requestMaxOutputTokens,
            metadataSource,
            catalogVersion,
            capabilityProfileRef: input.capabilityProfileRef,
            capabilityMatchKind,
            thinkingMode,
            reasoningEffort,
            capabilities: input.capabilities,
            defaultParams,
            status: input.enabled ? 'enabled' : 'disabled',
          },
          clock.nowIso(),
        );
      } else {
        repos.models.createModel({
          id,
          userId,
          serviceId: input.serviceId,
          remoteModelId: input.remoteModelId,
          displayName: input.displayName,
          contextWindow,
          contextWindowOverride,
          compactionTriggerRatio,
          maxOutputTokens,
          inputCapability,
          maxOutputCapability,
          requestMaxOutputTokens,
          metadataSource,
          catalogVersion,
          capabilityProfileRef: input.capabilityProfileRef,
          capabilityMatchKind,
          thinkingMode,
          reasoningEffort,
          capabilities: input.capabilities,
          defaultParams,
          source: 'manual',
          now: clock.nowIso(),
        });
        if (!input.enabled) repos.models.setModelStatus(userId, id, 'disabled', clock.nowIso());
      }
      return { id };
    },

    archiveModel(userId, id, expectedRevision) {
      assertRevision(repos.users.getRevisions(userId).modelRevision, expectedRevision);
      repos.models.setModelStatus(userId, id, 'archived', clock.nowIso());
      return { id };
    },

    setDefaultModel(userId, modelId, expectedRevision) {
      assertRevision(repos.users.getRevisions(userId).modelRevision, expectedRevision);
      repos.models.setDefaultModel(userId, modelId, clock.nowIso());
      return { modelId };
    },

    async discoverModels(userId, serviceId) {
      const service = repos.models.getService(userId, serviceId);
      if (!service || service.status !== 'enabled') {
        throw new BridgeError('INVALID_REQUEST', 'Service not found');
      }
      const credential = service.credentialRef
        ? await credentialStore.getByRef(service.credentialRef)
        : null;
      if (credential) logger.registerSecret(credential);
      const remoteModelIds = await fetchOpenAiModels(service.endpoint, credential);
      return {
        serviceId,
        remoteModelIds,
        models: remoteModelIds.map((id) => {
          const match = matchModelCapability(modelCatalog, {
            modelId: id,
            apiEndpoint: service.endpoint,
            providerPresetId: service.providerPresetId,
          });
          return {
            id,
            contextWindow: match.model?.context ?? null,
            inputCapability: match.model?.input ?? null,
            maxOutputCapability: match.model?.output ?? null,
            metadataSource: match.model ? ('catalog' as const) : ('fallback' as const),
            capabilityMatchKind: match.matchKind,
            conflicts: match.conflicts,
          };
        }),
      };
    },

    skillManagement(userId) {
      skillCatalog.refresh(userId);
      return {
        revision: repos.users.getRevisions(userId).skillRevision,
        categories: repos.categories.list(userId, 'skill').map((category) => ({
          id: category.id,
          type: category.type,
          name: category.name,
          sortOrder: category.sortOrder,
          system: category.system,
        })),
        skills: repos.skills
          .listInstallations(userId)
          .filter(
            (skill) =>
              !(skill.skillName === BUILTIN_SKILL_CREATOR_NAME && skill.sourceType === 'bundled'),
          )
          .map((skill) => ({
            id: skill.id,
            name: skill.skillName,
            description: skill.description,
            categoryId: skill.categoryId,
            sourceType: skill.sourceType,
            enabled: skill.enabled,
            status: skill.status,
            compatibilityStatus: skill.compatibilityStatus,
            contentDigest: skill.contentDigest,
            metadata: skill.metadata,
          })),
      };
    },

    updateSkillDescription(userId, input) {
      return skillManagement.updateDescription(userId, input);
    },

    deleteSkill(userId, skillName, expectedRevision) {
      return skillManagement.delete(userId, skillName, expectedRevision);
    },

    setSkillEnabled(userId, skillName, enabled, expectedRevision) {
      assertRevision(repos.users.getRevisions(userId).skillRevision, expectedRevision);
      const installation = repos.skills.getInstallation(userId, skillName);
      if (
        installation?.skillName === BUILTIN_SKILL_CREATOR_NAME &&
        installation.sourceType === 'bundled'
      ) {
        throw new BridgeError('INVALID_REQUEST', 'Built-in Skill cannot be disabled');
      }
      repos.skills.setEnabled(userId, skillName, enabled, clock.nowIso());
      return { skillName, enabled };
    },

    setSkillCategory(userId, skillName, categoryId, expectedRevision) {
      assertRevision(repos.users.getRevisions(userId).skillRevision, expectedRevision);
      repos.categories.setSkillCategory(userId, skillName, categoryId, clock.nowIso());
      return { skillName, categoryId };
    },

    createCapabilityCategory(userId, type, name, expectedRevision) {
      assertRevision(revisionForCategoryType(repos, userId, type), expectedRevision);
      const id = ids.newId();
      repos.categories.create(userId, type, id, name, clock.nowIso());
      return { id };
    },

    renameCapabilityCategory(userId, type, id, name, expectedRevision) {
      assertRevision(revisionForCategoryType(repos, userId, type), expectedRevision);
      repos.categories.rename(userId, type, id, name, clock.nowIso());
      return { id };
    },

    deleteCapabilityCategory(userId, type, id, expectedRevision) {
      assertRevision(revisionForCategoryType(repos, userId, type), expectedRevision);
      repos.categories.delete(userId, type, id, clock.nowIso());
      return { id };
    },

    installSkillDirectory(userId, sourcePath) {
      const parsed = parseSkillDirectory(sourcePath);
      if (!parsed.ok) throw new BridgeError('INVALID_REQUEST', `Invalid Skill: ${parsed.error}`);
      assertSafeSkillTree(parsed.skill.resourceBase);
      const userRoot = skillRoot(userId);
      mkdirSync(userRoot, { recursive: true });
      const destination = path.join(userRoot, parsed.skill.name);
      const existing = repos.skills.getInstallation(userId, parsed.skill.name);
      if (pathExists(destination) || (existing && existing.status !== 'missing')) {
        throw new BridgeError('REVISION_CONFLICT', 'Skill already exists; use update');
      }
      const temporary = path.join(userRoot, `.install-${ids.newId()}`);
      try {
        cpSync(parsed.skill.resourceBase, temporary, { recursive: true, dereference: false });
        renameSync(temporary, destination);
      } catch (error) {
        rmSync(temporary, { recursive: true, force: true });
        throw error;
      }
      skillCatalog.refresh(userId);
      return { skillName: parsed.skill.name };
    },

    async mcpManagement(userId) {
      const servers = repos.mcp.listServers(userId);
      const tools = repos.mcp.listTools(userId);
      return {
        revision: repos.users.getRevisions(userId).mcpRevision,
        categories: repos.categories.list(userId, 'mcp').map((category) => ({
          id: category.id,
          type: category.type,
          name: category.name,
          sortOrder: category.sortOrder,
          system: category.system,
        })),
        servers: await Promise.all(
          servers.map(async (server) => {
            const serverTools = tools.filter((tool) => tool.serverId === server.id);
            return {
              id: server.id,
              name: server.name,
              summary: server.summary,
              categoryId: server.categoryId,
              transport: server.transport,
              status: server.status === 'enabled' ? 'enabled' : 'disabled',
              config: { ...server.config },
              credentialStatus: server.credentialRef
                ? await credentialStatusOf(credentialStore, server.credentialRef)
                : ('missing' as const),
              connectionStatus: server.connectionStatus,
              generation: server.generation,
              lastError: server.lastError,
              toolCount: serverTools.length,
              enabledToolCount: serverTools.filter(
                (tool) => tool.enabled && tool.reviewStatus === 'approved',
              ).length,
            };
          }),
        ),
        instances: mcp.instanceSnapshot(userId).map((instance) => ({
          serverId: instance.key.serverId,
          scopeType: instance.key.scopeType,
          scopeId: instance.key.scopeId,
          status: instance.status,
          generation: instance.generation,
          activeCalls: instance.activeCalls,
          lastUsed: instance.lastUsed,
          error: instance.error,
        })),
        tools: tools.map((tool) => ({
          serverId: tool.serverId,
          rawName: tool.rawName,
          publicName: tool.publicName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          schemaDigest: tool.schemaDigest,
          enabled: tool.enabled,
          reviewStatus: tool.reviewStatus,
          approvalPolicy: tool.approvalPolicy,
          generation: tool.generation,
        })),
      };
    },

    async saveMcpServer(userId, input) {
      assertRevision(repos.users.getRevisions(userId).mcpRevision, input.expectedRevision);
      if (!repos.categories.get(userId, 'mcp', input.categoryId)) {
        throw new BridgeError('INVALID_REQUEST', 'Category not found');
      }
      const id = input.id ?? ids.newId();
      const existing = input.id ? repos.mcp.getServer(userId, input.id) : undefined;
      if (input.id && !existing) throw new BridgeError('INVALID_REQUEST', 'MCP server not found');
      const scope = { userId, purpose: 'mcp-server', entityId: id };
      const credentialRef = await applyCredentialMutation(
        credentialStore,
        logger,
        scope,
        existing?.credentialRef ?? null,
        input.credential,
      );
      if (existing) {
        repos.mcp.updateServer(
          userId,
          id,
          {
            name: input.name,
            summary: input.summary,
            transport: input.transport,
            config: input.config,
            credentialRef,
            enabled: input.enabled,
            categoryId: input.categoryId,
          },
          clock.nowIso(),
        );
      } else {
        repos.mcp.createServer({
          id,
          userId,
          name: input.name,
          summary: input.summary,
          transport: input.transport,
          config: input.config,
          credentialRef,
          enabled: input.enabled,
          categoryId: input.categoryId,
          now: clock.nowIso(),
        });
      }
      let catalogReady = false;
      try {
        await mcp.reloadServer(userId, id);
        catalogReady = true;
      } catch (error) {
        if (input.enabled) {
          logger.warn('MCP server saved but connection failed', {
            userId,
            serverId: id,
            error: error instanceof Error ? error.message : 'unknown',
          });
        }
      }
      if (!input.summary && catalogReady) await ensureMcpServerSummary(userId, id);
      return { id };
    },

    async testMcpServer(userId, input) {
      const id = input.id ?? ids.newId();
      const existing = input.id ? repos.mcp.getServer(userId, input.id) : undefined;
      const scope = { userId, purpose: 'mcp-server-test', entityId: id };
      let credentialRef = existing?.credentialRef ?? null;
      if (input.credential.action === 'replace') {
        logger.registerSecret(input.credential.value);
        await credentialStore.set(scope, input.credential.value);
        credentialRef = credentialRefOf(scope);
      } else if (input.credential.action === 'clear') {
        credentialRef = null;
      }
      const server: McpServer = {
        id,
        userId,
        name: input.name,
        summary: input.summary,
        categoryId: input.categoryId,
        transport: input.transport,
        status: 'enabled',
        config: input.config,
        credentialRef,
        connectionStatus: 'disconnected',
        generation: 0,
        lastError: null,
        createdAt: clock.nowIso(),
        updatedAt: clock.nowIso(),
        archivedAt: null,
      };
      try {
        const result = await mcp.testServer(server);
        return { status: 'success' as const, toolCount: result.toolCount };
      } catch (error) {
        return {
          status:
            error instanceof TypeError || error instanceof DOMException
              ? ('network' as const)
              : ('protocol' as const),
          toolCount: 0,
        };
      } finally {
        if (input.credential.action === 'replace') {
          await credentialStore.delete(scope).catch(() => undefined);
        }
      }
    },

    async archiveMcpServer(userId, id, expectedRevision) {
      assertRevision(repos.users.getRevisions(userId).mcpRevision, expectedRevision);
      const existing = repos.mcp.getServer(userId, id);
      if (!existing) throw new BridgeError('INVALID_REQUEST', 'MCP server not found');
      repos.mcp.archiveServer(userId, id, clock.nowIso());
      await mcp.removeServer(userId, id);
      await credentialStore
        .delete({ userId, purpose: 'mcp-server', entityId: id })
        .catch(() => undefined);
      return { id };
    },

    async refreshMcpServer(userId, id) {
      const toolCount = await mcp.refreshServer(userId, id);
      const server = repos.mcp.getServer(userId, id);
      if (server && !server.summary) await ensureMcpServerSummary(userId, id);
      return { id, toolCount };
    },

    setMcpToolEnabled(userId, serverId, rawName, enabled, expectedRevision) {
      assertRevision(repos.users.getRevisions(userId).mcpRevision, expectedRevision);
      repos.mcp.setToolEnabled(userId, serverId, rawName, enabled, clock.nowIso());
      mcp.rebuildUserTools(userId);
      return { serverId, rawName, enabled };
    },

    registerSecret(secret: string): void {
      logger.registerSecret(secret);
    },

    close(): void {
      runtime.close();
      void mcp.close();
      try {
        db.close();
      } catch {
        // 忽略关闭错误。
      }
    },
  };

  async function ensureMcpServerSummary(userId: LocalUserId, serverId: string): Promise<void> {
    const server = repos.mcp.getServer(userId, serverId);
    if (!server || server.summary) return;
    const discoveredTools = repos.mcp.listTools(userId, serverId);
    if (discoveredTools.length === 0) return;
    const fallback = fallbackMcpSummary(discoveredTools);
    let summary = fallback;
    if (repos.models.getDefaultModelId(userId)) {
      try {
        const model = resolveRuntimeModel(repos, modelCatalog, userId);
        const adapter = llmAdapters.get(model.providerType);
        if (adapter) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30_000);
          timer.unref();
          try {
            const response = await adapter.generate(
              {
                requestId: ids.newId(),
                purpose: 'metadata',
                model,
                messages: [
                  {
                    role: 'system',
                    content:
                      '你负责为 MCP Server 生成中文能力摘要。只输出一到两句纯文本，不要标题、Markdown、引号或解释；必须基于给定工具，控制在 120 个汉字以内。',
                  },
                  {
                    role: 'user',
                    content: mcpSummaryPrompt(server.name, discoveredTools),
                  },
                ],
                tools: [],
                maxOutputTokens: Math.min(256, model.maxOutputTokens),
              },
              controller.signal,
            );
            summary = normalizeMcpSummary(response.content) || fallback;
          } finally {
            clearTimeout(timer);
          }
        }
      } catch (error) {
        logger.warn('MCP summary generation failed; using catalog fallback', {
          userId,
          serverId,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
    repos.mcp.setServerSummary(userId, serverId, summary, clock.nowIso());
    mcp.rebuildUserTools(userId);
  }

  mcp.start();
  return app;
}

function resolveRuntimeModel(
  repos: SqliteRepositories,
  modelCatalog: ModelCatalog,
  userId: LocalUserId,
  agentId?: string,
): ModelSnapshot {
  const agentModelId = agentId ? repos.agents.requireActive(userId, agentId).defaultModelId : null;
  const modelId = agentModelId ?? repos.models.getDefaultModelId(userId);
  if (!modelId) throw new BridgeError('MODEL_NOT_CONFIGURED', 'Default model is not configured');
  const model = repos.models.getModel(userId, modelId);
  if (!model || model.status !== 'enabled') {
    throw new BridgeError('MODEL_NOT_CONFIGURED', 'Default model is unavailable');
  }
  const service = repos.models.getService(userId, model.serviceId);
  if (!service || service.status !== 'enabled') {
    throw new BridgeError('MODEL_NOT_CONFIGURED', 'Model service is unavailable');
  }
  const capabilities = effectiveModelCapabilities(modelCatalog, service, model);
  const contextWindow = capabilities.contextWindow ?? 32_768;
  const maxOutputCapability = capabilities.maxOutputCapability ?? model.maxOutputTokens ?? 4096;
  const maxOutputTokens =
    model.requestMaxOutputTokens ??
    recommendedOutputBudget({
      contextWindow,
      compactionTriggerRatio: model.compactionTriggerRatio,
      maxOutputCapability,
    });
  return {
    serviceId: service.id,
    modelId: model.id,
    providerType: service.providerType,
    remoteModelId: model.remoteModelId,
    endpoint: validateModelEndpoint(service.endpoint),
    credentialRef: service.credentialRef,
    contextWindow,
    compactionTriggerRatio: model.compactionTriggerRatio,
    inputCapability: capabilities.inputCapability,
    maxOutputCapability,
    ...(model.requestMaxOutputTokens === null
      ? {}
      : { requestMaxOutputTokens: model.requestMaxOutputTokens }),
    maxOutputTokens,
    metadataSource: capabilities.metadataSource,
    catalogVersion: capabilities.catalogVersion,
    capabilityMatchKind: capabilities.capabilityMatchKind,
    providerPresetId:
      service.providerPresetId ?? inferProviderPresetFromEndpoint(service.endpoint)?.id ?? null,
    thinkingMode: model.thinkingMode,
    reasoningEffort: model.reasoningEffort,
    params: applyThinkingSettings(
      service.providerPresetId ?? inferProviderPresetFromEndpoint(service.endpoint)?.id ?? null,
      model.remoteModelId,
      { thinkingMode: model.thinkingMode, reasoningEffort: model.reasoningEffort },
      sanitizeModelParams({ ...service.config, ...model.defaultParams }),
    ),
    configRevision: repos.users.getRevisions(userId).modelRevision,
  };
}

function mcpSummaryPrompt(serverName: string, tools: readonly McpToolCatalogEntry[]): string {
  const catalog = tools.slice(0, 50).map((tool) => ({
    name: tool.rawName,
    description: tool.description.replace(/\s+/g, ' ').trim().slice(0, 300),
    parameters: Object.keys(
      typeof tool.inputSchema.properties === 'object' && tool.inputSchema.properties !== null
        ? tool.inputSchema.properties
        : {},
    ).slice(0, 20),
  }));
  return `Server 名称：${serverName}\n工具目录：${JSON.stringify(catalog)}`;
}

function fallbackMcpSummary(tools: readonly McpToolCatalogEntry[]): string {
  const descriptions = tools
    .map((tool) => tool.description.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3);
  if (descriptions.length > 0) return normalizeMcpSummary(descriptions.join('；'));
  const names = tools.slice(0, 8).map((tool) => tool.rawName);
  return normalizeMcpSummary(`提供 ${names.join('、')} 等 MCP 工具能力。`);
}

function normalizeMcpSummary(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```(?:text|markdown)?|```/gi, ''))
    .replace(/^\s*(?:摘要|简介|能力摘要)\s*[:：]\s*/i, '')
    .replace(/^[“”"']+|[“”"']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function trustedCatalogCapabilities(
  catalog: ModelCatalog,
  service: ModelService | undefined,
  model: Pick<Model, 'remoteModelId' | 'capabilityProfileRef'>,
):
  | {
      context: number;
      input: number | null;
      output: number;
      matchKind: CapabilityMatchKind;
    }
  | undefined {
  if (!service) return undefined;
  const presetId =
    service.providerPresetId ?? inferProviderPresetFromEndpoint(service.endpoint)?.id ?? null;
  const match = matchModelCapability(catalog, {
    modelId: model.remoteModelId,
    apiEndpoint: service.endpoint,
    providerPresetId: presetId,
    capabilityProfileRef: model.capabilityProfileRef,
  });
  if (
    !match.model ||
    !['profile', 'preset', 'host', 'model-unique', 'model-consensus'].includes(match.matchKind)
  )
    return undefined;
  return {
    context: match.model.context,
    input: match.model.input ?? null,
    output: match.model.output,
    matchKind: match.matchKind,
  };
}

function effectiveModelCapabilities(
  catalog: ModelCatalog,
  service: ModelService | undefined,
  model: Model,
): Pick<
  Model,
  | 'contextWindow'
  | 'inputCapability'
  | 'maxOutputCapability'
  | 'metadataSource'
  | 'catalogVersion'
  | 'capabilityMatchKind'
> & {
  automaticContextWindow: number | null;
  automaticMetadataSource: Model['metadataSource'];
} {
  const catalogCapabilities = trustedCatalogCapabilities(catalog, service, model);
  const automaticContextWindow = catalogCapabilities?.context ?? model.contextWindow;
  const automaticMetadataSource = catalogCapabilities ? ('catalog' as const) : model.metadataSource;
  return {
    contextWindow: model.contextWindowOverride ?? automaticContextWindow,
    automaticContextWindow,
    inputCapability: catalogCapabilities?.input ?? model.inputCapability,
    maxOutputCapability: catalogCapabilities?.output ?? model.maxOutputCapability,
    metadataSource: model.contextWindowOverride === null ? automaticMetadataSource : 'manual',
    automaticMetadataSource,
    catalogVersion: catalogCapabilities ? catalog.generatedAt : model.catalogVersion,
    capabilityMatchKind:
      model.contextWindowOverride === null
        ? (catalogCapabilities?.matchKind ?? model.capabilityMatchKind)
        : 'manual',
  };
}

function sanitizeModelParams(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/(api[-_]?key|token|secret|password|authorization|credential)/i.test(key)) continue;
    output[key] = sanitizeParamValue(value);
  }
  return output;
}

function validateModelEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new BridgeError('MODEL_NOT_CONFIGURED', 'Model endpoint is invalid');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    [...parsed.searchParams.keys()].some((key) =>
      /(api[-_]?key|token|secret|password|authorization|credential)/i.test(key),
    )
  ) {
    throw new BridgeError('MODEL_NOT_CONFIGURED', 'Model endpoint is unsafe');
  }
  return parsed.toString();
}

function sanitizeParamValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeParamValue);
  if (typeof value === 'object' && value !== null) {
    return sanitizeModelParams(value as Record<string, unknown>);
  }
  return value;
}

async function detectCredentialHealth(
  store: CredentialStore,
): Promise<HealthSnapshot['credential']['status']> {
  try {
    const ok = await store.available();
    return ok ? 'configured' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

async function credentialStatusOf(
  store: CredentialStore,
  credentialRef: string,
): Promise<'configured' | 'missing'> {
  try {
    return (await store.getByRef(credentialRef)) ? 'configured' : 'missing';
  } catch {
    return 'missing';
  }
}

function assertRevision(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new BridgeError('REVISION_CONFLICT', 'Configuration revision changed');
  }
}

function revisionForCategoryType(
  repos: SqliteRepositories,
  userId: LocalUserId,
  type: CapabilityCategoryType,
): number {
  const revisions = repos.users.getRevisions(userId);
  return type === 'skill' ? revisions.skillRevision : revisions.mcpRevision;
}

async function applyCredentialMutation(
  store: CredentialStore,
  logger: Logger,
  scope: CredentialScope,
  existingRef: string | null,
  mutation: CredentialMutation,
): Promise<string | null> {
  if (mutation.action === 'unchanged') return existingRef;
  if (mutation.action === 'clear') {
    await store.delete(scope);
    return null;
  }
  logger.registerSecret(mutation.value);
  await store.set(scope, mutation.value);
  return credentialRefOf(scope);
}

async function credentialForDraft(
  store: CredentialStore,
  existingRef: string | null,
  mutation: CredentialMutation,
): Promise<string | null> {
  if (mutation.action === 'replace') return mutation.value;
  if (mutation.action === 'clear' || !existingRef) return null;
  return store.getByRef(existingRef);
}

async function testOpenAiService(
  endpoint: string,
  credential: string | null,
): Promise<'success' | 'auth' | 'network' | 'timeout' | 'protocol'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  timer.unref();
  try {
    const response = await fetch(openAiModelsUrl(endpoint), {
      headers: credential ? { authorization: `Bearer ${credential}` } : undefined,
      signal: controller.signal,
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) return 'auth';
    if (!response.ok) return 'protocol';
    const value = (await response.json()) as unknown;
    return Array.isArray(asRecord(value)?.data) ? 'success' : 'protocol';
  } catch (error) {
    return error instanceof DOMException && error.name === 'AbortError' ? 'timeout' : 'network';
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenAiModels(endpoint: string, credential: string | null): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  timer.unref();
  try {
    const response = await fetch(openAiModelsUrl(endpoint), {
      headers: credential ? { authorization: `Bearer ${credential}` } : undefined,
      signal: controller.signal,
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) {
      throw new BridgeError('MODEL_NOT_CONFIGURED', 'Model credential is invalid');
    }
    if (!response.ok) throw new BridgeError('RUNTIME_UNAVAILABLE', 'Model service unavailable');
    const root = asRecord((await response.json()) as unknown);
    const data = root?.data;
    if (!Array.isArray(data)) throw new BridgeError('INVALID_REQUEST', 'Invalid models response');
    return data
      .map((item) => stringAt(asRecord(item), 'id'))
      .filter((item): item is string => Boolean(item))
      .sort();
  } finally {
    clearTimeout(timer);
  }
}

function openAiModelsUrl(endpoint: string): string {
  const url = new URL(validateModelEndpoint(endpoint));
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith('/models')) url.pathname = `${pathname}/models`;
  return url.toString();
}

function pathExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function assertSafeSkillTree(root: string): void {
  let files = 0;
  let bytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new BridgeError('INVALID_REQUEST', 'Skill contains symlink');
      files += 1;
      if (files > 2_000) throw new BridgeError('INVALID_REQUEST', 'Skill contains too many files');
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile()) bytes += stat.size;
      else throw new BridgeError('INVALID_REQUEST', 'Skill contains unsupported entry');
      if (bytes > 20 * 1024 * 1024) {
        throw new BridgeError('INVALID_REQUEST', 'Skill exceeds size limit');
      }
    }
  };
  visit(root);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const found = value?.[key];
  return typeof found === 'string' ? found : undefined;
}

function toHealth(input: {
  status: 'available' | 'missing' | 'error' | 'unsupported';
  version: string | null;
  source: 'bundled' | 'system' | null;
  arch: string | null;
}): InterpreterHealth {
  return {
    status: input.status,
    version: input.version,
    source: input.source,
    arch: input.arch,
  };
}
