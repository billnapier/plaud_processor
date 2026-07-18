# **System Design Specification: Event-Driven Gmail Ingestion & LLM Processing Engine**

This document provides a comprehensive technical blueprint for extending the existing **plaud\_processor** architecture. The goal is to ingest emails labeled in Gmail (e.g., to-obsidian) in near-real-time, route them through Gemini (via Vertex AI) for automated summarization and structured Markdown formatting, and write them directly to your Google Drive "Obsidian Staging" directory.  
This specification is fully detailed so that **Google Antigravity** can implement it end-to-end without needing to redesign the system architecture.

## **1\. Architectural Blueprint & Data Flow**

The architecture transitions from standard polling to a secure, real-time, event-driven push architecture.

\[Gmail Client\] ──(Label Added)──\> \[Gmail Push Service\]  
                                        │  
                                 (Pub/Sub Event)  
                                        ▼  
\[Google Drive\] \<──(Write File)── \[Cloud Run Service\] \<──(Push Delivery)── \[Pub/Sub Topic\]  
       │                                │  
 (DriveSync)                       (IAM Auth) ──\> \[Vertex AI (Gemini)\]  
       ▼                                │  
\[Android Vault\]                    (State Sync) ──\> \[Firestore DB\]

### **High-Level Execution Sequence:**

1. You label a Gmail thread as to-obsidian on your Android device or desktop.  
2. Gmail's webhook service pushes a notification to a Google Cloud **Pub/Sub Topic**.  
3. Pub/Sub pushes the message event to a secure endpoint on your **Cloud Run plaud\_processor** service.  
4. The service fetches the email payload using a secure **OAuth 2.0 Refresh Token** stored in **Google Secret Manager**.  
5. The raw body is passed to **Vertex AI (Gemini)** using strict JSON schema outputs to parse frontmatter and clean up the body.  
6. The service writes a structured Markdown file to the Google Drive **Obsidian Staging** folder.  
7. **Firestore** logs the messageId to guarantee exactly-once processing (deduplication).

## **2\. Infrastructure & Terraform Requirements**

To support this pipeline, the following resources and permissions must be added to your Terraform configurations:

### **A. Google Cloud Pub/Sub**

* **Pub/Sub Topic:** gmail-inbox-updates  
* **Pub/Sub Subscription:** A push subscription targeting your Cloud Run URL at https://\[your-service-url\]/webhooks/gmail.  
* **Authentication:** Enable Pub/Sub to authenticate requests to your Cloud Run service using an OIDC token matching the Cloud Run service account.

### **B. IAM & Service Account Permissions**

The Cloud Run Service Account requires the following Google Cloud roles:

* **Vertex AI User (roles/aiplatform.user):** Allows passwordless API requests to Gemini models on Vertex AI.  
* **Secret Manager Secret Accessor (roles/secretmanager.secretAccessor):** Allows the service to read the Gmail API Client ID, Client Secret, and your saved User Refresh Token.  
* **Firestore User (roles/datastore.user):** For logging processed thread/message IDs to prevent double-execution.

## **3\. The Authentication Layer (Gmail API OAuth 2.0)**

Since App Passwords are restricted to legacy protocols and cannot be used with the RESTful Gmail API, the service must execute OAuth 2.0 authentication.

### **A. One-Time Web Handshake Engine**

Antigravity must build a lightweight OAuth web callback route directly inside plaud\_processor. This endpoint will only be visited once during setup:

1. **Endpoint /auth/gmail:** Generates a Google Auth URL asking for the gmail.readonly and gmail.modify scopes. It must set access\_type: 'offline' and prompt: 'consent' to guarantee Google returns a permanent **Refresh Token**.  
2. **Endpoint /auth/gmail/callback:** Captures the authorization code from the redirect query, exchanges it for the tokens via Google's auth library, and automatically writes the returned refresh\_token into **Google Secret Manager** (under the secret ID GMAIL\_USER\_REFRESH\_TOKEN).

### **B. Execution Token Refresh Flow**

For standard operations, the service uses the stored refresh\_token to generate ephemeral access\_token credentials on the fly using GCP's native metadata server and google-auth-library in TypeScript:

import { google } from 'googleapis';

export async function getGmailClient(secretManagerClient: any) {  
  // 1\. Fetch secrets from Secret Manager  
  const \[clientId, clientSecret, refreshToken\] \= await Promise.all(\[  
    fetchSecret('GMAIL\_CLIENT\_ID'),  
    fetchSecret('GMAIL\_CLIENT\_SECRET'),  
    fetchSecret('GMAIL\_USER\_REFRESH\_TOKEN')  
  \]);

  const oauth2Client \= new google.auth.OAuth2(clientId, clientSecret, 'YOUR\_REDIRECT\_URI');  
  oauth2Client.setCredentials({ refresh\_token: refreshToken });

  return google.gmail({ version: 'v1', auth: oauth2Client });  
}

## **4\. The Ingestion & Processing Pipeline**

When Pub/Sub triggers the /webhooks/gmail route, the route must handle ingestion, parsing, AI generation, and final sync.

