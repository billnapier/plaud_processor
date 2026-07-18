# **Critical User Journeys: Plaud & Gmail Obsidian Ingestion Engine**

This document specifies the Critical User Journeys (CUJs) supported by the **plaud_processor** service, detailing the interactions, state transitions, security, and edge-case handling for both the legacy PLAUD transcript router and the new Gmail-to-Obsidian ingestion feature.

---

## **Journey Matrix**

| ID | Name | User Goal | Trigger Event | Target Folders / State |
| :--- | :--- | :--- | :--- | :--- |
| **CUJ-1** | [PLAUD Transcript Processing & Routing](#cuj-1-plaud-transcript-processing-routing) | Dictate voice notes on PLAUD and have them automatically cleaned, named, and routed to specific Obsidian vault subfolders. | File upload to `Obsidian Staging` (via PLAUD Cloud & Zapier). | `Obsidian Vault/` (`Journal/`, `Projects/`, `Project Updates/<Name>/`, or `Unfiled/`) |
| **CUJ-2** | [Google Drive Watch Channel Renewal](#cuj-2-google-drive-watch-channel-renewal) | Keep the webhook connection alive to continuously ingest new PLAUD files without manual reconnection. | Cron trigger (every 12 hours) from Cloud Scheduler. | Firestore: `watch_channels/inbox_channel` |
| **CUJ-3** | [Gmail Ingestion & LLM Structuring](#cuj-3-gmail-ingestion-llm-structuring) | Forward flagged email content to the Obsidian vault as a clean, structured Markdown note with LLM-extracted metadata. | Thread labeled `to-obsidian` in Gmail. | Gmail Labels: `to-obsidian` -> `processed-to-obsidian`<br>Google Drive: `Obsidian Vault/` or `Obsidian Staging` |
| **CUJ-4** | [Gmail OAuth 2.0 Web Handshake](#cuj-4-gmail-oauth-20-web-handshake) | Authenticate the processing service with Gmail to allow access to labeled threads. | Admin visits `/auth/gmail` on the deployed service. | Secret Manager: `GMAIL_USER_REFRESH_TOKEN` |
| **CUJ-5** | [Gmail Watch Channel Renewal](#cuj-5-gmail-watch-channel-renewal) | Keep the Gmail push notification channel alive to ensure real-time email ingestion. | Cron trigger (daily/weekly) from Cloud Scheduler. | Gmail watch subscription registration with Pub/Sub. |

---

## **CUJ-1: PLAUD Transcript Processing & Routing**

### **Overview**
The core user journey where voice recordings from the physical PLAUD device are processed and synced into the local Obsidian vault.

**Ingestion Data Flow:**
1. **Dictation:** User dictates meeting/memo & saves transcript in the PLAUD hardware/app.
2. **Web Hook Trigger:** PLAUD API triggers a webhook which makes Zapier upload the raw markdown file to `Obsidian Staging` in Google Drive.
3. **Drive Notification:** Google Drive triggers the `/webhook` endpoint on Cloud Run.
4. **Pub/Sub Publish:** Webhook publishes a change event to the `drive-file-changes` Pub/Sub topic and returns a 200 OK immediately.
5. **Worker Execution:** Pub/Sub triggers `/pubsub-worker` (Cloud Run).
6. **Processing Loop:** The worker pauses 5 seconds, lists files in `Obsidian Staging`, and loops through each file:
   - Acquires Firestore transaction lock (`processed_files/{fileId}`).
   - Downloads the file and runs regex cleanups (strip backticks, expand dates, normalize tags).
   - Routes the file based on the hashtags in the body (e.g. `#Journal` to `/Journal`).
   - Renames the file (`YYYY-MM-DD - [Title].md`) and moves it to `Obsidian Vault/<resolved-folder>`.
   - Sets the lock status in Firestore to `completed`.
7. **Client Sync:** Periodic/manual sync via DriveSync/rclone updates the user's local Obsidian vault.

### **Detailed Protocol**
1. **Preconditions:**
   * PLAUD device is configured to sync recordings to the PLAUD cloud.
   * Zapier is configured to watch new PLAUD transcripts and dump them directly into the Google Drive folder named `Obsidian Staging`.
   * Google Drive has a webhook watch active on the `Obsidian Staging` folder.
   * Cloud Run service account has Editor permissions on `Obsidian Staging` and `Obsidian Vault`.

2. **Trigger:** A new `.md` or `.txt` transcript file is uploaded to `Obsidian Staging`.
3. **Execution Steps:**
   * Google Drive sends an HTTP POST notification to `/webhook`.
   * The webhook extracts the headers and publishes the event metadata to the `drive-file-changes` Pub/Sub topic, then returns `200 OK` in under 500ms.
   * Pub/Sub triggers the `/pubsub-worker` push subscriber.
   * The worker pauses for 5 seconds to ensure the file content has fully committed.
   * The worker queries files in `Obsidian Staging`.
   * For each valid file (ends with `.md` or mimeType `text/plain`), it initiates a Firestore transaction on `processed_files/{fileId}`.
   * If the transaction secures the lease (status set to `processing`), the worker:
     * Downloads the file content.
     * Cleans formatting (regex to strip markdown wrappers from hashtags, strip protective backticks, expand `MM-DD` inline dates).
     * Extracts target date (looking at `timestamp: <value>`, H1 prefixes, filename timestamp, or falling back to current date).
     * Extracts H1 header as the base title (falling back to filename, or `Plaud Note` if empty).
     * Normalizes and sanitizes filename characters.
     * Evaluates hashtags in the body to determine target path under `Obsidian Vault/`:
       * `#Journal` -> `/Journal` (uses a date-based fallback title).
       * `#project/<ProjectName>` -> `/Project Updates/<ProjectName>`.
       * `#Project` or `#ProjectPlan` -> `/Projects`.
       * Default fallback -> `/Unfiled`.
     * Performs a case-insensitive check of filenames in the target directory; appends `_1`, `_2` if a collision exists.
     * Updates the file content in Google Drive, renames the file, and moves the parent folder to the target directory.
     * Sets the Firestore record to `completed`.
4. **Postconditions:**
   * The processed file resides in the correct subfolder under `Obsidian Vault/` in Google Drive.
   * Firestore logs the transaction as `completed`.
   * The `Obsidian Staging` folder is empty.
   * Sync clients (DriveSync on Android, rclone on Linux) sync the new file into the local vault.
5. **Error & Fallback Paths:**
   * **Empty/Syncing File:** If the downloaded content is empty, the worker deletes the lock in Firestore and terminates so that subsequent Pub/Sub retries can pick up the file once the write is complete.
   * **Transient API Failures:** If Google Drive or Firestore throws an error during processing, the Firestore document is updated to `failed` with the error description, and the Pub/Sub message is retried (up to 5 times) before being routed to the Dead Letter Queue.

---

## **CUJ-2: Google Drive Watch Channel Renewal**

### **Overview**
Background system maintenance task that guarantees uninterrupted webhooks by renewing the Google Drive subscription before it expires.

### **Detailed Protocol**
1. **Preconditions:**
   * Cloud Scheduler job is provisioned to call `/renew-watch` every 12 hours.
   * Cloud Run instance has access to Firestore Native.
2. **Trigger:** Cron schedule hits `0 */12 * * *`.
3. **Execution Steps:**
   * Cloud Scheduler sends an authenticated HTTP POST request to `/renew-watch`.
   * The endpoint verifies the OIDC token.
   * The handler fetches the currently active channel metadata from Firestore (`watch_channels/inbox_channel`).
   * The handler calls `drive.files.watch` on `Obsidian Staging` to request a new watch channel with a 24-hour expiration duration.
   * The handler updates `watch_channels/inbox_channel` in Firestore with the new `channelId`, `resourceId`, and `expiration` timestamp.
   * The handler calls `drive.channels.stop` to terminate the old channel using the old `id` and `resourceId`.
   * As an added safety net, the handler publishes a fake webhook event to Pub/Sub to trigger a worker sweep of the staging directory.
4. **Postconditions:**
   * A new 24-hour watch subscription is active.
   * The old watch subscription is decommissioned.
   * Firestore state is updated with new channel details.

---

## **CUJ-3: Gmail Ingestion & LLM Structuring**

### **Overview**
The user journey that intercepts emails labeled in Gmail, cleans/structures them using Gemini, and saves them to the Obsidian vault by routing them through the staging area.

**Ingestion Data Flow:**
1. **Trigger:** User labels a Gmail thread as `to-obsidian`.
2. **Push Event:** Gmail pushes a history event notification to the `gmail-inbox-updates` Pub/Sub topic, which triggers the `/webhooks/gmail` route on Cloud Run.
3. **Decryption:** The webhook decodes the base64 data and queries Gmail for messages containing the `to-obsidian` label.
4. **Deduplication:** For each messageId, the worker queries Firestore `processed_emails`. If not already processed, it locks the status to `processing`.
5. **Processing Loop:**
   - Downloads raw multipart MIME email string.
   - Parses the MIME data, extracting clean plaintext body, sender details, subject, date, and constructs a direct Gmail web client link using the `threadId`.
   - Sends the plaintext body to Gemini 1.5 Flash via Vertex AI (`@google/genai`), requesting structured JSON containing a summary, checkbox TODO tasks, classification tags, and cleaned Markdown.
   - Compiles the final Markdown note with YAML frontmatter, summary, checkbox tasks list (`- [ ] task`), email link, and the cleaned markdown body. It appends the classification tags as hashtags to the end of the note text body.
   - Writes the file to the `Obsidian Staging` folder in Google Drive. This immediately triggers the downstream Plaud worker (CUJ-1) which reads the hashtags, renames the file to `YYYY-MM-DD - [Subject].md`, and routes it to `Obsidian Vault/<subfolder>`.
   - Removes the `to-obsidian` label and adds the `processed-to-obsidian` label to the Gmail thread.
   - Sets the Firestore document status to `completed`.
6. **Acknowledge:** Returns 200 OK to Pub/Sub.

### **Detailed Protocol**
1. **Preconditions:**
   * User has authorized the app and a valid `GMAIL_USER_REFRESH_TOKEN` resides in GCP Secret Manager.
   * A Gmail watch is active on the user's inbox.
   * Pub/Sub topic `gmail-inbox-updates` is configured to trigger `/webhooks/gmail`.
   * Gmail API system account is authorized to publish to the topic.
2. **Trigger:** The user adds the label `to-obsidian` to an email thread.
3. **Execution Steps:**
   * Gmail pushes a base64-encoded history event notification to the Pub/Sub topic `gmail-inbox-updates`.
   * Pub/Sub forwards this message as a push HTTP POST to `/webhooks/gmail`.
   * The webhook decodes the base64 data to extract the notification metadata.
   * The webhook instantiates a Gmail API client, retrieving the user's Client ID, Client Secret, and Refresh Token from Secret Manager.
   * The webhook queries Gmail for all messages matching the query `label:to-obsidian` (to ensure we capture all outstanding items robustly, bypassing history logs if needed).
   * For each discovered `messageId`:
     * It checks the Firestore collection `processed_emails` (using document ID `messageId`) to ensure the email has not been processed.
     * It transactionally sets the status to `processing`.
     * It calls `gmail.users.messages.get` with `format=full` to retrieve the email payload.
     * It parses the multipart MIME message (extracting plaintext body, fallback html to text, sender details, subject, and date).
     * It constructs a direct link to the email thread in Gmail: `https://mail.google.com/mail/u/0/#all/${threadId}`.
     * It calls Vertex AI (Gemini 1.5 Flash) using a strict JSON response schema, passing the plain-text body and prompting the model to summarize, extract TODO tasks, identify classification tags, and format the body into clean Markdown.
     * The model returns a structured JSON object containing: `summary`, `tasks`, `tags`, and `cleanMarkdown`.
     * The service compiles the final note with a YAML frontmatter section (`type: email-capture`, `sender`, `subject`, `timestamp`, `email-link`) followed by the email links, summaries, extracted checkbox tasks (`- [ ] task`), and the cleaned Markdown body. It appends the classification tags as hashtags to the end of the text body.
     * It writes the file to the `Obsidian Staging` folder in Google Drive. This immediately fires the Drive watch webhook (**CUJ-1**), running the Plaud worker to clean, rename, and route the file to `Obsidian Vault/<subfolder>` using the appended hashtags.
     * It calls the Gmail API to modify the message labels: removing `to-obsidian` and adding `processed-to-obsidian`.
     * It updates the Firestore document status to `completed`.
4. **Postconditions:**
   * The email is written as a structured `.md` file in Google Drive, containing an email link, summary, checkbox tasks, and body.
   * The file is automatically picked up, renamed, and routed by the Plaud worker into the appropriate vault subfolder.
   * The `to-obsidian` label is removed from the Gmail thread, and `processed-to-obsidian` is applied.
   * Firestore logs the email as `completed` to prevent reprocessing.

---

## **CUJ-4: Gmail OAuth 2.0 Web Handshake**

### **Overview**
A one-time user-guided setup flow that grants the Cloud Run processor permissions to read and modify labels on the user's Gmail account, secured via allowed email verification.

**Handshake Data Flow:**
1. **Access Trigger:** Admin navigates to `/auth/gmail`.
2. **Consent Redirect:** The endpoint redirects the user to the Google Consent Screen requesting permissions to read and modify labels offline.
3. **Callback Handling:** Admin signs in and authorizes. Google redirects to `/auth/gmail/callback?code=AUTHORIZATION_CODE`.
4. **Token Exchange:** The callback exchanges the code for OAuth credentials and the permanent refresh token.
5. **Guard Check:** The endpoint instantiates a Gmail client and queries `gmail.users.getProfile({ userId: 'me' })`.
   - **Allowed Email Match:** If the profile email Address matches the `ALLOWED_EMAIL` environment variable, the refresh token is saved to Secret Manager under `GMAIL_USER_REFRESH_TOKEN` and a success screen is displayed.
   - **Allowed Email Mismatch:** If the email does not match, a `403 Forbidden` error is returned and no token is saved.

### **Detailed Protocol**
1. **Preconditions:**
   * Google Cloud Project has the Gmail API enabled.
   * OAuth Credentials (Client ID and Client Secret) are created in GCP APIs & Services.
   * Secrets `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` are stored in Google Secret Manager.
   * Cloud Run service account has permissions to add new versions to the secret `GMAIL_USER_REFRESH_TOKEN` (`roles/secretmanager.secretVersionAdder`).
   * The plaintext environment variable `ALLOWED_EMAIL` is set on the container configuration.
2. **Trigger:** Admin navigates to `https://<domain>/auth/gmail` to kick off authentication.
3. **Execution Steps:**
   * The endpoint generates an authorization URL with scopes `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.modify`.
   * It configures `access_type: 'offline'` and `prompt: 'consent'` to ensure a refresh token is issued.
   * The admin is redirected to Google's authentication page, signs in, and authorizes the application.
   * Google redirects the browser back to `https://<domain>/auth/gmail/callback?code=AUTHORIZATION_CODE`.
   * The `/auth/gmail/callback` route intercepts the code and exchanges it for credentials.
   * It instantiates a temporary Gmail client using the tokens and queries `gmail.users.getProfile({ userId: 'me' })`.
   * It extracts the authenticated user's email address and compares it to `process.env.ALLOWED_EMAIL`.
   * If it matches, the endpoint calls the Secret Manager API to write this token as a new version under the secret ID `GMAIL_USER_REFRESH_TOKEN` and displays a success screen.
   * If it does not match, it rejects the login with `403 Forbidden` and does not save the token.
4. **Postconditions:**
   * Secret Manager contains the user's permanent OAuth 2.0 refresh token (only if the user matched the allowed email).
   * The service is now capable of performing background operations on behalf of the user's Gmail mailbox.

---

## **CUJ-5: Gmail Watch Channel Renewal**

### **Overview**
A background routine integrated into the existing renewal flow that periodically calls `gmail.users.watch` to renew the push notification subscription before Google's 7-day expiration ceiling is reached.

### **Detailed Protocol**
1. **Preconditions:**
   * The OAuth 2.0 handshake is complete (**CUJ-4**).
   * Pub/Sub topic `gmail-inbox-updates` exists and contains permissions allowing Google to publish events.
   * A Cloud Scheduler job is set up to trigger `/renew-watch` every 12 hours.
2. **Trigger:** Scheduler cron hits the execution threshold.
3. **Execution Steps:**
   * Cloud Scheduler sends an OIDC-authenticated POST request to `/renew-watch`.
   * The endpoint verifies the token, resolves the Google Drive watch channel, and updates it as usual.
   * The endpoint then fetches Gmail OAuth credentials and the refresh token from Secret Manager.
   * It instantiates the Gmail API client.
   * It calls `gmail.users.watch` specifying:
     * Topic Name: `projects/<project-id>/topics/gmail-inbox-updates`
     * Label Filter: `to-obsidian` (to only receive notifications when this label is added/modified).
   * It receives a response containing the new watch `historyId` and `expiration` timestamp (epoch milliseconds).
   * It logs the new subscription details and returns `200 OK`.
4. **Postconditions:**
   * Both the Google Drive and the Gmail push notification subscriptions are renewed.
   * Real-time events will continue to trigger **CUJ-3**.
