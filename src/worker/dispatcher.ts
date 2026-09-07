import type { LocalUserId } from '../shared/domain/user';
import {
  eventReadParamsSchema,
  eventsPageParamsSchema,
  inboxPromoteParamsSchema,
  inboxRemoveParamsSchema,
  inboxReplaceParamsSchema,
  inputSubmitParamsSchema,
  interactionResolveParamsSchema,
  approvalResolveParamsSchema,
  permissionPresetSetParamsSchema,
  sessionArchiveParamsSchema,
  sessionCreateParamsSchema,
  sessionRenameParamsSchema,
  sessionTargetSchema,
  turnCancelAndQueueParamsSchema,
  turnCancelParamsSchema,
  turnReadParamsSchema,
} from '../client-contracts/runtime';
import { z } from 'zod';
import { BridgeError } from '../shared/contracts/errors';
import type { WorkerApplication } from './application';
import {
  capabilityCategoryCreateParamsSchema,
  capabilityCategoryDeleteParamsSchema,
  capabilityCategoryRenameParamsSchema,
  modelArchiveParamsSchema,
  modelDefaultSetParamsSchema,
  modelDiscoverParamsSchema,
  modelSaveParamsSchema,
  modelServiceArchiveParamsSchema,
  modelServiceSaveParamsSchema,
  modelServiceTestParamsSchema,
  skillToggleParamsSchema,
  skillDescriptionUpdateParamsSchema,
  skillCategorySetParamsSchema,
  mcpServerSaveParamsSchema,
  mcpServerTargetParamsSchema,
  mcpServerTestParamsSchema,
  mcpToolToggleParamsSchema,
} from '../shared/contracts/management';
import { modelCallStatisticsParamsSchema } from '../shared/contracts/statistics';

