/**
 * Trace runtime source shipped into the user project for one debug run. The
 * runtime defines the probe helper referenced by generated statements and
 * delivers bounded evidence either to the application's local log or to an
 * explicitly selected listener.
 *
 * @module dsh-debug-mode/runtime/source
 */

/** Local-log runtime configuration. */
export interface LocalLogTraceRuntimeConfig {
  readonly transport: 'local-log'
  readonly runId: string
  readonly projectPath: string
}

/** Listener runtime configuration. */
export interface ListenerTraceRuntimeConfig {
  readonly transport: 'listener'
  readonly runId: string
  readonly token: string
  readonly endpoints: readonly string[]
  readonly projectPath: string
}

/** One trace-delivery configuration selected for a frontend run. */
export type TraceRuntimeConfig = LocalLogTraceRuntimeConfig | ListenerTraceRuntimeConfig

const BATCH_MS = 250
const MAX_BATCH = 100
const MAX_LOCAL_LOG_CHARS = 8 * 1024

function commonHeader(config: TraceRuntimeConfig): string[] {
  return [
    '(function () {',
    `  var runId = ${JSON.stringify(config.runId)};`,
    `  var projectPath = ${JSON.stringify(config.projectPath)};`,
    '  var sensitiveKey = /secret|token|password|authorization|cookie|key/i;',
    '  var maxDepth = 4;',
    '  var maxProperties = 40;',
    '  var maxArrayItems = 40;',
    '  var maxStringChars = 512;',
    '',
    '  function recordError(code) {',
    '    globalThis.__dshTraceLastError = { runId: runId, code: code, ts: Date.now() };',
    '  }',
    '',
    '  function sanitize(value, depth, seen, redacted) {',
    '    if (value === null || typeof value === "boolean") return value;',
    '    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);',
    '    if (typeof value === "string") {',
    '      return value.length <= maxStringChars ? value : value.slice(0, maxStringChars) + "…[truncated]";',
    '    }',
    '    if (typeof value === "undefined") return "[Undefined]";',
    '    if (typeof value === "bigint") return String(value) + "n";',
    '    if (typeof value === "symbol") return "[Symbol]";',
    '    if (typeof value === "function") return "[Function]";',
    '    if (depth >= maxDepth) return "[MaxDepth]";',
    '    if (seen.indexOf(value) !== -1) return "[Circular]";',
    '    seen.push(value);',
    '    var descriptors;',
    '    try {',
    '      descriptors = Object.getOwnPropertyDescriptors(value);',
    '    } catch (error) {',
    '      seen.pop();',
    '      return "[Uninspectable]";',
    '    }',
    '    if (Array.isArray(value)) {',
    '      var array = [];',
    '      var lengthDescriptor = descriptors.length;',
    '      var arrayLength = lengthDescriptor && typeof lengthDescriptor.value === "number"',
    '        ? lengthDescriptor.value',
    '        : 0;',
    '      var arrayLimit = Math.min(arrayLength, maxArrayItems);',
    '      for (var arrayIndex = 0; arrayIndex < arrayLimit; arrayIndex += 1) {',
    '        var arrayDescriptor = descriptors[String(arrayIndex)];',
    '        if (!arrayDescriptor) array.push("[Empty]");',
    '        else if (Object.prototype.hasOwnProperty.call(arrayDescriptor, "value")) {',
    '          array.push(sanitize(arrayDescriptor.value, depth + 1, seen, redacted));',
    '        } else array.push("[Getter]");',
    '      }',
    '      if (arrayLength > arrayLimit) array.push("[TruncatedItems]");',
    '      seen.pop();',
    '      return array;',
    '    }',
    '    var output = {};',
    '    var keys = Object.keys(descriptors);',
    '    var propertyLimit = Math.min(keys.length, maxProperties);',
    '    for (var propertyIndex = 0; propertyIndex < propertyLimit; propertyIndex += 1) {',
    '      var key = keys[propertyIndex];',
    '      if (sensitiveKey.test(key)) {',
    '        output[key] = "[REDACTED]";',
    '        redacted.push(key);',
    '        continue;',
    '      }',
    '      var descriptor = descriptors[key];',
    '      output[key] = Object.prototype.hasOwnProperty.call(descriptor, "value")',
    '        ? sanitize(descriptor.value, depth + 1, seen, redacted)',
    '        : "[Getter]";',
    '    }',
    '    if (keys.length > propertyLimit) output.truncatedProperties = keys.length - propertyLimit;',
    '    seen.pop();',
    '    return output;',
    '  }',
    '',
    '  function prepare(meta, kind) {',
    '    var redacted = [];',
    '    var event = sanitize(meta, 0, [], redacted);',
    '    if (!event || typeof event !== "object" || Array.isArray(event)) event = { value: event };',
    '    event.runId = runId;',
    '    event.kind = kind;',
    '    event.ts = Date.now();',
    '    // Generated statement probes carry short keys (r/p/l/k); expand the',
    '    // location ones so either transport emits line-level evidence.',
    '    if (typeof event.file !== "string" && typeof event.p === "string") event.file = event.p;',
    '    if (typeof event.line !== "number" && typeof event.l === "number") event.line = event.l;',
    '    if (redacted.length > 0) event.redacted = redacted;',
    '    return event;',
    '  }',
    '',
  ]
}

