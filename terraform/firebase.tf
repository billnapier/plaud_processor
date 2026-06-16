# Configure google-beta provider for Firebase-specific resources
provider "google-beta" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
}

resource "google_project_service" "firebase_api" {
  service            = "firebase.googleapis.com"
  disable_on_destroy = false
}

# Firebase Project setup
resource "google_firebase_project" "default" {
  provider = google-beta
  project  = var.project_id

  depends_on = [
    google_project_service.firebase_api,
    google_project_service.serviceusage_api
  ]
}

# Firebase Web App setup
resource "google_firebase_web_app" "default" {
  provider     = google-beta
  project      = var.project_id
  display_name = "PlaudProcessor"
  depends_on   = [google_firebase_project.default]
}

# Domain Mapping via Firebase Hosting
resource "google_firebase_hosting_custom_domain" "default" {
  provider      = google-beta
  project       = var.project_id
  site_id       = var.project_id
  custom_domain = var.domain_name

  depends_on = [google_firebase_web_app.default]
}

data "google_firebase_web_app_config" "default" {
  provider   = google-beta
  web_app_id = google_firebase_web_app.default.app_id
}

output "firebase_config" {
  value = {
    apiKey            = data.google_firebase_web_app_config.default.api_key
    authDomain        = data.google_firebase_web_app_config.default.auth_domain
    projectId         = var.project_id
    storageBucket     = data.google_firebase_web_app_config.default.storage_bucket
    messagingSenderId = data.google_firebase_web_app_config.default.messaging_sender_id
    appId             = google_firebase_web_app.default.app_id
  }
  sensitive = true
}

output "dns_records" {
  value = google_firebase_hosting_custom_domain.default.required_dns_updates
}
