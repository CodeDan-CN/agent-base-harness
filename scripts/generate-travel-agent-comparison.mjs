#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const args = { left: '', right: '', leftLabel: 'curry-studio', rightLabel: 'Agent Base Harness', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--left') args.left = path.resolve(argv[++index]);
    else if (value === '--right') args.right = path.resolve(argv[++index]);
    else if (value === '--left-label') args.leftLabel = argv[++index];
    else if (value === '--right-label') args.rightLabel = argv[++index];
    else if (value === '--output') args.output = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.left || !args.right || !args.output) throw new Error('--left, --right and --output are required');
  return args;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function formatNumber(value, digits = 0) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
    : 'n/a';
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return value < 1000 ? `${formatNumber(value)} ms` : `${formatNumber(value / 1000, 2)} s`;
}

function summarize(result, label) {
  const turns = (result.turns || []).map((turn) => ({
    id: turn.id,
    checkpoint: turn.checkpoint,
    prompt: turn.prompt,
    answer: turn.response?.final_text || turn.response?.text || '',
    taskSuccess: turn.evaluation?.task_success === true,
    quality: finite(turn.evaluation?.quality_score),
    critical: turn.evaluation?.critical_error === true,
    failures: (turn.evaluation?.checks || []).filter((item) => item.core && !item.passed).map((item) => item.type),
    flaws: (turn.evaluation?.checks || []).filter((item) => !item.core && !item.passed).map((item) => item.type),
    costWarnings: turn.evaluation?.cost_warnings || [],
    ttft: turn.response?.timing?.first_visible_text_ms,
    e2e: turn.response?.timing?.end_to_end_ms,
    inputTokens:
      turn.usage?.summary?.totalInputTokens ?? turn.response?.model_metrics?.total_input_tokens,
    outputTokens:
      turn.usage?.summary?.totalOutputTokens ?? turn.response?.model_metrics?.total_output_tokens,
    modelCalls:
      turn.usage?.summary?.modelCallCount ?? turn.response?.model_metrics?.model_call_count,
    toolCalls: turn.response?.tool_metrics?.call_count ?? turn.response?.tool_calls?.length ?? 0,
    toolErrors: turn.response?.tool_metrics?.error_count ?? 0,
    tools: (turn.response?.tool_calls || []).map((call) => ({
      name: call.toolName,
      input: call.input,
    })),
  }));
  return {
    label,
    agentName: result.run?.agent?.name,
    model: result.run?.agent?.model,
    source: result.__source,
    turns,
    summary: {
      successes: turns.filter((turn) => turn.taskSuccess).length,
      averageQuality: average(turns.map((turn) => turn.quality)),
      criticalErrors: turns.filter((turn) => turn.critical).length,
      inputTokens: turns.reduce((sum, turn) => sum + finite(turn.inputTokens), 0),
      outputTokens: turns.reduce((sum, turn) => sum + finite(turn.outputTokens), 0),
      modelCalls: turns.reduce((sum, turn) => sum + finite(turn.modelCalls), 0),
      toolCalls: turns.reduce((sum, turn) => sum + finite(turn.toolCalls), 0),
      toolErrors: turns.reduce((sum, turn) => sum + finite(turn.toolErrors), 0),
      e2e: turns.reduce((sum, turn) => sum + finite(turn.e2e), 0),
      averageTtft: average(turns.map((turn) => turn.ttft)),
    },
  };
}

function decision(left, right) {
  const qualified = (item) =>
    item.summary.successes === item.turns.length &&
    item.summary.averageQuality >= 80 &&
    item.summary.criticalErrors === 0;
  const lq = qualified(left);
  const rq = qualified(right);
  if (lq !== rq) return { preferred: lq ? left.label : right.label, reason: '只有该应用通过全部三轮业务质量门槛。' };
  if (left.summary.successes !== right.summary.successes) {
    return {
      preferred: left.summary.successes > right.summary.successes ? left.label : right.label,
      reason: '优先选择核心任务成功轮次更多的应用。',
    };
  }
  if (left.summary.averageQuality !== right.summary.averageQuality) {
    return {
      preferred: left.summary.averageQuality > right.summary.averageQuality ? left.label : right.label,
      reason: '核心成功持平，优先选择平均质量更高的应用。',
    };
  }
  if (left.summary.inputTokens !== right.summary.inputTokens) {
    return {
      preferred: left.summary.inputTokens < right.summary.inputTokens ? left.label : right.label,
      reason: '业务质量持平，优先选择累计输入 Token 更少的应用。',
    };
  }
  return {
    preferred: left.summary.e2e <= right.summary.e2e ? left.label : right.label,
    reason: '业务质量和 Token 成本持平，使用端到端耗时决胜。',
  };
}

