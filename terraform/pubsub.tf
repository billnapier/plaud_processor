resource "google_project_service" "pubsub_api" {
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

# Pub/Sub Topic
resource "google_pubsub_topic" "drive_changes" {
  name       = "drive-file-changes"
  depends_on = [google_project_service.pubsub_api]
}

# Dead Letter Topic
resource "google_pubsub_topic" "drive_changes_dead_letter" {
  name       = "drive-file-changes-dead-letter"
  depends_on = [google_project_service.pubsub_api]
}

# Dead Letter Subscription
resource "google_pubsub_subscription" "drive_changes_dead_letter" {
  name  = "drive-file-changes-dead-letter-sub"
  topic = google_pubsub_topic.drive_changes_dead_letter.name
}

# Pub/Sub Push Subscription to Cloud Run /pubsub-worker
resource "google_pubsub_subscription" "drive_changes_sub" {
  name  = "drive-file-changes-sub"
  topic = google_pubsub_topic.drive_changes.name

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.default.uri}/pubsub-worker"

    oidc_token {
      service_account_email = google_service_account.pubsub_invoker.email
    }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.drive_changes_dead_letter.id
    max_delivery_attempts = 5
  }

  depends_on = [
    google_project_iam_member.pubsub_dlq_publisher,
    google_project_iam_member.pubsub_subscriber
  ]
}

# Grant publisher role to the Google-managed Pub/Sub service account for DLQ
resource "google_project_iam_member" "pubsub_dlq_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# Grant subscriber role to the Google-managed Pub/Sub service account
resource "google_project_iam_member" "pubsub_subscriber" {
  project = var.project_id
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

# Gmail Inbox Updates Pub/Sub Topic
resource "google_pubsub_topic" "gmail_inbox_updates" {
  name       = "gmail-inbox-updates"
  depends_on = [google_project_service.pubsub_api]
}

# Grant publisher role to the Google system Gmail push service account
resource "google_pubsub_topic_iam_member" "gmail_publisher" {
  topic  = google_pubsub_topic.gmail_inbox_updates.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
}

# Push subscription for Gmail updates targeting /webhooks/gmail
resource "google_pubsub_subscription" "gmail_inbox_updates_sub" {
  name  = "gmail-inbox-updates-sub"
  topic = google_pubsub_topic.gmail_inbox_updates.name

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.default.uri}/webhooks/gmail"

    oidc_token {
      service_account_email = google_service_account.pubsub_invoker.email
    }
  }

  depends_on = [
    google_cloud_run_v2_service.default,
    google_service_account.pubsub_invoker
  ]
}

