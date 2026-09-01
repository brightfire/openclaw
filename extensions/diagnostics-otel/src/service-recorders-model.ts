import { SpanStatusCode } from "@opentelemetry/api";
import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import { redactSensitiveText } from "../api.js";
import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import {
  addUpstreamRequestIdSpanEvent,
  assignGenAiModelCallAttrs,
  assignModelCallPromptStatsAttrs,
  assignModelCallSizeTimingAttrs,
  assignModelCallUsageAttrs,
  genAiOperationName,
  modelCallSpanKind,
  modelCallSpanName,
  modelCallObservationUnit,
  positiveFiniteNumber,
} from "./service-genai-attributes.js";
import { assignOtelModelContentAttributes } from "./service-genai-content.js";
import type { OtelModelCallContent } from "./service-genai-content.js";
import type { OtelContentCapturePolicy } from "./service-content-normalization.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { ModelCallLifecycleDiagnosticEvent } from "./service-types.js";

export function createModelRecorders(runtime: DiagnosticsRecorderRuntime) {
  const {
    genAiOperationDurationHistogram,
    modelCallDurationHistogram,
    modelCallRequestBytesHistogram,
    modelCallResponseBytesHistogram,
    modelCallTimeToFirstByteHistogram,
    spanWithDuration,
    activeTrustedParentContext,
    activeTrustedSpans,
    trustedTraceContext,
    trackTrustedSpan,
    getTrackedInternalOrTrustedSpan,
    takeTrackedTrustedSpan,
    setSpanAttrs,
    addSessionAttrs,
    resolveAgentLabelAttr,
    contentCapturePolicy,
    tracesEnabled,
  } = runtime;

  const modelCallMetricAttrs = (evt: ModelCallLifecycleDiagnosticEvent) => ({
    "openclaw.provider": evt.provider,
    "openclaw.model": evt.model,
    "openclaw.api": normalizeDiagnosticValue(evt.api),
    "openclaw.transport": normalizeDiagnosticValue(evt.transport),
    "openclaw.model_call.observation_unit": modelCallObservationUnit(evt),
  });
  const genAiModelCallMetricAttrs = (
    evt: ModelCallLifecycleDiagnosticEvent,
    errorType?: string,
  ) => ({
    "gen_ai.operation.name": genAiOperationName(evt.api, evt.observationUnit),
    "gen_ai.provider.name": normalizeDiagnosticValue(evt.provider),
    "gen_ai.request.model": normalizeDiagnosticValue(evt.model),
    ...(errorType ? { "error.type": errorType } : {}),
  });
  const recordGenAiModelCallDuration = (
    evt: ModelCallLifecycleDiagnosticEvent,
    errorType?: string,
  ) => {
    genAiOperationDurationHistogram.record(
      evt.durationMs / 1000,
      genAiModelCallMetricAttrs(evt, errorType),
    );
  };
  const recordModelCallSizeTimingMetrics = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" | "model.call.error" }>,
    attrs: ReturnType<typeof modelCallMetricAttrs>,
  ) => {
    const requestPayloadBytes = positiveFiniteNumber(evt.requestPayloadBytes);
    if (requestPayloadBytes !== undefined) {
      modelCallRequestBytesHistogram.record(requestPayloadBytes, attrs);
    }
    const responseStreamBytes = positiveFiniteNumber(evt.responseStreamBytes);
    if (responseStreamBytes !== undefined) {
      modelCallResponseBytesHistogram.record(responseStreamBytes, attrs);
    }
    const timeToFirstByteMs = positiveFiniteNumber(evt.timeToFirstByteMs);
    if (timeToFirstByteMs !== undefined) {
      modelCallTimeToFirstByteHistogram.record(timeToFirstByteMs, attrs);
    }
  };

  const recordModelCallStarted = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
    metadata: DiagnosticEventMetadata,
  ) => {
    if (!tracesEnabled || !metadata.trusted) {
      return undefined;
    }
    const trackedSpan = getTrackedInternalOrTrustedSpan(evt, metadata);
    if (trackedSpan) {
      return trackedSpan.spanContext();
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "openclaw.provider": evt.provider,
      "openclaw.model": evt.model,
    };
    addSessionAttrs(spanAttrs, evt);
    if (evt.agentId) {
      spanAttrs["openclaw.agent.id"] = resolveAgentLabelAttr(evt);
    }
    assignGenAiModelCallAttrs(spanAttrs, evt);
    if (evt.api) {
      spanAttrs["openclaw.api"] = evt.api;
    }
    if (evt.transport) {
      spanAttrs["openclaw.transport"] = evt.transport;
    }
    assignModelCallPromptStatsAttrs(spanAttrs, evt);
    return trackTrustedSpan(
      evt,
      metadata,
      spanWithDuration(modelCallSpanName(evt), spanAttrs, undefined, {
        kind: modelCallSpanKind(),
        parentContext: activeTrustedParentContext(evt, metadata),
        startTimeMs: evt.ts,
      }),
    ).spanContext();
  };

  const recordModelCallCompleted = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.completed" }>,
    metadata: DiagnosticEventMetadata,
    modelContent?: OtelModelCallContent,
  ) => {
    const metricAttrs = modelCallMetricAttrs(evt);
    modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
    recordModelCallSizeTimingMetrics(evt, metricAttrs);
    recordGenAiModelCallDuration(evt);
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "openclaw.provider": evt.provider,
      "openclaw.model": evt.model,
    };
    addSessionAttrs(spanAttrs, evt);
    if (evt.agentId) {
      spanAttrs["openclaw.agent.id"] = resolveAgentLabelAttr(evt);
    }
    assignGenAiModelCallAttrs(spanAttrs, evt);
    if (evt.api) {
      spanAttrs["openclaw.api"] = evt.api;
    }
    if (evt.transport) {
      spanAttrs["openclaw.transport"] = evt.transport;
    }
    assignModelCallSizeTimingAttrs(spanAttrs, evt);
    assignModelCallPromptStatsAttrs(spanAttrs, evt);
    assignModelCallUsageAttrs(spanAttrs, evt);
    assignOtelModelContentAttributes(spanAttrs, modelContent, contentCapturePolicy);
    // Propagate I/O content to the parent span (typically openclaw.harness.run) so
    // that Langfuse traces show the prompt and final response at the harness level.
    // In v2026.6.8 and earlier, model call events reused the harness.run span's
    // spanId (via takeTrackedTrustedSpan), so content landed on it directly.
    // v2026.8.1 creates a child trace context for model calls, so the content is
    // on the child model.call span instead. This restores the prior visibility.
    propagateContentToParent(evt, metadata, modelContent, contentCapturePolicy);
    const span =
      takeTrackedTrustedSpan(evt, metadata) ??
      spanWithDuration(modelCallSpanName(evt), spanAttrs, evt.durationMs, {
        kind: modelCallSpanKind(),
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
    setSpanAttrs(span, spanAttrs);
    addUpstreamRequestIdSpanEvent(span, evt.upstreamRequestIdHash);
    span.end(evt.ts);
  };

  const recordModelCallError = (
    evt: Extract<DiagnosticEventPayload, { type: "model.call.error" }>,
    metadata: DiagnosticEventMetadata,
    modelContent?: OtelModelCallContent,
  ) => {
    const errorType = normalizeDiagnosticValue(evt.errorCategory, "other");
    const metricAttrs = {
      ...modelCallMetricAttrs(evt),
      "openclaw.errorCategory": errorType,
      ...(evt.failureKind
        ? { "openclaw.failureKind": normalizeDiagnosticValue(evt.failureKind, "other") }
        : {}),
    };
    modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
    recordModelCallSizeTimingMetrics(evt, metricAttrs);
    recordGenAiModelCallDuration(evt, errorType);
    if (!tracesEnabled) {
      return;
    }
    const spanAttrs: Record<string, string | number | boolean> = {
      "openclaw.provider": evt.provider,
      "openclaw.model": evt.model,
      "openclaw.errorCategory": errorType,
      "error.type": errorType,
    };
    addSessionAttrs(spanAttrs, evt);
    if (evt.agentId) {
      spanAttrs["openclaw.agent.id"] = resolveAgentLabelAttr(evt);
    }
    if (evt.failureKind) {
      spanAttrs["openclaw.failureKind"] = normalizeDiagnosticValue(evt.failureKind, "other");
    }
    assignGenAiModelCallAttrs(spanAttrs, evt);
    if (evt.api) {
      spanAttrs["openclaw.api"] = evt.api;
    }
    if (evt.transport) {
      spanAttrs["openclaw.transport"] = evt.transport;
    }
    assignModelCallSizeTimingAttrs(spanAttrs, evt);
    assignModelCallPromptStatsAttrs(spanAttrs, evt);
    assignModelCallUsageAttrs(spanAttrs, evt);
    assignOtelModelContentAttributes(spanAttrs, modelContent, contentCapturePolicy);
    // Propagate I/O content to the parent span for the same reason as in
    // recordModelCallCompleted — restores harness-level I/O visibility.
    propagateContentToParent(evt, metadata, modelContent, contentCapturePolicy);
    const span =
      takeTrackedTrustedSpan(evt, metadata) ??
      spanWithDuration(modelCallSpanName(evt), spanAttrs, evt.durationMs, {
        kind: modelCallSpanKind(),
        parentContext: activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
    setSpanAttrs(span, spanAttrs);
    addUpstreamRequestIdSpanEvent(span, evt.upstreamRequestIdHash);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: redactSensitiveText(evt.errorCategory),
    });
    span.end(evt.ts);
  };

  /**
   * Propagates model call I/O content (input.value, output.value, gen_ai.* messages)
   * to the parent span in activeTrustedSpans (typically openclaw.harness.run).
   *
   * Before v2026.8.1, model call events carried the same trace spanId as the
   * harness.run span, so takeTrackedTrustedSpan returned the harness.run span
   * itself and content attributes landed on it directly. v2026.8.1 creates a
   * child trace context for model calls, so the content is on the child
   * model.call span instead. This helper restores the prior visibility by
   * mirroring the I/O attributes onto the parent span.
   */
  const propagateContentToParent = (
    evt: DiagnosticEventPayload,
    metadata: DiagnosticEventMetadata,
    modelContent: OtelModelCallContent | undefined,
    policy: OtelContentCapturePolicy,
  ) => {
    const traceContext = trustedTraceContext(evt, metadata);
    const parentSpanId = traceContext?.parentSpanId;
    if (!parentSpanId) { return; }
    const parentSpan = activeTrustedSpans.get(parentSpanId);
    if (!parentSpan) { return; }
    const ioAttrs: Record<string, string | number | boolean> = {};
    assignOtelModelContentAttributes(ioAttrs, modelContent, policy);
    if (Object.keys(ioAttrs).length > 0) {
      setSpanAttrs(parentSpan, ioAttrs);
    }
  };

  return {
    recordModelCallSizeTimingMetrics,
    recordModelCallStarted,
    recordModelCallCompleted,
    recordModelCallError,
  };
}