function metricRows(left, right) {
  return left.turns
    .map((turn, index) => {
      const other = right.turns[index] || {};
      const row = (item, label) => `<tr><td>${escapeHtml(turn.checkpoint)}</td><td>${escapeHtml(label)}</td>
        <td>${item.taskSuccess ? '通过' : '失败'}</td><td>${formatNumber(item.quality)}</td>
        <td>${formatDuration(item.ttft)}</td><td>${formatDuration(item.e2e)}</td>
        <td>${formatNumber(item.inputTokens)}</td><td>${formatNumber(item.outputTokens)}</td>
        <td>${formatNumber(item.modelCalls)}</td><td>${formatNumber(item.toolCalls)} / ${formatNumber(item.toolErrors)}</td></tr>`;
      return row(turn, left.label) + row(other, right.label);
    })
    .join('');
}

function diagnostics(left, right) {
  return left.turns
    .map((turn, index) => {
      const other = right.turns[index] || {};
      const cell = (item) => {
        const issues = [...(item.failures || []), ...(item.flaws || []), ...(item.costWarnings || [])];
        return issues.length ? issues.map(escapeHtml).join('、') : '无';
      };
      return `<tr><td>${escapeHtml(turn.checkpoint)}</td><td>${cell(turn)}</td><td>${cell(other)}</td></tr>`;
    })
    .join('');
}

function answers(left, right) {
  return left.turns
    .map((turn, index) => {
      const other = right.turns[index] || {};
      return `<details><summary>${escapeHtml(turn.checkpoint)} · 第 ${index + 1} 轮</summary>
        <div class="prompt"><strong>用户：</strong><pre>${escapeHtml(turn.prompt)}</pre></div>
        <div class="answers"><article><h3>${escapeHtml(left.label)}</h3><pre>${escapeHtml(turn.answer)}</pre></article>
        <article><h3>${escapeHtml(right.label)}</h3><pre>${escapeHtml(other.answer)}</pre></article></div></details>`;
    })
    .join('');
}

function toolTrace(left, right) {
  const rows = [];
  for (const candidate of [left, right]) {
    for (const turn of candidate.turns) {
      turn.tools.forEach((tool, index) => {
        rows.push(`<tr><td>${escapeHtml(candidate.label)}</td><td>${escapeHtml(turn.checkpoint)}</td><td>${index + 1}</td><td>${escapeHtml(tool.name)}</td><td><code>${escapeHtml(JSON.stringify(tool.input))}</code></td></tr>`);
      });
    }
  }
  return rows.join('');
}

