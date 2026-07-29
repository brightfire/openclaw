# DEV-331 Gap Analysis — Secret Scrubbing in OTel Pipeline

**Date:** 2026-07-27
**Author:** Vash (subagent)
**Scope:** `extensions/diagnostics-otel/src/service.ts` (3704 lines)
**Related issues:** DEV-330 (policy), DEV-331 (implementation)

---

## Executive Summary

The core scrubbing layer (`redactSensitiveText` in `src/logging/redact.ts`) is comprehensive and already wired into the OTel pipeline through three primary gates:

1. **`redactOtelAttributes`** — scrubs all string values in span attribute maps, drops high-cardinality ID keys
2. **`normalizeOtelLogString`** — scrubs + truncates log body strings and content attribute values
3. **`lowCardinalityAttr` / `modelIdAttr` / `lowCardinalityQueueLaneAttr`** — scrubs + validates metric label values

However, there are **7 gaps** where content reaches OTel metric instruments or span creation without passing through any redaction gate. There is also **1 missing feature** (the scrubbing counter required by the DEV-330 policy doc).

---

## Covered Paths (Confirmed Redacted)

### Span Attributes — All paths through `spanWithDuration` or `setSpanAttrs`

| Path                                 | Redaction Gate                                                                            | Notes                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spanWithDuration(name, attrs, ...)` | `redactOtelAttributes(attributes)` at line 1790                                           | Primary span creation path. Drops DROPPED keys, redacts all string values.                                                                                        |
| `setSpanAttrs(span, attrs)`          | `redactOtelAttributes(attributes)` at line 1990                                           | Post-creation attribute updates. Same gate.                                                                                                                       |
| `addRunAttrs(spanAttrs, evt)`        | Values set raw, but `spanAttrs` passed to `spanWithDuration` or `setSpanAttrs` downstream | `evt.provider`, `evt.model`, `evt.channel`, `evt.trigger` are set raw in the attrs map, but the downstream `redactOtelAttributes` call scrubs them. ✓             |
| `addSessionAttrs(spanAttrs, evt)`    | Same — downstream `redactOtelAttributes`                                                  | `sessionId`, `sessionKey` set raw but DROPPED_OTEL_ATTRIBUTE_KEYS drops `openclaw.sessionKey` and `openclaw.sessionId` is kept (it's a UUID, not user content). ✓ |
| `assignOtelModelContentAttributes`   | `normalizeOtelContentValue` → `normalizeOtelLogString` → `redactSensitiveText`            | Content capture for model calls. ✓                                                                                                                                |
| `assignOtelToolContentAttributes`    | Same path                                                                                 | Content capture for tool calls. ✓                                                                                                                                 |
| `assignJsonAttribute`                | `safeJsonString` → `stringifyJsonForOtelAttribute` → `redactSensitiveText`                | JSON-serialized attributes. ✓                                                                                                                                     |
| `assignGenAiModelContentAttributes`  | `assignJsonAttribute` → same                                                              | GenAI semantic convention content. ✓                                                                                                                              |
| `addUpstreamRequestIdSpanEvent`      | `lowCardinalityAttr(hash)` → `redactSensitiveText`                                        | Span event with pre-redacted hash. ✓                                                                                                                              |

### Log Emission — `otelLogger.emit`

| Path                         | Redaction Gate                                                   | Notes                               |
| ---------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| Log body                     | `normalizeOtelLogString` at line 1686                            | Redacts + truncates to 4KB. ✓       |
| Log attributes (individual)  | `assignOtelLogAttribute` → `normalizeOtelLogString` at line 1020 | Redacts each string value. ✓        |
| Log attributes (from event)  | `assignOtelLogEventAttributes` → `assignOtelLogAttribute`        | Redacts values, validates keys. ✓   |
| Log attributes (final)       | `redactOtelAttributes(attributes)` at line 1715                  | Final redaction gate before emit. ✓ |
| Log attribute key validation | `redactSensitiveText(key) !== key` at line 1013                  | Drops keys that contain secrets. ✓  |

### Span Status Messages

| Path                                   | Redaction                                                     | Notes                            |
| -------------------------------------- | ------------------------------------------------------------- | -------------------------------- |
| `recordWebhookError` setStatus         | `redactedError = redactSensitiveText(evt.error)`              | ✓                                |
| `recordMessageProcessed` setStatus     | `redactSensitiveText(evt.error)`                              | ✓                                |
| `recordMessageDeliveryError` setStatus | `redactSensitiveText(evt.errorCategory)`                      | ✓                                |
| `recordRunCompleted` setStatus         | `redactSensitiveText(evt.errorCategory)`                      | ✓                                |
| `recordModelCallError` setStatus       | `redactSensitiveText(evt.errorCategory)`                      | ✓                                |
| `recordToolExecutionError` setStatus   | `redactSensitiveText(evt.errorCategory)`                      | ✓                                |
| `recordHarnessRunError` setStatus      | `errorType = lowCardinalityAttr(...)` → `redactSensitiveText` | ✓                                |
| `recordSessionStuck` setStatus         | `"session stuck"` (literal)                                   | ✓ (no user content)              |
| `recordToolLoop` setStatus             | `${evt.detector}:${evt.action}`                               | Enum values, not user content. ✓ |
| `recordMemoryPressure` setStatus       | `evt.reason`                                                  | **See Gaps**                     |
| `recordLivenessWarning` setStatus      | `reason = evt.reasons.join(":")`                              | **See Gaps**                     |
| `recordExecProcessCompleted` setStatus | `evt.failureKind`                                             | Enum value, not user content. ✓  |
| `recordHarnessRunCompleted` setStatus  | `"error"` (literal)                                           | ✓                                |

### Metric Labels — Properly Redacted

| Path                                 | Redaction Gate                                                          | Notes |
| ------------------------------------ | ----------------------------------------------------------------------- | ----- |
| `harnessRunMetricAttrs`              | `lowCardinalityAttr` on all string values                               | ✓     |
| `talkEventAttrs`                     | `lowCardinalityAttr` on all values                                      | ✓     |
| `skillUsedAttrs`                     | `lowCardinalityAttr` on all values                                      | ✓     |
| `toolLoopAttrs`                      | `lowCardinalityAttr` on toolName, enum values for level/action/detector | ✓     |
| `messageDeliveryAttrs`               | `lowCardinalityAttr` on channel, deliveryKind                           | ✓     |
| `sessionRecoveryAttrs`               | `redactSensitiveText` on reason                                         | ✓     |
| `recordLaneEnqueue/Dequeue`          | `lowCardinalityQueueLaneAttr`                                           | ✓     |
| `recordLivenessWarning` metric attrs | `lowCardinalityAttr(reason, "unknown")`                                 | ✓     |
| `recordPayloadLarge` attrs           | `lowCardinalityAttr` on surface/channel/plugin/reason                   | ✓     |
| `recordTelemetryExporter` attrs      | `lowCardinalityAttr` on exporter/errorCategory                          | ✓     |
| `genAiModelCallMetricAttrs`          | `lowCardinalityAttr` + `modelIdAttr`                                    | ✓     |

---

## Gaps Found

### GAP-1: `recordWebhookReceived` — Raw metric labels (HIGH)

**Location:** Lines 2238–2245

```js
const attrs = {
  "openclaw.channel": evt.channel ?? "unknown",
  "openclaw.webhook": evt.updateType ?? "unknown",
};
webhookReceivedCounter.add(1, attrs);
```

**Issue:** `evt.channel` and `evt.updateType` are used as raw metric labels without `lowCardinalityAttr` or `redactSensitiveText`. If a webhook channel name or update type contains a secret (unlikely but possible from a misconfigured webhook URL), it would leak into metric label cardinality.

**Risk:** Low probability of containing secrets (channel/updateType are typically enum-like: "slack", "message.received"), but violates the "all values through redaction" policy and the cardinality validation gate.

**Fix:** Wrap both in `lowCardinalityAttr()`.

---

### GAP-2: `recordModelUsage` — Raw metric labels for provider/model/channel (HIGH)

**Location:** Lines 2148–2153

```js
const attrs = {
  "openclaw.channel": evt.channel ?? "unknown",
  "openclaw.agent.id": resolveAgentLabelAttr(evt),
  "openclaw.provider": evt.provider ?? "unknown",
  "openclaw.model": evt.model ?? "unknown",
};
```

**Issue:** `evt.channel`, `evt.provider`, `evt.model` are used as raw metric labels for `tokensCounter`, `costCounter`, `durationHistogram`, and `contextHistogram`. The `genAiAttrs` on the same function properly uses `lowCardinalityAttr` and `modelIdAttr` — the `attrs` object does not.

**Risk:** Medium. Provider and model are typically low-cardinality enum-like values ("openai", "gpt-4"), but `evt.channel` could contain arbitrary strings. No redaction applied. Also a cardinality risk — an attacker-controllable channel value could create unbounded metric label space.

**Fix:** Wrap `evt.channel` in `lowCardinalityAttr()`, `evt.provider` in `lowCardinalityAttr()`, `evt.model` in `modelIdAttr()`.

---

### GAP-3: `recordRunCompleted` — Raw metric labels for provider/model/channel (HIGH)

**Location:** Lines 2743–2750

```js
const attrs: Record<string, string | number> = {
  "openclaw.outcome": evt.outcome,
  "openclaw.provider": evt.provider ?? "unknown",
  "openclaw.model": evt.model ?? "unknown",
};
if (evt.channel) {
  attrs["openclaw.channel"] = evt.channel;
}
```

**Issue:** Raw `evt.provider`, `evt.model`, `evt.channel` used for `durationHistogram.record()`. No `lowCardinalityAttr` or `redactSensitiveText` applied.

**Risk:** Same as GAP-2. Cardinality and secret leakage risk on metric labels.

**Fix:** Same as GAP-2.

---

### GAP-4: `modelCallMetricAttrs` — Raw metric labels for provider/model (MEDIUM)

**Location:** Lines 3008–3012

```js
const modelCallMetricAttrs = (evt: ModelCallLifecycleDiagnosticEvent) => ({
  "openclaw.provider": evt.provider,
  "openclaw.model": evt.model,
  "openclaw.api": lowCardinalityAttr(evt.api),
  "openclaw.transport": lowCardinalityAttr(evt.transport),
});
```

**Issue:** `evt.provider` and `evt.model` are raw, while `evt.api` and `evt.transport` are properly wrapped in `lowCardinalityAttr()`. Inconsistent within the same function. The `genAiModelCallMetricAttrs` function (line 3014) does it correctly.

**Risk:** Same as GAP-2/3 but lower — model/provider values are typically well-controlled enums, but the pattern should be consistent.

**Fix:** Wrap `evt.provider` in `lowCardinalityAttr()`, `evt.model` in `modelIdAttr()`.

---

### GAP-5: `recordSessionTurnCreated` — Raw `evt.trigger` as metric label (MEDIUM)

**Location:** Lines 2533–2536

```js
sessionTurnCreatedCounter.add(1, {
  "openclaw.agent.id": resolveAgentLabelAttr(evt),
  "openclaw.channel": lowCardinalityAttr(evt.channel, "unknown"),
  "openclaw.trigger": evt.trigger,
});
```

**Issue:** `evt.trigger` is used as a raw metric label. The trigger value for command-activated skills is a command name (safe), but for read-activated skills it could be a user message excerpt (unsafe). This is a metric counter label, not a span attribute — it does NOT pass through `redactOtelAttributes`.

**Risk:** Medium-high if `evt.trigger` can contain user message text. Even for command names, cardinality should be bounded.

**Fix:** Wrap in `lowCardinalityAttr(evt.trigger, "unknown")`.

---

### GAP-6: `recordMemoryPressure` — Raw `evt.reason` in metric labels and span status (LOW)

**Location:** Lines 2677–2682 (metric) and line 2706 (span status)

```js
const attrs = {
  "openclaw.memory.level": evt.level,
  "openclaw.memory.reason": evt.reason,
};
memoryPressureCounter.add(1, attrs);
// ...
span.setStatus({ code: SpanStatusCode.ERROR, message: evt.reason });
```

**Issue:** `evt.reason` is used raw as a metric label and as a span status message. The span attrs go through `spanWithDuration` → `redactOtelAttributes` ✓, but the metric label and span status message do not.

**Risk:** Low — `evt.reason` for memory pressure is an enum-like diagnostic value ("rss_growth", "heap_pressure"). Very unlikely to contain secrets. But for consistency and defense-in-depth, should be redacted.

**Fix:** Wrap `evt.reason` in `lowCardinalityAttr()` for metric label, `redactSensitiveText()` for span status.

---

### GAP-7: `recordLivenessWarning` — Raw `reason` in span status message (LOW)

**Location:** Line 3460

```js
const reason = evt.reasons.join(":");
// ...
span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
```

**Issue:** `reason` (joined from `evt.reasons` array) is used unredacted in span status. The metric label properly uses `lowCardinalityAttr(reason, "unknown")` ✓, but the span status message bypasses redaction.

**Risk:** Low — `evt.reasons` are enum-like diagnostic values ("event_loop_delay", "memory_pressure"). But inconsistent with the metric label path.

**Fix:** Use `redactSensitiveText(reason)` in the span status message.

---

### GAP-8: Direct `tracer.startSpan` calls without `redactOtelAttributes` (LOW)

**Location:** Lines 2282 (webhook error) and 2554 (session stuck)

```js
// recordWebhookError (line 2282)
const span = tracer.startSpan("openclaw.webhook.error", { attributes: spanAttrs });

