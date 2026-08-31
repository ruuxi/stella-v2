output "bucket_name" {
  description = "R2 bucket holding the environment's Iceberg catalog."
  value       = cloudflare_r2_bucket.telemetry.name
}

output "catalog_id" {
  description = "R2 Data Catalog ID."
  value       = cloudflare_r2_data_catalog.telemetry.id
}

output "warehouse_name" {
  description = "Warehouse name used by R2 SQL."
  value       = "${var.account_id}_${cloudflare_r2_bucket.telemetry.name}"
}

output "stream_id" {
  description = "Pipelines Stream ID for the telemetry Worker's binding."
  value       = cloudflare_pipeline_stream.events.id
}

output "stream_name" {
  description = "Pipelines Stream name."
  value       = cloudflare_pipeline_stream.events.name
}

output "sink_id" {
  description = "Pipelines R2 Data Catalog sink ID."
  value       = cloudflare_pipeline_sink.events.id
}

output "pipeline_id" {
  description = "Pipelines transformation ID."
  value       = cloudflare_pipeline.events.id
}

output "pipeline_status" {
  description = "Current Cloudflare Pipeline status."
  value       = cloudflare_pipeline.events.status
}

output "iceberg_table" {
  description = "Fully qualified Iceberg table queried by R2 SQL."
  value       = "${local.namespace}.${local.table_name}"
}

output "worker_binding" {
  description = "Object to copy into the telemetry Worker's wrangler.jsonc pipelines array."
  value = {
    binding = "EVENTS_PIPELINE"
    stream  = cloudflare_pipeline_stream.events.id
  }
}

output "r2_sql_example" {
  description = "Token-free example. Set WRANGLER_R2_SQL_AUTH_TOKEN before running it."
  value       = "bunx wrangler r2 sql query '${var.account_id}_${cloudflare_r2_bucket.telemetry.name}' 'SELECT * FROM ${local.namespace}.${local.table_name} ORDER BY __ingest_ts DESC LIMIT 20'"
}
