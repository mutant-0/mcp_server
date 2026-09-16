// Message protocol shared by the DNA parser worker and its client.
//
// The worker is built as a separate script by scripts/build-ui.mjs, so this
// module is the only thing the two sides have in common. Keeping the message
// types here (rather than as literals on both sides) is what stops the startup
// handshake from silently drifting: a mismatch would just look like a worker
// that never becomes ready.

/** Bumped whenever the message shapes below change incompatibly. */
export const WORKER_PROTOCOL_VERSION = 1;

/** Worker -> client, once the script is executing. Completes the startup handshake. */
export const WORKER_READY_TYPE = "ready";

/** Client -> worker, starts a parse. */
export const WORKER_PARSE_TYPE = "parse";

/** Worker -> client, 0-100 based on bytes read. */
export const WORKER_PROGRESS_TYPE = "progress";

/** Worker -> client, the normalized parse result. */
export const WORKER_RESULT_TYPE = "result";

/** Worker -> client, the parse failed. */
export const WORKER_ERROR_TYPE = "error";
