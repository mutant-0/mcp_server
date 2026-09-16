// Entry point the Apps SDK DNA import component calls to parse a raw DNA file.
//
// Parsing is preferred in a Web Worker so a multi-hundred-megabyte WGS file is
// read off the UI thread, and so the read keeps running when the host tab is in
// the background (the cooperative reader yields through `setTimeout`, which
// browsers throttle in background tabs). The worker is built as a separate script
// and embedded here as a build-time constant by scripts/build-ui.mjs, then started
// from a `blob:` URL.
//
// A worker is never required. MCP Apps resources cannot declare a `worker-src`
// CSP directive (`_meta.ui.csp` only covers connect/resource/frame/baseUri
// domains), so a host may well block a `blob:` worker, and `new Worker()`
// succeeding proves only that the constructor ran. Every failure mode - no
// worker support, a blocked script, a file that cannot be cloned into a worker -
// falls back transparently to the same parser on the main thread. That fallback
// is why the plan allows the component to work under an empty CSP at all.

import { parseDnaFileCore } from "./parseCore.js";
import {
  WORKER_ERROR_TYPE,
  WORKER_PARSE_TYPE,
  WORKER_PROGRESS_TYPE,
  WORKER_READY_TYPE,
  WORKER_RESULT_TYPE,
} from "./worker-protocol.js";

/**
 * The worker script, inlined by scripts/build-ui.mjs via an esbuild `define`.
 * The `typeof` guard keeps an unbundled import (tests, tooling) working: it
 * degrades to the main-thread path instead of throwing a ReferenceError.
 */
const WORKER_SOURCE =
  typeof __DNA_IMPORT_WORKER_SOURCE__ === "string" ? __DNA_IMPORT_WORKER_SOURCE__ : "";

/**
 * How long the worker gets to announce itself before the main thread takes over.
 * Construction cannot detect a CSP-blocked script, so the budget is deliberately
 * short: it is only paid by hosts that were going to fall back anyway.
 */
const WORKER_READY_TIMEOUT_MS = 1500;

let nextJobId = 0;

function abortError() {
  if (typeof DOMException === "function") return new DOMException("Aborted", "AbortError");
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/** Diagnostics only: never pass genotypes, catalog entries, or file contents. */
function debug(reason, detail) {
  if (typeof console === "undefined" || typeof console.debug !== "function") return;
  console.debug(`[dna-import] ${reason}`, detail === undefined ? "" : detail);
}

function terminate(worker) {
  try {
    worker.terminate();
  } catch {
    // Already gone; nothing to clean up.
  }
}

function revoke(url) {
  if (!url) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // The host may not implement revocation; the URL is inert either way.
  }
}

/**
 * Resolve `true` once the worker completes its readiness handshake, `false` when
 * it errors first, when the request is cancelled, or when it stays silent past
 * the timeout.
 */
function waitForReady(worker, signal) {
  return new Promise((resolve) => {
    let settled = false;

    function finish(ready) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(ready);
    }

    function onMessage(event) {
      const message = event.data || {};
      if (message.type === WORKER_READY_TYPE) finish(true);
    }

    function onError() {
      finish(false);
    }

    // Cancellation must be honoured while the handshake is still pending: a
    // blocked worker would otherwise hold the caller for the whole timeout.
    function onAbort() {
      finish(false);
    }

    const timer = setTimeout(() => finish(false), WORKER_READY_TIMEOUT_MS);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Start a worker and wait until it is proven to be executing.
 *
 * @returns {Promise<Worker|null>} the ready worker, or null when the caller must
 *   either parse on the main thread or give up (a cancelled signal).
 */
async function startWorker(signal) {
  if (!WORKER_SOURCE) {
    debug("no worker script in this build; parsing on the main thread");
    return null;
  }
  if (
    typeof Worker === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    debug("Web Workers or object URLs unavailable; parsing on the main thread");
    return null;
  }

  let url = null;
  let worker;
  try {
    url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    // A blob: worker inherits the app document's policy, which may block it.
    worker = new Worker(url);
  } catch (err) {
    debug("worker construction was rejected; parsing on the main thread", err);
    revoke(url);
    return null;
  }

  const ready = await waitForReady(worker, signal);
  // The script has been fetched by now, so the object URL has done its job. It is
  // revoked after the handshake rather than before, so a slow host still has a
  // chance to load it.
  revoke(url);

  if (!ready) {
    debug("worker never completed its startup handshake; parsing on the main thread");
    terminate(worker);
    return null;
  }
  return worker;
}

/**
 * Parse a raw DNA file, in a worker when the host allows one.
 *
 * @param {File} file - raw file chosen by the user.
 * @param {object} options
 * @param {object} options.catalog - SNP catalog from `get_snp_catalog`.
 * @param {(percent: number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function parseDnaFile(file, { catalog, onProgress, signal } = {}) {
  if (signal && signal.aborted) throw abortError();

  const worker = await startWorker(signal);
  if (!worker) {
    // A cancellation during startup must not quietly become a main-thread parse.
    if (signal && signal.aborted) throw abortError();
    return parseDnaFileCore(file, { catalog, onProgress, signal, cooperative: true });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let sawWorkerMessage = false;

    function cleanup() {
      terminate(worker);
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }

    function onAbort() {
      settle(reject, abortError());
    }

    /**
     * The worker died without producing anything, so nothing has been parsed and
     * restarting on the main thread cannot rewind visible progress.
     */
    function parseOnMainThread() {
      debug("worker produced no output; parsing on the main thread");
      settled = true;
      cleanup();
      parseDnaFileCore(file, { catalog, onProgress, signal, cooperative: true }).then(
        resolve,
        reject,
      );
    }

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === WORKER_PROGRESS_TYPE) {
        sawWorkerMessage = true;
        if (typeof onProgress === "function") onProgress(message.progress);
        return;
      }
      if (message.type === WORKER_RESULT_TYPE) {
        sawWorkerMessage = true;
        settle(resolve, message.result);
        return;
      }
      if (message.type === WORKER_ERROR_TYPE) {
        sawWorkerMessage = true;
        settle(reject, new Error(message.error || "DNA parsing failed"));
      }
    };

    worker.onerror = (event) => {
      if (!sawWorkerMessage && !settled) {
        parseOnMainThread();
        return;
      }
      // Past the first message this is a real parse failure. Re-running it here
      // would restart progress from zero and hide the original cause.
      settle(reject, new Error((event && event.message) || "DNA parsing worker failed"));
    };

    try {
      worker.postMessage({
        type: WORKER_PARSE_TYPE,
        jobId: `job-${(nextJobId += 1)}`,
        file,
        catalog: catalog || {},
      });
    } catch (err) {
      // e.g. DataCloneError: this host cannot move the File into a worker.
      debug("posting the file to the worker failed; parsing on the main thread", err);
      parseOnMainThread();
    }
  });
}