export async function dispatch(
  app: WorkerApplication,
  method: string,
  params: unknown,
  userId: LocalUserId,
): Promise<unknown> {
  switch (method) {
    case 'app.bootstrap':
      return app.bootstrap(userId);
    case 'system.health':
      return app.health(userId);
    case 'user.switch': {
      throw new BridgeError('INVALID_REQUEST', 'User switching requires a new login session');
    }
    case 'session.create': {
      const value = parse(sessionCreateParamsSchema, params);
      return app.runtime.createSession(userId, value);
    }
    case 'session.rename': {
      const value = parse(sessionRenameParamsSchema, params);
      return app.runtime.renameSession(userId, value.sessionId, value.title, value.expectedVersion);
    }
    case 'session.archive': {
      const value = parse(sessionArchiveParamsSchema, params);
      return app.runtime.archiveSession(userId, value.sessionId);
    }
    case 'input.submit': {
      const value = parse(inputSubmitParamsSchema, params);
      return app.runtime.submitInput(userId, value);
    }
    case 'inbox.remove': {
      const value = parse(inboxRemoveParamsSchema, params);
      return app.runtime.removeInboxItem(userId, value.sessionId, value.inboxItemId);
    }
    case 'inbox.replace': {
      const value = parse(inboxReplaceParamsSchema, params);
      return app.runtime.replaceInboxItem(
        userId,
        value.sessionId,
        value.inboxItemId,
        value.content,
      );
    }
    case 'inbox.promote': {
      const value = parse(inboxPromoteParamsSchema, params);
      return app.runtime.promoteInboxItem(
        userId,
        value.sessionId,
        value.inboxItemId,
        value.expectedTurnId,
      );
    }
    case 'turn.cancel': {
      const value = parse(turnCancelParamsSchema, params);
      return app.runtime.cancelTurn(userId, value.sessionId, value.turnId, {
        keepNextTurn: value.keepNextTurn,
        keepNextStep: value.keepNextStep,
        reason: value.reason,
      });
    }
    case 'turn.cancel-and-queue': {
      const value = parse(turnCancelAndQueueParamsSchema, params);
      return app.runtime.cancelAndQueue(userId, value);
    }
    case 'interaction.resolve': {
      const value = parse(interactionResolveParamsSchema, params);
      return app.runtime.resolveInteraction(userId, value);
    }
    case 'approval.resolve': {
      const value = parse(approvalResolveParamsSchema, params);
      return app.runtime.resolveApproval(userId, value);
    }
    case 'permission.preset.set': {
      const value = parse(permissionPresetSetParamsSchema, params);
      return app.runtime.setPermissionPreset(userId, value.sessionId, value.preset);
    }
    case 'model-service.save':
      return app.saveModelService(userId, parse(modelServiceSaveParamsSchema, params));
    case 'model-service.test':
      return app.testModelService(userId, parse(modelServiceTestParamsSchema, params));
    case 'model-service.archive': {
      const value = parse(modelServiceArchiveParamsSchema, params);
      return app.archiveModelService(userId, value.id, value.expectedRevision);
    }
    case 'model.save':
      return app.saveModel(userId, parse(modelSaveParamsSchema, params));
    case 'model.archive': {
      const value = parse(modelArchiveParamsSchema, params);
      return app.archiveModel(userId, value.id, value.expectedRevision);
    }
    case 'model.default.set': {
      const value = parse(modelDefaultSetParamsSchema, params);
      return app.setDefaultModel(userId, value.modelId, value.expectedRevision);
    }
    case 'model.discover': {
      const value = parse(modelDiscoverParamsSchema, params);
      return app.discoverModels(userId, value.serviceId);
    }
    case 'skill.enable':
    case 'skill.disable': {
      const value = parse(skillToggleParamsSchema, params);
      return app.setSkillEnabled(
        userId,
        value.skillName,
        method === 'skill.enable',
        value.expectedRevision,
      );
    }
    case 'skill.install.directory': {
      const value = parse(z.object({ sourcePath: z.string().min(1).max(4096) }).strict(), params);
      return app.installSkillDirectory(userId, value.sourcePath);
    }
    case 'skill.description.update':
      return app.updateSkillDescription(userId, parse(skillDescriptionUpdateParamsSchema, params));
    case 'skill.delete': {
      const value = parse(skillToggleParamsSchema, params);
      return app.deleteSkill(userId, value.skillName, value.expectedRevision);
    }
    case 'skill.category.set': {
      const value = parse(skillCategorySetParamsSchema, params);
      return app.setSkillCategory(
        userId,
        value.skillName,
        value.categoryId,
        value.expectedRevision,
      );
    }
    case 'capability-category.create': {
      const value = parse(capabilityCategoryCreateParamsSchema, params);
      return app.createCapabilityCategory(userId, value.type, value.name, value.expectedRevision);
    }
    case 'capability-category.rename': {
      const value = parse(capabilityCategoryRenameParamsSchema, params);
      return app.renameCapabilityCategory(
        userId,
        value.type,
        value.id,
        value.name,
        value.expectedRevision,
      );
    }
    case 'capability-category.delete': {
      const value = parse(capabilityCategoryDeleteParamsSchema, params);
      return app.deleteCapabilityCategory(userId, value.type, value.id, value.expectedRevision);
    }
    case 'mcp-server.save':
      return app.saveMcpServer(userId, parse(mcpServerSaveParamsSchema, params));
    case 'mcp-server.test':
      return app.testMcpServer(userId, parse(mcpServerTestParamsSchema, params));
    case 'mcp-server.archive': {
      const value = parse(mcpServerTargetParamsSchema, params);
      return app.archiveMcpServer(userId, value.id, value.expectedRevision);
    }
    case 'mcp-server.refresh': {
      const value = parse(z.object({ id: z.string().min(1) }).strict(), params);
      return app.refreshMcpServer(userId, value.id);
    }
    case 'mcp-tool.toggle': {
      const value = parse(mcpToolToggleParamsSchema, params);
      return app.setMcpToolEnabled(
        userId,
        value.serverId,
        value.rawName,
        value.enabled,
        value.expectedRevision,
      );
    }
    case 'session.list':
      return app.runtime.listSessions(userId);
    case 'session.snapshot': {
      const value = parse(sessionTargetSchema, params);
      return app.runtime.snapshot(userId, value.sessionId);
    }
    case 'session.events.page': {
      const value = parse(eventsPageParamsSchema, params);
      return app.runtime.eventsPage(userId, value.sessionId, value.afterSeq, value.limit);
    }
    case 'conversation.event.list': {
      const value = parse(sessionTargetSchema, params);
      return app.runtime.conversationEventList(userId, value.sessionId);
    }
    case 'conversation.event.read': {
      const value = parse(eventReadParamsSchema, params);
      return app.runtime.conversationEventRead(userId, value.sessionId, value.eventId);
    }
    case 'execution.turn.list': {
      const value = parse(sessionTargetSchema, params);
      return app.runtime.executionTurnList(userId, value.sessionId);
    }
    case 'execution.turn.read': {
      const value = parse(turnReadParamsSchema, params);
      return app.runtime.executionTurnRead(userId, value.sessionId, value.turnId);
    }
    case 'model-management.snapshot':
      return app.modelManagement(userId);
    case 'model-call-statistics.query':
      return app.modelCallStatistics(userId, parse(modelCallStatisticsParamsSchema, params));
    case 'skill-management.snapshot':
      return app.skillManagement(userId);
    case 'mcp-management.snapshot':
      return app.mcpManagement(userId);
    default:
      throw new BridgeError('INVALID_REQUEST', 'Unknown method');
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BridgeError('INVALID_REQUEST', 'Invalid params');
  return parsed.data;
}
