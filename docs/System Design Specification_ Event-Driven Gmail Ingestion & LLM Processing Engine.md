# **System Design Specification: Event-Driven Gmail Ingestion & LLM Processing Engine**

This document provides a comprehensive technical blueprint for extending the existing **plaud_processor** architecture. The goal is to ingest emails labeled in Gmail (e.g., `to-obsidian`) in near-real-time, route them through Gemini (via Vertex AI) for automated summarization, structured Markdown task (TODO) extraction, and email linking, and write them directly to your Google Drive `Obsidian Staging` directory. 

From staging, the existing Plaud worker will take over to perform regex cleanup, date/title normalization, and final routing to the target folder in `Obsidian Vault`.

---

## **1. Architectural Blueprint & Data Flow**

The architecture transitions from standard polling to a secure, real-time, event-driven push architecture.

```
[Gmail Client] ──(Label Added)──> [Gmail Push Service]
                                        │
                                 (Pub/Sub Event)
                                        ▼
[Google Drive] <──(Write File)── [Cloud Run Service] <──(Push Delivery)── [Pub/Sub Topic]
       │                                │
 (Drive Webhook)                    (IAM Auth) ──> [Vertex AI (Gemini)]
       ▼                                │
[Plaud Worker]                      (State Sync) ──> [Firestore DB]
       │
 (Move File) ──> [Obsidian Vault] ──(DriveSync) ──> [Android/Linux Vault]
```

### **High-Level Execution Sequence:**

1. You label a Gmail thread as `to-obsidian` on your Android device or desktop.
2. Gmail's webhook service pushes a notification to the Google Cloud Pub/Sub Topic `gmail-inbox-updates`.
3. Pub/Sub pushes the message event to a secure endpoint `/webhooks/gmail` on your Cloud Run service.
4. The service fetches the email payload using a secure **OAuth 2.0 Refresh Token** stored in **Google Secret Manager**.
5. The raw body is passed to **Vertex AI (Gemini 1.5 Flash)** using `@google/genai` with strict JSON schema outputs to parse frontmatter, summarize, extract TODO items, and clean up the body.
6. The service compiles the markdown file, appends the extracted tags as hashtags at the end of the body, and writes it to `Obsidian Staging` with a temporary name.
7. Firestore logs the `messageId` to guarantee exactly-once processing (deduplication).
8. Google Drive triggers the standard Plaud `/webhook` on the staging folder, running the `/pubsub-worker` to sanitize, rename (`YYYY-MM-DD - [Subject].md`), and route the file to its destination folder under `Obsidian Vault` based on the appended hashtags.
9. Gmail removes the `to-obsidian` label and adds `processed-to-obsidian`.

---

## **2. Infrastructure & Terraform Requirements**

To support this pipeline, the following resources and permissions must be added to your Terraform configurations:

### **A. Google Cloud Pub/Sub**
* **Pub/Sub Topic:** `gmail-inbox-updates`
* **Pub/Sub Subscription:** A push subscription targeting `/webhooks/gmail`.
* **Authentication:** Enable Pub/Sub to authenticate requests to your Cloud Run service using an OIDC token matching the Cloud Run service account.
* **Topic Permission:** Grant `roles/pubsub.publisher` on `gmail-inbox-updates` to the Gmail push service account:
  ```hcl
  resource "google_pubsub_topic_iam_member" "gmail_publisher" {
    topic  = google_pubsub_topic.gmail_inbox_updates.name
    role   = "roles/pubsub.publisher"
    member = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
  }
  ```

### **B. Secret Manager Container Provisioning**
Terraform must define the secret containers so that they exist in the project:
* `GMAIL_CLIENT_ID` (Secret containing OAuth client ID)
* `GMAIL_CLIENT_SECRET` (Secret containing OAuth client secret)
* `GMAIL_USER_REFRESH_TOKEN` (Secret where user refresh token is stored)

