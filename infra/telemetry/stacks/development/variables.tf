variable "cloudflare_account_id" {
  description = "Cloudflare account ID. Prefer TF_VAR_cloudflare_account_id."
  type        = string
  sensitive   = true
}

variable "catalog_sink_token" {
  description = "Optional development-only R2 catalog write token. Terraform creates one when omitted."
  type        = string
  default     = null
  nullable    = true
  sensitive   = true
}

variable "resource_suffix" {
  description = "Optional suffix if the default bucket name already exists."
  type        = string
  default     = ""
}

variable "bucket_location" {
  description = "Best-effort R2 location hint."
  type        = string
  default     = "wnam"
}
