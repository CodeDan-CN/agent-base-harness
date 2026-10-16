import type { RuntimeProjection, ProjectedStep } from '@client-contracts';

export function executionActivity(
  projection: RuntimeProjection,
  step: ProjectedStep,
): string | null {
  const tools = [...projection.toolCalls.values()].filter((tool) => tool.stepId === step.id);
  if (
    [...projection.approvals.values()].some(
      (item) => item.stepId === step.id && item.status === 'pending',
    )
  ) {
    return '等待操作授权';
  }
  if (tools.some((tool) => tool.status === 'needs_input')) return '等待用户补充信息';
  if (step.status === 'cancelled') return '本步骤已停止';
  if (step.status === 'failed') return '本步骤失败，可展开详情查看';
  const pending = tools.filter((tool) => tool.status === 'running');
  if (step.status === 'running' && pending.length) {
    const actions = [...new Set(pending.map(toolAction))];
    const action = `${actions.slice(0, 2).join('、')}${actions.length > 2 ? ` 等 ${actions.length} 项操作` : ''}`;
    const latestProgress = [...pending]
      .filter((tool) => tool.progress?.message)
      .sort((left, right) =>
        (right.progress?.updatedAt ?? '').localeCompare(left.progress?.updatedAt ?? ''),
      )[0]?.progress?.message;
    return latestProgress ? `正在执行：${action} · ${latestProgress}` : `正在执行：${action}`;
  }
  if (tools.length) {
    const succeeded = tools.filter((tool) => tool.status === 'success').length;
    return succeeded === tools.length
      ? `已完成 ${tools.length} 项工具调用`
      : `工具结果已返回：${succeeded}/${tools.length} 项成功，可展开详情查看`;
  }
  return null;
}

function toolAction(
  tool: RuntimeProjection['toolCalls'] extends Map<string, infer Item> ? Item : never,
): string {
  if (
    tool.presentation &&
    typeof tool.presentation === 'object' &&
    !Array.isArray(tool.presentation)
  ) {
    const title = (tool.presentation as Record<string, unknown>).title;
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return tool.name;
}
