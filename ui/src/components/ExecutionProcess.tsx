import { useState } from 'react';
import type { JSX } from 'react';
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  MessageSquareText,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { RuntimeProjection } from '@client-contracts';
import { MarkdownContent } from './MarkdownContent';

interface ExecutionProcessProps {
  projection: RuntimeProjection;
  sessionId: string | null;
}

export function ExecutionProcess({ projection, sessionId }: ExecutionProcessProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(true);
  const turn = projection.activeTurn ?? [...projection.turns.values()].at(-1);
  if (!turn) return null;
  const steps = [...projection.steps.values()]
    .filter((step) => step.turnId === turn.id)
    .sort((left, right) => left.stepIndex - right.stepIndex);
  if (steps.length === 0) return null;
  const tools = [...projection.toolCalls.values()].filter((tool) => tool.turnId === turn.id);
  const reasoning = [...projection.reasoning.values()].filter((item) => item.turnId === turn.id);
  const processMessages = projection.messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.turnId === turn.id &&
      Boolean(message.toolCalls?.length) &&
      Boolean(message.content.trim()),
  );

  return (
    <section className="execution-card" aria-label="执行过程">
      <button className="execution-header" onClick={() => setExpanded(!expanded)}>
        <span>
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {turn.status === 'running' && <Loader2 className="spin" size={16} />}
          执行过程
        </span>
        <small>
          {turn.status === 'running'
            ? `已完成 ${Math.max(0, steps.length - 1)} 步`
            : statusText(turn.status, turn.endReason)}
        </small>
      </button>
      {expanded && (
        <div className="execution-body">
          {steps.map((step) => {
            const stepTools = tools
              .filter((tool) => tool.stepId === step.id)
              .sort((left, right) => left.callIndex - right.callIndex);
            const stepReasoning = reasoning.find((item) => item.stepId === step.id);
            const stepMessages = processMessages.filter((message) => message.stepId === step.id);
            return (
              <div className="execution-step" key={step.id}>
                <div className="step-heading">
                  <StatusIcon status={step.status} />
                  <span>步骤 {step.stepIndex}</span>
                  <small>
                    {step.requestContext
                      ? `上下文约 ${step.requestContext.estimatedInputTokens} Token`
                      : '准备模型请求'}
                  </small>
                </div>

                <section className="reasoning-panel" aria-label="思考过程">
                  <div className="execution-section-title">
                    <Brain size={13} />
                    <span>Think · 思考过程</span>
                    {stepReasoning && !stepReasoning.finalized && (
                      <Loader2 className="spin" size={12} />
                    )}
                  </div>
                  {stepReasoning?.content ? (
                    <MarkdownContent content={stepReasoning.content} sessionId={sessionId} />
                  ) : (
                    <p className="execution-placeholder">
                      {step.status === 'running' ? '正在思考…' : '模型未返回独立思考内容'}
                    </p>
                  )}
                </section>

                {stepMessages.length > 0 && (
                  <section className="execution-narrative-panel" aria-label="步骤说明">
                    <div className="execution-section-title">
                      <MessageSquareText size={13} />
                      <span>步骤说明</span>
                    </div>
                    {stepMessages.map((message) => (
                      <MarkdownContent
                        key={message.seq}
                        content={message.content}
                        sessionId={sessionId}
                      />
                    ))}
                  </section>
                )}

                {stepTools.length > 0 && (
                  <section className="tool-execution-panel" aria-label="执行内容">
                    <div className="execution-section-title">
                      <Wrench size={13} />
                      <span>执行内容</span>
                    </div>
                    {stepTools.map((tool) => (
                      <details className="tool-card" key={tool.id} open={tool.status === 'running'}>
                        <summary>
                          <Wrench size={14} />
                          <span>{tool.name}</span>
                          <small>{toolStatus(tool.status)}</small>
                        </summary>
                        <div className="tool-detail">
                          <label>输入</label>
                          <MarkdownContent
                            content={toolMarkdown(tool.input)}
                            sessionId={sessionId}
                          />
                          {tool.output !== undefined && (
                            <>
                              <label>输出</label>
                              <MarkdownContent
                                content={toolMarkdown(tool.output)}
                                sessionId={sessionId}
                              />
                            </>
                          )}
                        </div>
                      </details>
                    ))}
                  </section>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function StatusIcon({ status }: { status: string }): JSX.Element {
  if (status === 'running') return <Loader2 className="spin status-running" size={16} />;
  if (status === 'completed') return <CheckCircle2 className="status-success" size={16} />;
  if (status === 'failed' || status === 'cancelled') {
    return <XCircle className="status-error" size={16} />;
  }
  return <CircleDashed className="status-pending" size={16} />;
}

function statusText(status: string, endReason: string | null): string {
  if (endReason === 'max_steps') return '达到步骤上限';
  if (endReason === 'context_budget_exceeded') return '上下文容量不足';
  if (endReason === 'empty_model_response') return '模型未返回内容';
  const labels: Record<string, string> = {
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已停止',
    interrupted: '意外中断',
  };
  return labels[status] ?? status;
}

function toolStatus(status: string): string {
  if (status === 'running') return '执行中';
  if (status === 'success') return '已完成';
  if (status === 'needs_input') return '等待用户';
  return status.includes('error') ? '失败' : status;
}

function toolMarkdown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  } catch {
    return '无法显示';
  }
}
