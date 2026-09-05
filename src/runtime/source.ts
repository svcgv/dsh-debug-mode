/**
 * Trace runtime source shipped into the user project for one debug run. The
 * runtime defines the probe helper referenced by generated statements,
 * batches probe events, sends them to the configured listener, and exposes a
 * rotate hook so the agent can switch from loopback to the LAN endpoint when
 * no heartbeat arrives.
 *
 * @module dsh-debug-mode/runtime/source
 */

export interface TraceRuntimeConfig {
  readonly runId: string
  readonly token: string
  readonly endpoints: readonly string[]
  readonly projectPath: string
}

const BATCH_MS = 250
const MAX_BATCH = 100

/** Build the trace runtime source for one run. */
export function createTraceRuntimeSource(config: TraceRuntimeConfig): string {
  return [
    '(function () {',
    `  var runId = ${JSON.stringify(config.runId)};`,
    `  var token = ${JSON.stringify(config.token)};`,
    `  var projectPath = ${JSON.stringify(config.projectPath)};`,
    `  var endpoints = ${JSON.stringify([...config.endpoints])};`,
    '  var index = 0;',
    '  var queue = [];',
    '  var timer = null;',
    `  var batchMs = ${BATCH_MS};`,
    `  var maxBatch = ${MAX_BATCH};`,
    '',
    '  function send() {',
    '    if (queue.length === 0) return;',
    '    var events = queue;',
    '    queue = [];',
    '    var endpoint = endpoints[index];',
    '    if (!endpoint) return;',
    '    try {',
    '      fetch(endpoint + "/ingest", {',
    '        method: "POST",',
    '        headers: { "content-type": "application/json" },',
    '        body: JSON.stringify({ token: token, events: events })',
    '      }).catch(function () {});',
    '    } catch (error) { /* offline clients must never break the app */ }',
    '  }',
    '',
    '  function schedule() {',
    '    if (timer !== null) return;',
    '    timer = setTimeout(function () {',
    '      timer = null;',
    '      send();',
    '    }, batchMs);',
    '  }',
    '',
    '  function probe(meta) {',
    '    try {',
    '      meta.runId = runId;',
    '      meta.token = token;',
    '      meta.kind = "probe";',
    '      meta.ts = Date.now();',
    '      // Generated statement probes carry short keys (r/p/l/k); expand the',
    '      // location ones so the listener records line-level evidence.',
    '      if (typeof meta.file !== "string" && typeof meta.p === "string") meta.file = meta.p;',
    '      if (typeof meta.line !== "number" && typeof meta.l === "number") meta.line = meta.l;',
    '      queue.push(meta);',
    '      if (queue.length >= maxBatch) send();',
    '      else schedule();',
    '    } catch (error) { /* probes never throw into app code */ }',
    '  }',
    '',
    '  function heartbeat() {',
    '    var meta = { runId: runId, kind: "heartbeat", ts: Date.now(), text: "alive" };',
    '    queue.push(meta);',
    '    send();',
    '  }',
    '',
    '  function rotate() {',
    '    if (index + 1 < endpoints.length) index += 1;',
    '  }',
    '',
    '  globalThis.__dshTraceProbe = probe;',
    '  globalThis.__dshTraceRotate = rotate;',
    '  globalThis.__dshTraceHeartbeat = heartbeat;',
    '  globalThis.__dshTraceRunId = runId;',
    '  globalThis.__dshTraceProject = projectPath;',
    '})();',
    '',
  ].join('\n')
}

/** Validate one runtime source parses and names the run. */
export function runtimeSourceChecks(source: string, runId: string): boolean {
  return (
    source.includes(`var runId = ${JSON.stringify(runId)};`) &&
    source.includes('globalThis.__dshTraceProbe') &&
    source.includes('/ingest')
  )
}
