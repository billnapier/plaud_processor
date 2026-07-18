# Blueprint: Automated PLAUD to Obsidian Workflow V3



This document serves as the absolute master blueprint for your active knowledge-management ecosystem. It maps out how data flows from your PLAUD hardware into Obsidian via Zapier and DriveSync, and outlines your project and task configurations with integrated project-tracking enhancements.

## 1. The Voice-to-Note Pipeline (PLAUD ➔ DriveSync ➔ Obsidian)



The core objective of this pipeline is to capture audio via PLAUD, apply context-specific summaries using native automation triggers, standardize file names with full years, and drop them into an Android-compatible cloud directory.

**[PLAUD Audio Captured] ➔ [Summary Generated] ➔ [Zapier Delivery] ➔ [Google Drive (Staging)] ➔ [GCP Cloud Run / Pub/Sub (Processing & Routing)] ➔ [Google Drive (Vault)] ➔ [Local Storage (via DriveSync/rclone)] ➔ [Obsidian Vault]**

### A. Template Ingestion & Keyword Triggers



The system utilizes PLAUD’s native template framework, specifically optimizing configurations that guarantee the inclusion of mandatory topical tags and to-do action items within the generated text body. These tags are strictly required for the downstream GCP Cloud Run processor to accurately categorize and route the files.

* **Automation:** PLAUD’s Keyword Trigger functionality acts as the routing mechanism. It automatically fires the correct template configuration based on spoken words or phrases recognized during processing.



### B. The Automation & Transformation Layer (Zapier)



When the transcript is finalized, an active Zap captures the data payload. In this workflow, Zapier acts exclusively as a delivery agent, dropping raw markdown files into the "Obsidian Staging" folder with no text transformations or date normalization to await processing.

### C. The Processing Layer (GCP Cloud Run + Pub/Sub + Firestore)



A decoupled Node.js/TypeScript service deployed on GCP Cloud Run processes new files in the "Obsidian Staging" folder asynchronously, triggered by Google Drive webhook notifications and buffered via GCP Pub/Sub. The service automates data sanitization, date normalization, and routing:

* **Idempotency & Concurrent Locks:** The worker acquires a distributed processing lock in Firestore for each `fileId` prior to processing, avoiding race conditions and duplicate runs.

* **Ingestion Delay & Download:** Pauses for 5 seconds to ensure Google Drive writes are fully committed before downloading the content.

* **Artifact Cleanup:** Strips AI-generated markdown backticks and normalizes tag quotes (e.g., `'#FooBar'` -> `#FooBar`), ensuring clean rendering in Obsidian.

* **Date Expansion & Extraction:** Standardizes inline date patterns (like `MM-DD` or `DD-MM`) to `YYYY-MM-DD` using the current year. Resolves the target date chronologically from content metadata (`timestamp: <value>`), H1 title prefixes, original filename timestamps, or falls back to the current date.

* **Sanitization & Filename Composition:** Extracts the first H1 markdown heading as the base title (falling back to the original filename). Sanitizes the title for filesystem compatibility. Prepends the resolved date to the sanitized title (`YYYY-MM-DD - <Title>.md`). On name collisions in the target directory, it appends an incrementing suffix (e.g. `_1.md`) to maintain uniqueness.

* **Intelligent & Subfolder-Based Routing:** Routes files based on the hashtags found in the transcript body:
  * `#Journal` ➔ `/Journal` (uses a date-based filename fallback).
  * `#project/<ProjectName>` (case-insensitive) ➔ `/Project Updates/<ProjectName>` (recursively created if missing).
  * `#Project` or `#ProjectPlan` ➔ `/Projects`.
  * No matching tags ➔ `/Unfiled`.



### D. Android Sync Architecture (DriveSync)



Because Obsidian requires local file system access, the Android storage pipeline utilizes Autosync for Google Drive (DriveSync):

* A physical directory is provisioned in Android internal storage: /Internal Storage/Obsidian Vault/.


* DriveSync runs a Strict Two-Way Sync connecting this local directory directly to the target Google Drive folder.


* **The Workflow Workaround:** Because the free tier of DriveSync is limited to a 60-minute automatic background check, a 1-Tap Manual Sync Widget is configured directly on the Android home screen. Tapping this icon forces an immediate, automated sync before opening Obsidian, bypassing the timer constraint entirely.



### E. Linux & Desktop Sync Architecture (rclone)



For desktop and Linux environments, the system utilizes rclone --bisync to perform a bi-directional sync between the Google Drive folder and the local Obsidian vault, ensuring that changes are identical across all devices.

---

## 2. Task Management Architecture (To-Dos in Obsidian)



To-dos live directly within your transcripts, logs, and notes using standard Markdown checkboxes (- [ ]). To keep the pipeline fluid and free of hard deadline pressures, the architecture prioritizes intentional execution via **Scheduled Dates** rather than high-urgency due dates.

