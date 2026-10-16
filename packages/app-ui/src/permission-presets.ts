import type { PermissionPreset } from '@client-contracts';

export const permissionOptions: Array<{
  value: PermissionPreset;
  label: string;
  description: string;
  rules: string[];
}> = [
  {
    value: 'approval-required',
    label: '请求批准',
    description: '工作区自动读写；外部写入、联网和 MCP 默认询问',
    rules: [
      '模型直接回答与规划，缺少任务信息时会询问。',
      '工作区内读写自动执行。',
      '外部写入、联网和 MCP 调用前请求批准。',
    ],
  },
  {
    value: 'guarded',
    label: '受控自动',
    description: '低风险自动执行；高风险操作请求批准',
    rules: [
      '模型可采用低风险的合理默认值。',
      '低风险工具自动执行。',
      '高风险操作请求批准，缺少必要信息时会询问。',
    ],
  },
  {
    value: 'full-access',
    label: '完全访问',
    description: '模型自主选择合理默认值，仅在缺少必需事实时询问',
    rules: [
      '偏好、方案、格式和可逆选择由模型决定。',
      '仅缺少不可推断且任务必需的事实时询问。',
      '工具按当前系统用户权限执行，不再逐次批准。',
      '密码、验证码和 API Key 不通过普通问题框收集。',
    ],
  },
];

export function permissionLabel(value: PermissionPreset): string {
  return permissionOptions.find((option) => option.value === value)?.label ?? '受控自动';
}
