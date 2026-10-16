import { describe, expect, it } from 'vitest';
import type { RuntimeProjection } from '../../packages/protocol/src/client';
import {
  producedFilesForMessage,
  resolveProducedFileMention,
} from '../../packages/app-ui/src/produced-files';

describe('结构化产出文件提及', () => {
  it('只解析精确路径或唯一文件名', () => {
    const paths = ['artifacts/report.html', 'src/result.json'];
    expect(resolveProducedFileMention(paths, 'artifacts/report.html')).toBe('artifacts/report.html');
    expect(resolveProducedFileMention(paths, 'report.html')).toBe('artifacts/report.html');
    expect(resolveProducedFileMention(paths, '/internal/workspace/artifacts/report.html')).toBe(
      'artifacts/report.html',
    );
    expect(resolveProducedFileMention(paths, 'missing.html')).toBeUndefined();
  });

  it('同名文件不猜测', () => {
    const paths = ['artifacts/report.html', 'output/report.html'];
    expect(resolveProducedFileMention(paths, 'report.html')).toBeUndefined();
  });

  it('只收集当前轮次、已成功且早于收尾消息的 locations', () => {
    const projection = {
      toolCalls: new Map([
        [
          'write-1',
          {
            id: 'write-1',
            turnId: 'turn-1',
            status: 'success',
            resultSeq: 5,
            presentation: {
              status: 'success',
              locations: [{ path: 'artifacts/report.html' }],
            },
          },
        ],
        [
          'late',
          {
            id: 'late',
            turnId: 'turn-1',
            status: 'success',
            resultSeq: 9,
            presentation: { status: 'success', locations: [{ path: 'late.txt' }] },
          },
        ],
      ]),
    } as unknown as RuntimeProjection;

    expect(producedFilesForMessage(projection, 'turn-1', 8)).toEqual([
      'artifacts/report.html',
    ]);
  });
});
