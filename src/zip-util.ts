import { requestUrl } from 'obsidian';

/**
 * Download a zip file from a url and return the bytes of the file as an ArrayBuffer.
 * @param url String url of the zip file to download.
 * @returns ArrayBuffer of the zip file.
 *
 * 归档下载后直接写入磁盘，由 `ZipSource` 按需读取其中的条目，不再在此解包。
 * The archive is written to disk and read entry by entry through `ZipSource`; nothing is
 * unpacked here.
 */
export const downloadZipFile = async (url: string): Promise<ArrayBuffer> => {
  const fetched = await requestUrl({ url });
  const bytes = fetched.arrayBuffer;
  return bytes;
};