### **Step 1: Webhook Handling & Deduplication**

The webhook request body will look like this:

{  
  "message": {  
    "data": "eyJlcWFpbEFkZHJlc3MiOiAidXNlckBlbWFpbC5jb20iLCAiaGlzdG9yeUlkIjogMTIzNDV9",  
    "messageId": "987654321"  
  }  
}

* **Action:** Decode the base64 data string to get the historyId.  
* **State Check:** Fetch the partial history from the Gmail API or directly list all messages currently containing the to-obsidian label.  
* **Deduplication:** For each discovered messageId, query Firestore. If the message exists in the processed\_emails collection, skip it. If not, transactionally write it with a status of processing.

### **Step 2: Extracting Clean Content**

Use the Gmail API to retrieve the full message payload (gmail.users.messages.get).

* Antigravity must write a robust utility parser to strip multipart MIME encodings, converting HTML bodies or rich-text threads into clean, unformatted plain-text strings. This keeps the input token payload to Gemini as lean as possible.

### **Step 3: Vertex AI & Structured Outputs Orchestration**

Initialize the @google-cloud/vertexai SDK. Because we want clean Markdown and highly accurate metadata properties to conform to your Obsidian vaults, enforce a strict JSON Schema using **Gemini 1.5 Pro** or **Gemini 1.5 Flash**.

#### **Vertex AI JSON Schema Definition:**

const responseSchema \= {  
  type: 'OBJECT',  
  properties: {  
    title: { type: 'STRING', description: 'A clean, short, descriptive file name' },  
    tags: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Extracted topics formatted as single-word tags' },  
    frontmatter: {  
      type: 'OBJECT',  
      properties: {  
        type: { type: 'STRING', enum: \['email-capture'\] },  
        sender: { type: 'STRING' },  
        date: { type: 'STRING', description: 'ISO 8601 Date (YYYY-MM-DD)' },  
        subject: { type: 'STRING' },  
      },  
      required: \['type', 'sender', 'date', 'subject'\]  
    },  
    cleanMarkdown: { type: 'STRING', description: 'The body of the email reformatted into clean Markdown' }  
  },  
  required: \['title', 'tags', 'frontmatter', 'cleanMarkdown'\]  
};

#### **The Prompt:**

*"You are an expert personal data assistant. Analyze the following raw email payload. Extract key metadata, identify important tags, strip out all mailing-list footers, unsubscribe links, and conversational signatures, and format the core content into neat, semantic Markdown. Return your response matching the requested JSON schema exactly."*

## **5\. File Delivery & Android Synchronization**

### **A. Writing to Google Drive**

Once Gemini yields the structured JSON, the service compiles the final Markdown output:

\---  
type: email-capture  
sender: "John Doe \<john@example.com\>"  
date: 2026-07-16  
subject: "Project Update Discussion"  
tags: \[project/updates, coordination\]  
\---

\# Project Update Discussion

\[Cleaned email body goes here...\]

* **Google Drive API:** Connect using your application credentials.  
* **Save Location:** Create the file using the format YYYY-MM-DD \- \[Title\].md in your "Obsidian Staging" Google Drive folder.  
* **Post-Processing Cleanup:** Once Google Drive confirms the file creation, call the Gmail API to remove the to-obsidian label and add processed-to-obsidian (to ensure your inbox stays clean and to prevent reprocessing).

### **B. Downstream Android Sync**

Because the final file is saved to Google Drive, your existing **DriveSync** setup takes over. The next time you trigger your 1-Tap Manual Sync widget on your Android home screen, the newly formatted Markdown file will be synced directly into your local vault directory /Internal Storage/Obsidian Vault/.

## **6\. Implementation Checklist for Antigravity**

When you start your session with Antigravity, hand them this checklist to execute the implementation step-by-step:

* **Infrastructure Setup:** Create Terraform configurations for the GCP Pub/Sub topic and subscription targeting the Cloud Run webhook endpoint. Include IAM policy bindings for Vertex AI, Firestore, and Secret Manager.  
* **Secret Provisioning:** Store the Gmail CLIENT\_ID and CLIENT\_SECRET inside Secret Manager.  
* **TypeScript OAuth Modules:** Build the /auth/gmail and /auth/gmail/callback endpoints in plaud\_processor to capture the persistent refresh token and save it to Secret Manager.  
* **Webhook Endpoint:** Implement /webhooks/gmail to capture incoming events, decode base64 payloads, and resolve message lists.  
* **Firestore State Management:** Build the deduplication check inside Firestore using a processed\_emails collection.  
* **MIME Email Parser:** Integrate a robust body extractor (e.g., using mailparser) to clean MIME/HTML strings before passing them to Vertex AI.  
* **Vertex AI Integration:** Implement the @google-cloud/vertexai SDK call utilizing Gemini 1.5 Pro with the strict structured JSON schema defined in Section 4\.  
* **Drive Integration:** Write code using googleapis to construct the final Markdown string and write it to the specified Google Drive Staging folder ID.  
* **Gmail Cleanup:** Add code to safely remove the to-obsidian label from processed threads via the Gmail API once execution is fully completed.