// recordSessionStuck (line 2554)
const span = tracer.startSpan("openclaw.session.stuck", { attributes: spanAttrs });
```

**Issue:** These two span creation paths use `tracer.startSpan` directly instead of `spanWithDuration`, bypassing the `redactOtelAttributes` gate. The individual values in `spanAttrs` are either pre-redacted (`redactedError` in webhook error) or numeric/enum (session stuck attrs), so no actual secret leakage occurs. However:

- The DROPPED_OTEL_ATTRIBUTE_KEYS filter is not applied (though neither function calls `addSessionAttrs`, so no session keys to drop)
- The pattern is inconsistent with all other span creation paths
- Future modifications could add unredacted attributes without realizing the redaction gate is missing

**Risk:** Low currently, but a maintainability/consistency concern. Defense-in-depth principle violated.

**Fix:** Replace with `spanWithDuration(name, spanAttrs, durationMs, options)` calls, or add explicit `redactOtelAttributes` on the attrs before passing to `tracer.startSpan`.

---

## Missing Features

### MISSING-1: Scrubbing Counter (Required by DEV-330 Policy)

**Policy requirement (Section 7 of DEV-330 policy doc):**

> "Log when scrubbing fires (count, not content) for observability into scrubbing effectiveness"

**Current state:** No counter, histogram, or log exists in `service.ts` or `redact.ts` that tracks when `redactSensitiveText` actually redacts content. There is no way to observe:

- How often scrubbing fires
- Which patterns are matching
- Whether scrubbing is effective or if content is slipping through

**Impact:** Cannot satisfy the DEV-330 policy requirement. Cannot debug "did we miss a secret?" Cannot measure scrubbing overhead. Cannot alert on high scrubbing rates (which might indicate a misconfigured integration leaking credentials).

**Implementation approach:**

1. Add a meter counter in `service.ts`: `const scrubCounter = meter.createCounter("openclaw.redaction.fired", { unit: "1", description: "Secret redaction events by pattern type" })`
2. Modify `redactSensitiveText` to accept an optional callback or counter that fires when a pattern matches (returns count of replacements made, or pattern ID)
3. Wire the counter into the OTel service so each `redactSensitiveText` call that performs redaction increments it
4. Add a label for the pattern category (bearer, api_key, connection_string, etc.) if feasible without cardinality explosion

**Complexity:** Medium. Requires modifying `redactSensitiveText` (in `src/logging/redact.ts`) to return redaction metadata, then wiring it into the OTel service's metric instruments. Must be careful not to add per-call overhead on the hot path when no redaction occurs.

---

## Performance Analysis

### Hot Paths

`redactSensitiveText` is called on every string value in every span attribute map and every log body. The function uses a prefilter regex (`DEFAULT_REDACT_PREFILTER_RE`) for fast-path rejection — if the string doesn't contain any trigger patterns, the full pattern walk is skipped. This is well-optimized.

**Concerns:**

1. **`redactOtelAttributes` iterates all entries** — For spans with many attributes (model.call spans can have 20+), this means 20+ `redactSensitiveText` calls per span creation. Each call is fast (prefilter rejects most), but the iteration itself has measurable overhead on high-volume tracing.

2. **`safeJsonString` calls `redactSensitiveText` twice** — First in `stringifyJsonForOtelAttribute` (on the whole JSON string), then potentially in `truncateJsonTextForOtelAttribute` (on each string fragment). This double-redaction is wasteful but safe. For large content attributes (128KB max), this could be noticeable.

3. **`lowCardinalityAttr` calls `redactSensitiveText` on every metric label** — Metric instruments are called frequently (every model call, every message, every webhook). The prefilter makes this cheap, but it's still a regex test per label per data point.

4. **No caching** — `redactSensitiveText` does not cache results. If the same string (e.g., a model name) is redacted thousands of times, the regex runs each time. The prefilter helps (model names like "gpt-4" won't trigger the full walk), but a cache on the prefilter result could help for hot values.

**Recommendation:** Performance is acceptable for current load. If tracing volume increases significantly, consider:

- Caching `lowCardinalityAttr` results for known-enum values
- Lifting `redactOtelAttributes` to only process values that changed (diff-based updates)
- Batch-processing span attributes instead of per-attribute

---

## Summary Table

| Gap       | Severity | Path                                                       | Fix Complexity                                          |
| --------- | -------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| GAP-1     | HIGH     | `recordWebhookReceived` metric labels                      | Trivial (wrap in `lowCardinalityAttr`)                  |
| GAP-2     | HIGH     | `recordModelUsage` metric labels                           | Trivial                                                 |
| GAP-3     | HIGH     | `recordRunCompleted` metric labels                         | Trivial                                                 |
| GAP-4     | MEDIUM   | `modelCallMetricAttrs` metric labels                       | Trivial                                                 |
| GAP-5     | MEDIUM   | `recordSessionTurnCreated` trigger label                   | Trivial                                                 |
| GAP-6     | LOW      | `recordMemoryPressure` reason label/status                 | Trivial                                                 |
| GAP-7     | LOW      | `recordLivenessWarning` span status                        | Trivial                                                 |
| GAP-8     | LOW      | Direct `tracer.startSpan` bypassing `redactOtelAttributes` | Low (replace with `spanWithDuration`)                   |
| MISSING-1 | HIGH     | No scrubbing counter                                       | Medium (requires `redactSensitiveText` + metric wiring) |

**Total gaps: 8** (6 metric label paths, 1 span creation path, 1 span status message)
**Total missing features: 1** (scrubbing counter)

All gaps are fixable with trivial changes (wrapping values in `lowCardinalityAttr` or `redactSensitiveText`). The scrubbing counter is the only non-trivial work item.