* **Contextual & Intentional Linking:** Tasks are scheduled using Obsidian's Tasks plugin conventions, using the scheduled emoji (⏳):
* [ ] Review cloud infrastructure automation scripts for [[Project Titan Hub]] ⏳ 2026-06-12




* **Centralized Query Dashboard:** The Tasks community plugin pulls together your active workflow based on intention. Your master dashboard utilizes a query that brings scheduled work into focus without rigid deadline friction:


```tasks
not done
scheduled before in 1 week
sort by scheduled

```


* **System Maintenance & Recurring Routines:** To ensure operational habits don't slip through the cracks, recurring system tasks are hosted in a dedicated Meta/System Maintenance.md note. These utilize the Tasks plugin recurrence format (🔁) alongside the scheduled date (⏳):


* [ ] 🔁 every week ⏳ 2026-07-05 Triage outstanding projects and allocate next actions as per [[#C. Inline Weekly Triage Protocol]]




* When you mark this task as complete during your weekly review, the Tasks plugin automatically logs the completion and generates a brand-new instance scheduled for the following week, ensuring it seamlessly appears in your Centralized Query Dashboard when its target week arrives.





---

## 3. Automated Project Tracking System



Project tracking uses a flat-file database design powered by folder segregation, frontmatter metadata, and lightweight plugin queries, maximizing efficiency on both mobile and desktop screens.

### A. Project Hub Page Blueprint

Each project is managed from a primary dashboard hub note. The note maps active tasks and update history dynamically using frontmatter variables and custom Obsidian plugin queries:

```yaml
---
type: project-hub
status: Active
priority: Medium
project-folder: 
---

# 🚀 Project: `$= dv.current().file.name`

## 📥 Untriaged Project Inbox
> [!info] These tasks were dictated via PLAUD and are waiting to be scheduled or moved during your weekly review.

```tasks
not done
path includes Project Updates/{{query.file.property('project-folder')}}
no scheduled date
short backlink
```

## All Incomplete Tasks
```tasks
not done
path includes Project Updates/{{query.file.property('project-folder')}}
short backlink
```

---

## 📅 Chronological Update History
```dataview
TABLE file.ctime AS "Date Dictated", summary AS "Key Focus"
FROM "Project Updates"
WHERE contains(file.path, this.project-folder)
SORT file.ctime DESC
LIMIT 15
```

## Update Status
[Contains Meta Bind Button blocks to Archive and Unarchive the project]
```


### B. Global Master Dashboard[cite: 1]
To keep a birds-eye view of your entire operational landscape, a global dashboard aggregates metadata from individual project pages[cite: 1]:

```dataview
TABLE status AS "Status", priority AS "Priority", project-folder AS "Folder Path"
FROM ""
WHERE type = "project-hub"
SORT status ASC, priority DESC

```

### C. Inline Weekly Triage Protocol



Your weekly review triage operates entirely via friction-free inline metadata updates, removing any need to manually cut, copy, or paste text block segments across pages:

1. Open the active project hub (e.g., Portugal Hub).


2. Scan the **Untriaged Project Inbox** section for newly dictated items.


3. Click the edit pencil icon directly on the rendered task line (or use Alt/Option + Click to instantly jump to the source transcript note line).


4. Assign an intentional **Scheduled Date (⏳)** to the item.


* **System Behavior:** The task automatically falls off the project hub's untriaged workspace (as it now possesses a scheduled date) and seamlessly wakes up inside your global **Master Task Tracker** dashboard exactly when its designated target week arrives, preserving its original dictation history.





### D. Navigation & System Enhancements



* **Hierarchical Navigation:** The Tags View Panel tracks your taxonomy tree. Slashes included by PLAUD's templates are automatically parsed into clean, collapsible nested structures.


* **Tag Wrangler Plugin:** Allows you to right-click and batch-rename tags globally across the local vault at once.


* **Chronology Plugin:** Placed in the right-hand sidebar to provide a visual timeline layout of all document activity by date.

### E. Project Archiving & Lifecycle Management

To handle recurring projects (such as annual trips or repeating project names) and prevent historical notes or tasks from mixing with future iterations, the vault implements a local archiving protocol:

1. **Physical Folder Archiving:** The active project folder (e.g., `/Project Updates/tennessee`) is suffix-renamed to include the current year (e.g., `/Project Updates/tennessee-2026`). All existing internal links to files inside this directory are preserved by Obsidian.
2. **Metadata Freezing:** The project hub note's frontmatter properties are updated to set `status: Archived` and redirect the `project-folder` query path to the renamed directory.
3. **Note Archiving:** The project hub note itself is renamed to include the year (e.g., `Tennessee 2026.md`) to finalize the archive.
4. **Active Workspace Reset:** A new active note can then be cleanly created at the original path to start the next project cycle. The Cloud Run routing engine will automatically spin up a fresh, empty `/Project Updates/tennessee` folder the next time the active project tag is dictated.

This lifecycle is automated via local Meta Bind action buttons embedded directly within the active project hub pages.

