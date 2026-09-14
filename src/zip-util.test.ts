import { vi, it, expect, describe, afterEach } from 'vitest';
import { downloadZipFile } from './zip-util';

const zipUrl = 'http://example.com/zip-file.zip';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('downloadZipFile', () => {
  it('should download a zip file and return an ArrayBuffer', async () => {
    vi.mock('obsidian', () => ({
      requestUrl: () => ({
        arrayBuffer: new ArrayBuffer(8),
      }),
    }));

    const result = await downloadZipFile(zipUrl);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(8);
  });
});
