// Web Worker entry for the Apps SDK DNA import component.
//
// Bundled as its own self-contained script by scripts/build-ui.mjs, then started
// from a `blob:` URL by parseFile.js. It runs the very same `parseDnaFileCore`
// the main-thread fallback runs, with `cooperative: false`: there is no UI
// thread in here to keep responsive, and `setTimeout` (which the cooperative
// reader yields through) is throttled in background tabs, so yielding would only
// make a long parse slower.
//
// Protocol, version 1 (see worker-protocol.js):
//   -> { type: "ready", protocol: 1 }
//   <- { type: "parse", jobId, file, catalog }
//   -> { type: "progress", jobId, progress }
//   -> { type: "result", jobId, result }
//   -> { type: "error", jobId, error }
//
// The first message is the handshake: the client refuses to use a worker that
// has not announced itself, because `new Worker()` succeeding proves only that
// the constructor ran, not that the script was allowed to execute.
//
// `file` is structured-cloneable wherever the Streams API the parser needs is
// available. An AbortSignal is not, so cancellation is expressed by the client
// terminating this worker.

import { parseDnaFileCore } from "./parseCore.js";
import {
  WORKER_ERROR_TYPE,
  WORKER_PARSE_TYPE,
  WORKER_PROGRESS_TYPE,
  WORKER_PROTOCOL_VERSION,
  WORKER_READY_TYPE,
  WORKER_RESULT_TYPE,
} from "./worker-protocol.js";

self.postMessage({ type: WORKER_READY_TYPE, protocol: WORKER_PROTOCOL_VERSION });

self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type !== WORKER_PARSE_TYPE) return;

  const { file, catalog, jobId } = data;
  if (!file) {
    self.postMessage({
      type: WORKER_ERROR_TYPE,
      jobId,
      error: "No file received by the DNA parser worker.",
    });
    return;
  }

  try {
    const result = await parseDnaFileCore(file, {
      catalog: catalog || {},
      cooperative: false,
      onProgress: (progress) => self.postMessage({ type: WORKER_PROGRESS_TYPE, jobId, progress }),
    });
    self.postMessage({ type: WORKER_RESULT_TYPE, jobId, result });
  } catch (err) {
    self.postMessage({
      type: WORKER_ERROR_TYPE,
      jobId,
      error: err && err.message ? err.message : String(err),
    });
  }
};