### **C. IAM & Service Account Permissions**
The Cloud Run Service Account (`app-runner`) requires the following roles:
* **Vertex AI User (roles/aiplatform.user):** Allows passwordless API requests to Gemini models on Vertex AI.
* **Secret Manager Secret Accessor (roles/secretmanager.secretAccessor):** Allows reading `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_USER_REFRESH_TOKEN`.
* **Secret Manager Secret Version Adder (roles/secretmanager.secretVersionAdder):** Allows the OAuth callback to write the newly exchanged refresh token to `GMAIL_USER_REFRESH_TOKEN`.
* **Firestore User (roles/datastore.user):** For logging processed message IDs.

---

## **3. The Authentication & Access Guard Layer (OAuth 2.0)**

To prevent unauthorized access, the public OAuth handler uses an email-based lock instead of passcodes.

### **A. Environment Variable Configuration**
Set `ALLOWED_EMAIL` (e.g. `yourname@gmail.com`) as an environment variable on the Cloud Run container. Since this is just a plaintext email, it does not need to be stored in Secret Manager.

### **B. Web Handshake Route & Callback**
1. **Endpoint `GET /auth/gmail`:**
   Generates a Google Auth URL asking for scopes `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.modify`. It must set `access_type: 'offline'` and `prompt: 'consent'` to guarantee Google returns a permanent refresh token.
2. **Endpoint `GET /auth/gmail/callback`:**
   * Captures the authorization code from the redirect query.
   * Exchanges the code for the access and refresh tokens.
   * Instantiates a temporary Gmail client using the returned tokens and calls `gmail.users.getProfile({ userId: 'me' })`.
   * Extracts `emailAddress` from the response.
   * If `emailAddress !== process.env.ALLOWED_EMAIL`, the handler aborts, returns `403 Forbidden`, and does not save any token.
   * If authorized, it writes the `refresh_token` into Google Secret Manager under the secret ID `GMAIL_USER_REFRESH_TOKEN`.

---

## **4. The Ingestion & Processing Pipeline**

When Pub/Sub triggers `/webhooks/gmail`, the route handles ingestion, deduplication, parsing, AI extraction, and delivery.

### **Step 1: Webhook Handling & Deduplication**
* **Action:** Decode the Pub/Sub base64 data envelope to retrieve history info.
* **State Check:** Call `gmail.users.messages.list` with query `label:to-obsidian` to list all pending message IDs.
* **Deduplication:** For each messageId, run a Firestore check against collection `processed_emails` (using `messageId` as document ID). If status is `processing` or `completed`, skip it. Otherwise, set status to `processing`.

### **Step 2: MIME Parsing**
* Retrieve the raw email payload using `gmail.users.messages.get({ id: messageId, format: 'full' })`.
* Parse the MIME payload (using `mailparser`) to extract the sender, date, subject, threadId, and plain-text body.
* Construct the direct link to the Gmail thread: `https://mail.google.com/mail/u/0/#all/${threadId}`.

### **Step 3: Gemini Orchestration & JSON Output**
Initialize the `@google/genai` client targeting Vertex AI. Use **Gemini 1.5 Flash** with the following JSON schema:

```typescript
const responseSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'A concise 2-3 sentence summary of the email context.' },
    tasks: { 
      type: 'ARRAY', 
      items: { type: 'STRING' }, 
      description: 'Action items or todo tasks extracted from the email body.' 
    },
    tags: { 
      type: 'ARRAY', 
      items: { type: 'STRING' }, 
      description: 'Extracted topics or folders. Example: project/updates, Journal, Project, ProjectPlan' 
    },
    cleanMarkdown: { type: 'STRING', description: 'The email body converted to clean, reader-friendly Markdown.' }
  },
  required: ['summary', 'tasks', 'tags', 'cleanMarkdown']
};
```

**The Prompt:**
> *"You are an expert personal data assistant. Analyze the following raw email payload. Extract a concise summary of the email, extract all actionable TODO items or tasks, determine the matching tags for classification, and convert the core body into clean, semantic Markdown. Return your response matching the requested JSON schema exactly."*

