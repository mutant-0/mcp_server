// GENERATED FILE - DO NOT EDIT.
// Vendored from front-end-web/src/genomics by scripts/sync-genomics.mjs.
// Edit the upstream module (and re-run sync:genomics) instead.
// Memory-bounded line streaming over the Streams API.
//
// Gzip decompression uses fflate's Gunzip rather than the native
// DecompressionStream, because the spec limits DecompressionStream to a single
// gzip member and throws on trailing data. bgzip/tabix-indexed .vcf.gz and
// .vcf.bgz files (common from WGS providers) are concatenated gzip members,
// which fflate handles natively.

import { Gunzip } from 'fflate';

export function supportsStreaming() {
  return (
    typeof File !== 'undefined' &&
    typeof File.prototype.stream === 'function' &&
    typeof TransformStream === 'function' &&
    typeof TextDecoder === 'function'
  );
}

const GZIP_MAGIC = [0x1f, 0x8b];

async function isGzipFile(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    return head.length >= 2 && head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
  } catch {
    return false;
  }
}

// Cooperative scheduling so that decompressing + parsing a large file (a WGS
// .vcf.gz can be hundreds of MB and millions of lines) never starves the main
// thread. `yield` from an async generator only suspends to the consumer; it does
// NOT hand control back to the browser. Without periodic macrotask turns the tab
// stops painting/responding and the browser raises "Page Unresponsive".
//
// We check the clock every N lines (cheap) and, once at least YIELD_INTERVAL_MS
// has elapsed, await a setTimeout(0) macrotask so input/paint can run.
const YIELD_CHECK_EVERY_LINES = 512;
const YIELD_INTERVAL_MS = 24;

const nowMs = () =>
  (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

// Returns a promise to await when we should yield, otherwise null (no async
// overhead on the hot per-line path).
function createMainThreadYielder() {
  let sinceCheck = 0;
  let lastYield = nowMs();
  return () => {
    sinceCheck += 1;
    if (sinceCheck < YIELD_CHECK_EVERY_LINES) return null;
    sinceCheck = 0;
    if (nowMs() - lastYield < YIELD_INTERVAL_MS) return null;
    lastYield = nowMs();
    return new Promise((resolve) => setTimeout(resolve, 0));
  };
}

// Yields one line at a time (LF-normalized, trailing \r stripped, BOM stripped
// from the first line). `onProgress` receives 0-100 based on raw bytes read.
//
// When `cooperative` is false, main-thread yielding is disabled so the loop runs
// as a tight, timer-free iteration. This is intended for use inside a Web Worker,
// where there is no UI thread to keep responsive and where setTimeout is throttled
// in background tabs.
export async function* readLines(file, { onProgress, signal, cooperative = true } = {}) {
  const total = file.size || 0;
  let readBytes = 0;

  // Detect gzip by magic bytes, not extension, so mislabeled files still work.
  const isGz = await isGzipFile(file);

  const counter = new TransformStream({
    transform(chunk, controller) {
      readBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });

  const rawReader = file.stream().pipeThrough(counter).getReader();
  const decoder = new TextDecoder('utf-8');
  const maybeYield = cooperative ? createMainThreadYielder() : () => null;
  let buffer = '';
  let first = true;

  // Decode a byte chunk and split out any complete lines into a returned array.
  const drain = (bytes) => {
    const lines = [];
    buffer += decoder.decode(bytes, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (first) {
        line = line.replace(/^\uFEFF/, '');
        first = false;
      }
      lines.push(line);
    }
    return lines;
  };

  try {
    if (!isGz) {
      while (true) {
        const { done, value } = await rawReader.read();
        if (done) break;
        for (const line of drain(value)) {
          yield line;
          const pause = maybeYield();
          if (pause) await pause;
        }
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (onProgress && total) onProgress(Math.min(100, Math.round((readBytes / total) * 100)));
      }
    } else {
      const gunzip = new Gunzip();
      const pending = [];
      gunzip.ondata = (data) => {
        if (data && data.length) pending.push(data);
      };

      while (true) {
        const { done, value } = await rawReader.read();
        gunzip.push(done ? new Uint8Array(0) : new Uint8Array(value), done);
        while (pending.length) {
          for (const line of drain(pending.shift())) {
            yield line;
            const pause = maybeYield();
            if (pause) await pause;
          }
        }
        if (done) break;
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (onProgress && total) onProgress(Math.min(100, Math.round((readBytes / total) * 100)));
      }
    }

    // Flush any remaining decoded text.
    buffer += decoder.decode();
    if (buffer) {
      let line = buffer.replace(/\r$/, '');
      if (first) line = line.replace(/^\uFEFF/, '');
      yield line;
    }
  } finally {
    try { await rawReader.cancel(); } catch { /* ignore */ }
  }
}