function commonFooter(): string[] {
  return [
    '',
    '  globalThis.__dshTraceProbe = probe;',
    '  globalThis.__dshTraceHeartbeat = heartbeat;',
    '  globalThis.__dshTraceRunId = runId;',
    '  globalThis.__dshTraceProject = projectPath;',
    '  heartbeat();',
    '})();',
    '',
  ]
}

function localLogSource(config: LocalLogTraceRuntimeConfig): string {
  return [
    ...commonHeader(config),
    `  var prefix = ${JSON.stringify(`[dsh-debug:${config.runId}]`)};`,
    `  var maxLogChars = ${MAX_LOCAL_LOG_CHARS};`,
    '  var maxLogEvents = 1000;',
    '  var writtenEvents = 0;',
    '',
    '  function write(meta) {',
    '    if (writtenEvents >= maxLogEvents) {',
    '      recordError("LOCAL_LOG_EVENT_LIMIT");',
    '      return;',
    '    }',
    '    var target = globalThis.console;',
    '    if (!target || typeof target.log !== "function") {',
    '      recordError("LOCAL_LOG_UNAVAILABLE");',
    '      return;',
    '    }',
    '    var text;',
    '    try {',
    '      text = JSON.stringify(meta);',
    '    } catch (error) {',
    '      recordError("LOCAL_LOG_SERIALIZATION_FAILED");',
    '      text = JSON.stringify({ runId: runId, kind: "serialization-error", ts: Date.now() });',
    '    }',
    '    if (text.length > maxLogChars) {',
    '      text = JSON.stringify({',
    '        runId: runId,',
    '        kind: "truncated",',
    '        ts: Date.now(),',
    '        preview: text.slice(0, maxLogChars / 2)',
    '      });',
    '    }',
    '    target.log(prefix + " " + text);',
    '    writtenEvents += 1;',
    '  }',
    '',
    '  function probe(meta) {',
    '    try {',
    '      write(prepare(meta, "probe"));',
    '    } catch (error) {',
    '      recordError("LOCAL_LOG_WRITE_FAILED");',
    '    }',
    '  }',
    '',
    '  function heartbeat() {',
    '    try {',
    '      write(prepare({ text: "alive" }, "heartbeat"));',
    '    } catch (error) {',
    '      recordError("LOCAL_LOG_WRITE_FAILED");',
    '    }',
    '  }',
    ...commonFooter(),
  ].join('\n')
}

function listenerSource(config: ListenerTraceRuntimeConfig): string {
  return [
    ...commonHeader(config),
    `  var token = ${JSON.stringify(config.token)};`,
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
    '    if (!endpoint) {',
    '      recordError("LISTENER_ENDPOINT_UNAVAILABLE");',
    '      return;',
    '    }',
    '    try {',
    '      fetch(endpoint + "/ingest", {',
    '        method: "POST",',
    '        headers: { "content-type": "application/json" },',
    '        body: JSON.stringify({ token: token, events: events })',
    '      }).catch(function () { recordError("LISTENER_REQUEST_FAILED"); });',
    '    } catch (error) {',
    '      recordError("LISTENER_REQUEST_FAILED");',
    '    }',
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
    '      queue.push(prepare(meta, "probe"));',
    '      if (queue.length >= maxBatch) send();',
    '      else schedule();',
    '    } catch (error) {',
    '      recordError("LISTENER_QUEUE_FAILED");',
    '    }',
    '  }',
    '',
    '  function heartbeat() {',
    '    queue.push(prepare({ text: "alive" }, "heartbeat"));',
    '    send();',
    '  }',
    '',
    '  function rotate() {',
    '    if (index + 1 < endpoints.length) index += 1;',
    '  }',
    '',
    '  globalThis.__dshTraceRotate = rotate;',
    ...commonFooter(),
  ].join('\n')
}

/** Build the trace runtime source for one run. */
export function createTraceRuntimeSource(config: TraceRuntimeConfig): string {
  return config.transport === 'local-log' ? localLogSource(config) : listenerSource(config)
}

/** Validate one runtime source parses and names the run. */
export function runtimeSourceChecks(source: string, runId: string): boolean {
  return (
    source.includes(`var runId = ${JSON.stringify(runId)};`) &&
    source.includes('globalThis.__dshTraceProbe') &&
    source.includes('globalThis.__dshTraceHeartbeat') &&
    source.includes('heartbeat();')
  )
}