function buildHtml(left, right, verdict, generatedAt, jsonName) {
  const l = left.summary;
  const r = right.summary;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>出行助手 Agent 应用对比</title><style>
  :root{color-scheme:dark;--bg:#091019;--panel:#111b27;--line:#2b3b4d;--text:#e3edf7;--muted:#91a6bb;--cyan:#5eead4;--blue:#67b7ff;--green:#4ade80;--red:#fb7185}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,sans-serif}main{max-width:1450px;margin:auto;padding:42px 28px}h1{font-size:40px;margin:8px 0}h2{margin-top:36px}.eyebrow{color:var(--cyan);font-family:monospace}.lead{color:var(--muted);font-size:17px}.banner{margin:24px 0;padding:20px;border:1px solid var(--cyan);background:#0c2025}.banner strong{font-size:22px}.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.card,article,details,.prompt{background:var(--panel);border:1px solid var(--line);padding:16px}.metric{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:16px}.metric div{background:var(--panel);border:1px solid var(--line);padding:12px}.metric small{display:block;color:var(--muted)}table{width:100%;border-collapse:collapse;background:var(--panel)}th,td{padding:10px;border:1px solid var(--line);vertical-align:top}th{color:var(--muted);text-align:left}.answers{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;font:12px/1.55 ui-monospace,monospace}details{margin:10px 0}summary{cursor:pointer;font-weight:700}code{white-space:pre-wrap;color:#c9e6ff}.ok{color:var(--green)}.bad{color:var(--red)}a{color:var(--blue)}@media(max-width:850px){.cards,.answers,.metric{grid-template-columns:1fr}}
  </style></head><body><main><div class="eyebrow">A3B / SAME MODEL / APPLICATION COMPARISON</div><h1>出行助手 Agent 应用对比</h1>
  <p class="lead">固定同一 A3b 模型与同一三轮场景，比较两个 Agent 应用的上下文管理、Skill 选择、工具编排、事实落地、响应成本和安全轨迹。</p>
  <div class="banner"><strong>当前优先：${escapeHtml(verdict.preferred)}</strong><p>${escapeHtml(verdict.reason)}</p></div>
  <div class="cards"><div class="card"><h3>${escapeHtml(left.label)}</h3><p>Agent：${escapeHtml(left.agentName)}<br>Model：${escapeHtml(left.model)}</p></div><div class="card"><h3>${escapeHtml(right.label)}</h3><p>Agent：${escapeHtml(right.agentName)}<br>Model：${escapeHtml(right.model)}</p></div></div>
  <div class="metric"><div><small>成功轮次</small>${l.successes}/3 vs ${r.successes}/3</div><div><small>平均质量</small>${formatNumber(l.averageQuality,1)} vs ${formatNumber(r.averageQuality,1)}</div><div><small>输入 Token</small>${formatNumber(l.inputTokens)} vs ${formatNumber(r.inputTokens)}</div><div><small>总 E2E</small>${formatDuration(l.e2e)} vs ${formatDuration(r.e2e)}</div><div><small>模型调用</small>${l.modelCalls} vs ${r.modelCalls}</div><div><small>工具 / 错误</small>${l.toolCalls}/${l.toolErrors} vs ${r.toolCalls}/${r.toolErrors}</div></div>
  <h2>三轮指标</h2><table><thead><tr><th>上下文</th><th>应用</th><th>任务</th><th>质量</th><th>可见 TTFT</th><th>E2E</th><th>Input</th><th>Output</th><th>模型调用</th><th>工具/错误</th></tr></thead><tbody>${metricRows(left,right)}</tbody></table>
  <h2>评分诊断</h2><table><thead><tr><th>上下文</th><th>${escapeHtml(left.label)}</th><th>${escapeHtml(right.label)}</th></tr></thead><tbody>${diagnostics(left,right)}</tbody></table>
  <h2>工具调用轨迹</h2><table><thead><tr><th>应用</th><th>上下文</th><th>#</th><th>工具</th><th>参数（已脱敏）</th></tr></thead><tbody>${toolTrace(left,right)}</tbody></table>
  <h2>连续三轮最终回答</h2>${answers(left,right)}
  <p>生成时间：${escapeHtml(generatedAt)} · <a href="./${encodeURI(jsonName)}">结构化报告 JSON</a></p></main></body></html>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [leftRaw, rightRaw] = await Promise.all([
    fs.readFile(args.left, 'utf8').then(JSON.parse),
    fs.readFile(args.right, 'utf8').then(JSON.parse),
  ]);
  leftRaw.__source = args.left;
  rightRaw.__source = args.right;
  const left = summarize(leftRaw, args.leftLabel);
  const right = summarize(rightRaw, args.rightLabel);
  const verdict = decision(left, right);
  const generatedAt = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'long',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  }).format(new Date());
  const dataPath = args.output.replace(/\.html$/u, '.json');
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(
    dataPath,
    `${JSON.stringify({ generatedAt, scenario: leftRaw.run?.scenario, verdict, applications: [left, right] }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(args.output, buildHtml(left, right, verdict, generatedAt, path.basename(dataPath)), 'utf8');
  process.stdout.write(`Report: ${args.output}\nData: ${dataPath}\nPreferred: ${verdict.preferred}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

