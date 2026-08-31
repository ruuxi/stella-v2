variable "account_id" {
  description = "Cloudflare account ID that owns Pipelines and R2."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character lowercase hexadecimal Cloudflare account ID."
  }
}

variable "project" {
  description = "Stable project identifier written into every accepted event."
  type        = string
  default     = "stella"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_-]{1,31}$", var.project))
    error_message = "project must be 2-32 lowercase letters, digits, underscores, or hyphens."
  }
}

variable "environment" {
  description = "Environment value expected in telemetry records."
  type        = string

  validation {
    condition     = contains(["development", "production"], var.environment)
    error_message = "environment must be development or production."
  }
}

variable "resource_suffix" {
  description = "Short globally unique suffix used to avoid R2 bucket collisions."
  type        = string
  default     = ""

  validation {
    condition     = var.resource_suffix == "" || can(regex("^[a-z0-9][a-z0-9-]{0,20}$", var.resource_suffix))
    error_message = "resource_suffix must be empty or 1-21 lowercase letters, digits, or hyphens."
  }
}

variable "catalog_sink_token" {
  description = "Optional pre-created R2 catalog write token. When null, Terraform creates a least-privilege account token for the sink."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true

  validation {
    condition     = var.catalog_sink_token == null || length(var.catalog_sink_token) >= 20
    error_message = "catalog_sink_token does not look like a Cloudflare API token."
  }
}

variable "bucket_location" {
  description = "Best-effort R2 location hint. The catalog requires the default jurisdiction."
  type        = string
  default     = "wnam"

  validation {
    condition     = contains(["apac", "eeur", "enam", "weur", "wnam", "oc"], var.bucket_location)
    error_message = "bucket_location must be one of apac, eeur, enam, weur, wnam, or oc."
  }
}

variable "roll_interval_seconds" {
  description = "Maximum Iceberg sink roll interval. Cloudflare currently requires at least 60 seconds."
  type        = number
  default     = 300

  validation {
    condition     = var.roll_interval_seconds >= 60
    error_message = "roll_interval_seconds must be at least 60 for an R2 Data Catalog sink."
  }
}

variable "roll_size_bytes" {
  description = "Maximum Parquet file size before the sink rolls a file."
  type        = number
  default     = 134217728

  validation {
    condition     = var.roll_size_bytes >= 5242880
    error_message = "roll_size_bytes must be at least 5 MiB."
  }
}

variable "parquet_row_group_bytes" {
  description = "Target Parquet row group size."
  type        = number
  default     = 134217728

  validation {
    condition     = var.parquet_row_group_bytes >= 5242880
    error_message = "parquet_row_group_bytes must be at least 5 MiB."
  }
}
