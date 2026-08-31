output "bucket_name" {
  value = module.telemetry.bucket_name
}

output "warehouse_name" {
  value = module.telemetry.warehouse_name
}

output "stream_id" {
  value = module.telemetry.stream_id
}

output "stream_name" {
  value = module.telemetry.stream_name
}

output "sink_id" {
  value = module.telemetry.sink_id
}

output "pipeline_id" {
  value = module.telemetry.pipeline_id
}

output "pipeline_status" {
  value = module.telemetry.pipeline_status
}

output "iceberg_table" {
  value = module.telemetry.iceberg_table
}

output "worker_binding" {
  value = module.telemetry.worker_binding
}

output "r2_sql_example" {
  value = module.telemetry.r2_sql_example
}