### **Step 4: Compiling the Document**
Compile the structured Markdown note containing the link, summary, tasks, and body:

```markdown
---
type: email-capture
sender: "<Sender Email>"
subject: "<Email Subject>"
timestamp: "<YYYY-MM-DD>"
email-link: "https://mail.google.com/mail/u/0/#all/<threadId>"
---

# <Email Subject>

## 📧 Email Details
- **Sender:** <Sender Name/Email>
- **Date:** <YYYY-MM-DD>
- **Link:** [View in Gmail](https://mail.google.com/mail/u/0/#all/<threadId>)

## 📝 Summary
<summary value from Gemini>

## ⏳ Action Items
- [ ] <task 1 from Gemini>
- [ ] <task 2 from Gemini>

---

<cleanMarkdown value from Gemini>

#<tag1 from Gemini> #<tag2 from Gemini>
```

*(Note: Appending hashtags to the end of the body ensures that when the Plaud worker downloads the note, its tag-based routing engine can classify and move the file automatically).*

---

## **5. File Delivery, Cleanup & Watch Renewal**

### **A. Saving to Google Drive**
* Save the compiled Markdown note to `Obsidian Staging` using a temporary name (e.g. `gmail-capture-${messageId}.md`).
* Google Drive sends a webhook event to `/webhook`, triggering the standard `/pubsub-worker`.
* The Plaud worker downloads the file, processes it, extracts the title from the H1, prepends the date, and routes it to `Obsidian Vault/<resolved-folder>` using the appended hashtags.
* Once the write is complete, the Gmail service removes the `to-obsidian` label and adds `processed-to-obsidian` on the thread.
* The Firestore status is set to `completed`.

### **B. Consolidating Watch Renewal**
Expand the existing `/renew-watch` endpoint (run every 12 hours) to renew the Gmail subscription watch:
* Get credentials and call `gmail.users.watch` with:
  ```json
  {
    "topicName": "projects/<project-id>/topics/gmail-inbox-updates",
    "labelIds": ["to-obsidian"]
  }
  ```
* Log the resulting watch `historyId` and the new 7-day expiration timestamp.

---

## **6. Implementation Checklist**

- [ ] **Terraform Configuration:**
  - [ ] Add the Pub/Sub topic `gmail-inbox-updates` and its push subscription.
  - [ ] Bind publishing rights on the topic to `serviceAccount:gmail-api-push@system.gserviceaccount.com`.
  - [ ] Provision Secret Manager containers for client credentials and user refresh tokens.
  - [ ] Grant `app-runner` the `secretVersionAdder` and `secretAccessor` roles.
  - [ ] Define the `ALLOWED_EMAIL` environment variable.
- [ ] **Dependencies:**
  - [ ] Add `@google/genai`, `mailparser`, and devDependencies `@types/mailparser` to `app/package.json`.
- [ ] **OAuth Web Handshake:**
  - [ ] Create `GET /auth/gmail` to redirect the user to Google's consent screen.
  - [ ] Create `GET /auth/gmail/callback` to verify the user matches `ALLOWED_EMAIL` via `getProfile()`, and write the refresh token.
- [ ] **Consolidated Watch Renewal:**
  - [ ] Update `POST /renew-watch` to execute `gmail.users.watch` and renew the Gmail notification channel alongside the Drive channel.
- [ ] **Webhook Processing Route:**
  - [ ] Implement `POST /webhooks/gmail` to process incoming messages.
  - [ ] Read messages with `label:to-obsidian`, check Firestore lock `processed_emails/{messageId}`, download, and parse MIME.
  - [ ] Integrate `@google/genai` (Gemini 1.5 Flash) with structured JSON schemas to summarize, extract tasks, and format markdown.
  - [ ] Append extracted tags as hashtags at the end of the markdown body.
  - [ ] Write the note to the `Obsidian Staging` folder to trigger the downstream Plaud worker.
  - [ ] Apply post-cleanup label modifications in Gmail on success.