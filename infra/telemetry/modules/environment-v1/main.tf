locals {
  schema_version = 1
  environment_id = var.environment == "development" ? "dev" : "prod"
  suffix         = var.resource_suffix == "" ? "" : "-${var.resource_suffix}"

  bucket_name   = "${replace(var.project, "_", "-")}-telemetry-${local.environment_id}-v${local.schema_version}${local.suffix}"
  name_prefix   = replace("${var.project}_telemetry_${local.environment_id}${local.suffix}", "-", "_")
  stream_name   = "${local.name_prefix}_stream_v${local.schema_version}"
  sink_name     = "${local.name_prefix}_sink_v${local.schema_version}"
  pipeline_name = "${local.name_prefix}_pipeline_v${local.schema_version}"
  namespace     = "telemetry"
  table_name    = "events_v${local.schema_version}"

  event_schema        = jsondecode(file("${path.module}/../../schema/v1.json"))
  event_fields        = local.event_schema.fields
  event_field_names   = [for field in local.event_fields : field.name]
  pipeline_projection = join(",\n  ", local.event_field_names)

  pipeline_sql = <<-SQL
    INSERT INTO ${cloudflare_pipeline_sink.events.name}
    SELECT
      ${local.pipeline_projection}
    FROM ${cloudflare_pipeline_stream.events.name}
    WHERE schema_version = ${local.schema_version}
      AND project = '${var.project}'
      AND environment = '${var.environment}'
  SQL

  catalog_sink_token = coalesce(
    var.catalog_sink_token,
    try(cloudflare_account_token.catalog_sink[0].value, null),
  )
}

data "cloudflare_account_api_token_permission_groups_list" "r2_bucket_item_write" {
  count      = var.catalog_sink_token == null ? 1 : 0
  account_id = var.account_id
  name       = "Workers R2 Storage Bucket Item Write"
}

data "cloudflare_account_api_token_permission_groups_list" "r2_data_catalog_write" {
  count      = var.catalog_sink_token == null ? 1 : 0
  account_id = var.account_id
  name       = "Workers R2 Data Catalog Write"
}

resource "cloudflare_account_token" "catalog_sink" {
  count      = var.catalog_sink_token == null ? 1 : 0
  account_id = var.account_id
  name       = "${local.name_prefix}_catalog_sink_v${local.schema_version}"

  policies = [{
    effect = "allow"
    permission_groups = [
      { id = data.cloudflare_account_api_token_permission_groups_list.r2_bucket_item_write[0].result[0].id },
      { id = data.cloudflare_account_api_token_permission_groups_list.r2_data_catalog_write[0].result[0].id },
    ]
    resources = jsonencode({
      "com.cloudflare.api.account.${var.account_id}" = "*"
    })
  }]
}

resource "cloudflare_r2_bucket" "telemetry" {
  account_id    = var.account_id
  name          = local.bucket_name
  jurisdiction  = "default"
  location      = var.bucket_location
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_data_catalog" "telemetry" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.telemetry.name

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_pipeline_stream" "events" {
  account_id = var.account_id
  name       = local.stream_name

  format = {
    type             = "json"
    timestamp_format = "rfc3339"
    unstructured     = false
  }

  schema = {
    fields   = local.event_fields
    inferred = false
  }

  # Public Pipelines HTTP ingestion is deliberately unavailable. Untrusted
  # clients send to the telemetry Worker; only its binding can reach the stream.
  # Cloudflare normalizes authentication to false and omits CORS whenever the
  # HTTP endpoint itself is disabled, so model that canonical API state.
  http = {
    enabled        = false
    authentication = false
    cors           = {}
  }

  worker_binding = {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_pipeline_sink" "events" {
  account_id = var.account_id
  name       = local.sink_name
  type       = "r2_data_catalog"

  config = {
    account_id = var.account_id
    bucket     = cloudflare_r2_bucket.telemetry.name
    namespace  = local.namespace
    table_name = local.table_name
    token      = local.catalog_sink_token
    rolling_policy = {
      file_size_bytes  = var.roll_size_bytes
      interval_seconds = var.roll_interval_seconds
    }
  }

  format = {
    type            = "parquet"
    compression     = "zstd"
    row_group_bytes = var.parquet_row_group_bytes
  }

  schema = {
    fields   = local.event_fields
    inferred = false
  }

  depends_on = [cloudflare_r2_data_catalog.telemetry]

  # A Data Catalog sink cannot be recreated against its existing Iceberg table.
  # Schema changes must create a new versioned stream, table, sink, and pipeline.
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_pipeline" "events" {
  account_id = var.account_id
  name       = local.pipeline_name
  sql        = local.pipeline_sql

  # Pipeline SQL is immutable in the service. Roll out v2 beside v1 instead of
  # allowing Terraform to delete a live pipeline and create an ingestion gap.
  lifecycle {
    prevent_destroy = true
  }
}
