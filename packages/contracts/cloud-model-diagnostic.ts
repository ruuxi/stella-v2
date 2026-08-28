export const CLOUD_MODEL_PROXY_DIAGNOSTIC_HEADER =
  "x-stella-local-model-diagnostic";

export const CLOUD_MODEL_PROXY_DIAGNOSTIC_CODES = [
  "model_proxy_reject",
  "model_broker_closed",
  "model_broker_transport",
] as const;

export type CloudModelProxyDiagnosticCode =
  (typeof CLOUD_MODEL_PROXY_DIAGNOSTIC_CODES)[number];

export const CLOUD_MODEL_DIAGNOSTIC_SENTINELS = {
  model_loopback_connect:
    "STELLA_EXECUTOR_DIAGNOSTIC:model_loopback_connect",
  model_loopback_refused:
    "STELLA_EXECUTOR_DIAGNOSTIC:model_loopback_refused",
  model_loopback_timeout:
    "STELLA_EXECUTOR_DIAGNOSTIC:model_loopback_timeout",
  model_loopback_unreachable:
    "STELLA_EXECUTOR_DIAGNOSTIC:model_loopback_unreachable",
  model_loopback_handler:
    "STELLA_EXECUTOR_DIAGNOSTIC:model_loopback_handler",
  model_loopback_broker:
    "STELLA_EXECUTOR_DIAGNOSTIC:model_loopback_broker",
  model_loopback_response:
    "STELLA_EXECUTOR_DIAGNOSTIC:model_loopback_response",
  model_proxy_reject: "STELLA_EXECUTOR_DIAGNOSTIC:model_proxy_reject",
  model_broker_closed: "STELLA_EXECUTOR_DIAGNOSTIC:model_broker_closed",
  model_broker_transport:
    "STELLA_EXECUTOR_DIAGNOSTIC:model_broker_transport",
  model_http_failure: "STELLA_EXECUTOR_DIAGNOSTIC:model_http_failure",
  model_response_invalid:
    "STELLA_EXECUTOR_DIAGNOSTIC:model_response_invalid",
} as const;

export type CloudModelDiagnosticCode =
  keyof typeof CLOUD_MODEL_DIAGNOSTIC_SENTINELS;
