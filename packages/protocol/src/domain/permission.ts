/** 用户可见的统一信任模式。持久化层仍兼容历史三档 sandbox 值。 */
export const PERMISSION_PRESETS = ['approval-required', 'guarded', 'full-access'] as const;

export type PermissionPreset = (typeof PERMISSION_PRESETS)[number];

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

export type SandboxMode = (typeof SANDBOX_MODES)[number];

export type StoredPermissionPreset = SandboxMode;

export function permissionPresetFromStorage(
  value: StoredPermissionPreset | null | undefined,
): PermissionPreset {
  if (value === 'read-only') return 'approval-required';
  if (value === 'danger-full-access') return 'full-access';
  return 'guarded';
}

export function permissionPresetToStorage(value: PermissionPreset): StoredPermissionPreset {
  if (value === 'approval-required') return 'read-only';
  if (value === 'full-access') return 'danger-full-access';
  return 'workspace-write';
}

export function sandboxModeForPermissionPreset(value: PermissionPreset): SandboxMode {
  return value === 'full-access' ? 'danger-full-access' : 'workspace-write';
}

export const TOOL_APPROVAL_POLICIES = ['never', 'always'] as const;

export type ToolApprovalPolicy = (typeof TOOL_APPROVAL_POLICIES)[number];

export type StoredToolApprovalPolicy = ToolApprovalPolicy | 'first-use';

export function toolApprovalPolicyFromStorage(
  value: StoredToolApprovalPolicy | null | undefined,
): ToolApprovalPolicy {
  return value === 'never' ? 'never' : 'always';
}

export type ApprovalResolution =
  'allowed-once' | 'session-granted' | 'rejected' | 'cancelled' | 'unavailable';
