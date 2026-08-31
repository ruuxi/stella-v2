module "telemetry" {
  source = "../../modules/environment-v1"

  account_id         = var.cloudflare_account_id
  project            = "stella"
  environment        = "development"
  resource_suffix    = var.resource_suffix
  bucket_location    = var.bucket_location
  catalog_sink_token = var.catalog_sink_token
}
