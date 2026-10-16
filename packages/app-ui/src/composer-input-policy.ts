export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

export type AttachComposerFiles = (
  files: File[],
  draftText: string,
) => Promise<{ draftKey: string; paths: string[] } | null>;

export function shouldSubmitComposerOnKeyDown(input: ComposerKeyInput): boolean {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing && input.keyCode !== 229;
}
