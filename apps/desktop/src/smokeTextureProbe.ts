/** Only public, app-owned image blobs observed in the throwaway smoke renderer may be probed. */
export function failedTextureUrls(messages: readonly string[]): string[] {
  const urls = messages.flatMap(message => message.match(/blob:extalia:\/\/app\/[a-f0-9-]{36}(?![a-f0-9-])/gi) ?? []);
  return [...new Set(urls)].slice(0, 8);
}

/** Diagnostic reads never repair a model or clear its original error. No filesystem/network URL is accepted. */
export function textureProbeScript(messages: readonly string[]): string {
  return `(async () => {
    const results = [];
    for (const url of ${JSON.stringify(failedTextureUrls(messages))}) {
      const controller = new AbortController();
      let stage = 'fetch';
      const record = { url };
      let timer;
      try {
        const work = (async () => {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error('Image blob response ' + response.status);
          const blob = await response.blob();
          record.bytes = blob.size;
          record.mime = blob.type;
          record.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(x => x.toString(16).padStart(2, '0')).join('');
          stage = 'decode';
          const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          record.width = bitmap.width;
          record.height = bitmap.height;
          bitmap.close();
          return 'decodes-on-probe';
        })();
        record.result = await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Image probe deadline')), 5000); })]);
      } catch (error) {
        record.stage = stage;
        record.error = String(error?.name || 'Error') + ': ' + String(error?.message || error).slice(0, 300);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      results.push(record);
    }
    return results;
  })()`;
}
