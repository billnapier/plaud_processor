resource "google_project_service" "cloudscheduler_api" {
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
}

# Cloud Scheduler Job targeting /renew-watch
resource "google_cloud_scheduler_job" "renew_watch" {
  name        = "renew-watch-job"
  description = "Trigger watch channel renewal every 12 hours"
  schedule    = "0 */12 * * *"
  time_zone   = "Etc/UTC"

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.default.uri}/renew-watch"

    oidc_token {
      service_account_email = google_service_account.scheduler_invoker.email
    }
  }

  depends_on = [
    google_project_service.cloudscheduler_api
  ]
}

# Cloud Scheduler service identity for OIDC token generation/impersonation
resource "google_project_service_identity" "cloud_scheduler" {
  provider   = google-beta
  project    = var.project_id
  service    = "cloudscheduler.googleapis.com"
  depends_on = [google_project_service.cloudscheduler_api]
}

# Grant the Cloud Scheduler service identity permission to act as the scheduler-invoker service account
resource "google_service_account_iam_member" "scheduler_impersonation" {
  service_account_id = google_service_account.scheduler_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_project_service_identity.cloud_scheduler.email}"
}
