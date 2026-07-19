import express, { Request, Response } from 'express';
import { google } from 'googleapis';
import { Firestore } from '@google-cloud/firestore';
import { PubSub } from '@google-cloud/pubsub';
import { v4 as uuidv4 } from 'uuid';
import { OAuth2Client } from 'google-auth-library';
import { simpleParser } from 'mailparser';
import { GoogleGenAI } from '@google/genai';

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

// Initialize Google Cloud clients
const db = new Firestore({
  projectId: process.env.PROJECT_ID,
});

const pubsub = new PubSub({
  projectId: process.env.PROJECT_ID,
});

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

const authClient = new OAuth2Client();

/**
 * Verifies the Google OIDC token provided in the Authorization header.
 * In a non-production environment, it allows skipping if no auth header is present.
 */
async function verifyOidcToken(req: Request): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production' && !req.headers.authorization) {
    console.log('Skipping OIDC verification in non-production local environment');
    return true;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error('Authorization header is missing or does not start with Bearer');
    return false;
  }

  const token = authHeader.split(' ')[1];
  const host = req.get('host');
  const protocol = req.protocol;
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const currentProtocol = isHttps ? 'https' : protocol;
  const audience = `${currentProtocol}://${host}${req.originalUrl}`;

  try {
    // Cloud Run and Pub/Sub can use different audiences depending on how they call the service.
    // We check both the full request URL and the base URL as potential audiences.
    console.log(`Verifying OIDC token. Expected audience: ${audience}`);
    const ticket = await authClient.verifyIdToken({
      idToken: token,
      audience: [audience, `${currentProtocol}://${host}`],
    });

    const payload = ticket.getPayload();
    if (!payload) return false;

    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
      console.error('Invalid token issuer:', payload.iss);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Token verification failed:', error);
    return false;
  }
}

/**
 * Finds a folder ID by name. Throws an error if not found.
 */
async function getRootFolder(folderName: string): Promise<string> {
  const query = `mimeType = 'application/vnd.google-apps.folder' and name = '${folderName.replace(/'/g, "\\'")}' and trashed = false`;
  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name, owners)',
    spaces: 'drive',
  });
  const files = response.data.files;
  if (!files || files.length === 0) {
    throw new Error(`Required folder "${folderName}" was not found. Please ensure it exists and is shared with the service account.`);
  }

  // Log all matching folders to assist in debugging
  console.log(`Found ${files.length} folder(s) matching "${folderName}":`);
  for (const f of files) {
    console.log(`- ID: ${f.id}, Owners: ${JSON.stringify(f.owners?.map(o => o.emailAddress))}`);
  }

  // Prefer folder owned by a user (not the service account itself) if possible
  const userOwnedFolder = files.find(f => f.owners?.some(o => o.emailAddress && !o.emailAddress.endsWith('.gserviceaccount.com')));
  if (userOwnedFolder) {
    console.log(`Using user-owned folder for "${folderName}": ${userOwnedFolder.id}`);
    return userOwnedFolder.id!;
  }

  console.log(`Using folder: ${files[0].id}`);
  return files[0].id!;
}

/**
 * Resolves or creates a folder by name under a given parent.
 */
async function getOrCreateFolder(folderName: string, parentId: string): Promise<string> {
  const query = `mimeType = 'application/vnd.google-apps.folder' and name = '${folderName.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed = false`;
  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    spaces: 'drive',
  });
  const files = response.data.files;
  if (files && files.length > 0) {
    return files[0].id!;
  }
  console.log(`Creating folder "${folderName}" under parent "${parentId}"`);
  const createResponse = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return createResponse.data.id!;
}

/**
 * Resolves a nested path of folders recursively under a root folder.
 */
async function resolvePath(pathParts: string[], rootFolderId: string): Promise<string> {
  let currentParentId = rootFolderId;
  for (const part of pathParts) {
    currentParentId = await getOrCreateFolder(part, currentParentId);
  }
  return currentParentId;
}

/**
 * Finds a unique filename in the target folder by appending an incrementing suffix on collision.
 * Retrieves all files in the directory to perform a case-insensitive check and avoid duplicate HTTP calls.
 */
async function getUniqueFileName(folderId: string, baseName: string, excludeFileId?: string): Promise<string> {
  const existingNames = new Set<string>();
  let pageToken: string | undefined = undefined;

  do {
    const response: any = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 1000,
      pageToken,
    });

    const files = response.data.files || [];
    for (const f of files) {
      if (f.name && f.id !== excludeFileId) {
        existingNames.add(f.name.toLowerCase());
      }
    }

    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  let name = baseName;
  let ext = '';
  const lastDot = baseName.lastIndexOf('.');
  if (lastDot !== -1) {
    name = baseName.substring(0, lastDot);
    ext = baseName.substring(lastDot);
  } else {
    ext = '.md';
  }

  let suffix = 0;
  while (true) {
    const candidateName = suffix === 0 ? `${name}${ext}` : `${name}_${suffix}${ext}`;
    if (!existingNames.has(candidateName.toLowerCase())) {
      return candidateName;
    }
    suffix++;
  }
}

/**
 * Cleans transcript content using defined regex post-processing rules.
 */
function cleanContent(content: string): string {
  const currentYear = new Date().getFullYear();
  let cleaned = content;

  // 1. Obsidian Tag Normalization: Fix quotes/backticks around hashtags
  cleaned = cleaned.replace(/['`](#\w+)['`]/g, '$1');

  // 2. Backtick Removal: Strip AI-protected backticks formatting
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');

  // 3. Date Expansion: Standardize inline MM-DD or DD-MM into YYYY-MM-DD
  cleaned = cleaned.replace(/(?<!\d{4}-)\b(\d{2})-(\d{2})\b/g, `${currentYear}-$1-$2`);

  return cleaned;
}

/**
 * Extracts the first H1 title (a line starting with '# ') from the markdown content.
 */
function extractTitleFromContent(content: string): string | null {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      const title = trimmed.substring(2).trim();
      if (title.length > 0) {
        return title;
      }
    }
  }
  return null;
}

/**
 * Sanitizes a filename to ensure compatibility with Google Drive, Windows, Linux, and Obsidian.
 * Replaces slashes/backslashes with dashes and removes other invalid/disallowed characters.
 */
function sanitizeFilename(name: string): string {
  // Replace slashes/backslashes with dashes
  let sanitized = name.replace(/[\/\\]/g, '-');
  // Remove other invalid characters: : * ? " < > |
  sanitized = sanitized.replace(/[:*?"<>|]/g, '');
  // Normalize consecutive whitespace to a single space
  sanitized = sanitized.replace(/\s+/g, ' ');
  return sanitized.trim();
}

/**
 * Extracts a date (YYYY-MM-DD) from the first "timestamp: foo" line in markdown content.
 */
function extractDateFromContent(content: string): string | null {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(?:-\s*)?timestamp:\s*(.+)$/i);
    if (match) {
      const val = match[1].trim().replace(/['"`]/g, '');

      // Try numeric timestamp digits (length must be 10 or 13)
      if (/^\d+$/.test(val) && (val.length === 10 || val.length === 13)) {
        let num = parseInt(val, 10);
        if (val.length === 10) {
          num *= 1000;
        }
        const d = new Date(num);
        if (!isNaN(d.getTime())) {
          return d.toISOString().split('T')[0];
        }
      }

      // Try standard Date parsing
      const d = new Date(val);
      if (!isNaN(d.getTime())) {
        return d.toISOString().split('T')[0];
      }

      // Regex fallback for YYYY-MM-DD
      const dateMatch = val.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
      if (dateMatch) {
        return `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
      }
    }
  }
  return null;
}

/**
 * Extracts a date (YYYY-MM-DD) from the filename if it is a timestamp.
 */
function extractDateFromFilename(filename: string): string | null {
  const nameWithoutExt = filename.replace(/\.md$/i, '').trim();

  // Try numeric timestamp digits (length must be 10 or 13)
  if (/^\d+$/.test(nameWithoutExt) && (nameWithoutExt.length === 10 || nameWithoutExt.length === 13)) {
    let num = parseInt(nameWithoutExt, 10);
    if (nameWithoutExt.length === 10) {
      num *= 1000;
    }
    const d = new Date(num);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  }

  // Try YYYY-MM-DD pattern
  const dateRegexMatch = nameWithoutExt.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (dateRegexMatch) {
    return `${dateRegexMatch[1]}-${dateRegexMatch[2]}-${dateRegexMatch[3]}`;
  }

  // General date parsing fallback for filenames at least 8 chars long
  const d = new Date(nameWithoutExt);
  if (!isNaN(d.getTime()) && nameWithoutExt.length >= 8) {
    return d.toISOString().split('T')[0];
  }

  return null;
}



interface RoutingResult {
  classification: string;
  pathParts: string[];
}

/**
 * Determines classification and folder path parts based on content tags.
 */
function classifyContent(content: string): RoutingResult {
  if (content.includes('#Journal')) {
    return {
      classification: 'Journal',
      pathParts: ['Journal'],
    };
  }

  const nestedProjectRegex = /#project\/([a-zA-Z0-9_\-]+)/i;
  const match = content.match(nestedProjectRegex);
  if (match) {
    const projectName = match[1];
    return {
      classification: `Project Updates/${projectName}`,
      pathParts: ['Project Updates', projectName],
    };
  }

  if (content.includes('#Project') || content.includes('#ProjectPlan')) {
    return {
      classification: 'Projects',
      pathParts: ['Projects'],
    };
  }

  return {
    classification: 'Unfiled',
    pathParts: ['Unfiled'],
  };
}

// Root path for status checks / smoke tests
app.get('/', (req: Request, res: Response) => {
  res.status(200).send('Plaud Processor is running');
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).send('OK');
});

/**
 * Helper to initialize and return the Gmail OAuth2 client.
 */
function getGmailOAuth2Client(req?: Request): any {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  
  let redirectUri = '';
  if (req) {
    const rawProto = (req.headers['x-forwarded-proto'] as string) || (req.secure ? 'https' : 'http');
    const protocol = rawProto.split(',')[0].trim();
    const rawHost = (req.headers['x-forwarded-host'] as string) || req.get('host') || 'plaud.billnapier.com';
    const host = rawHost.split(',')[0].trim();
    redirectUri = `${protocol}://${host}/auth/gmail/callback`;
  } else {
    const domain = process.env.DOMAIN_NAME || 'plaud.billnapier.com';
    redirectUri = `https://${domain}/auth/gmail/callback`;
  }

  if (!clientId || !clientSecret) {
    throw new Error('GMAIL_CLIENT_ID or GMAIL_CLIENT_SECRET environment variable is missing');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Resolves a Gmail label ID by name. If the label does not exist, it creates it.
 */
async function getOrCreateGmailLabel(gmail: any, labelName: string): Promise<string> {
  const response = await gmail.users.labels.list({ userId: 'me' });
  const labels = response.data.labels || [];
  const foundLabel = labels.find((l: any) => l.name?.toLowerCase() === labelName.toLowerCase());

  if (foundLabel) {
    console.log(`Found existing Gmail label "${labelName}" with ID: ${foundLabel.id}`);
    return foundLabel.id;
  }

  console.log(`Gmail label "${labelName}" not found. Creating it...`);
  const createResponse = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  console.log(`Successfully created Gmail label "${labelName}" with ID: ${createResponse.data.id}`);
  return createResponse.data.id!;
}

// GET /auth/gmail - Redirect to Google consent screen
app.get('/auth/gmail', (req: Request, res: Response) => {
  try {
    const oauth2Client = getGmailOAuth2Client(req);
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
    ];
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
    });
    res.redirect(authUrl);
  } catch (error: any) {
    console.error('Failed to generate Gmail auth URL:', error);
    res.status(500).send(`Error: ${error.message || String(error)}`);
  }
});

// GET /auth/gmail/callback - Handle the OAuth 2.0 redirect
app.get('/auth/gmail/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send('Missing authorization code');
    return;
  }

  try {
    const oauth2Client = getGmailOAuth2Client(req);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profileResponse = await gmail.users.getProfile({ userId: 'me' });
    const emailAddress = profileResponse.data.emailAddress;

    if (!emailAddress) {
      console.error('Failed to retrieve user email profile');
      res.status(400).send('Unable to retrieve user email profile from Gmail API');
      return;
    }

    const allowedEmail = process.env.ALLOWED_EMAIL;
    if (!allowedEmail) {
      console.error('ALLOWED_EMAIL environment variable is not defined');
      res.status(500).send('Server configuration error: ALLOWED_EMAIL is not set');
      return;
    }

    if (emailAddress.toLowerCase() !== allowedEmail.toLowerCase()) {
      console.warn(`Unauthorized login attempt by: ${emailAddress} (Expected: ${allowedEmail})`);
      res.status(403).send('Forbidden: Email is not authorized.');
      return;
    }

    if (!tokens.refresh_token) {
      console.error('No refresh token returned in OAuth exchange.');
      res.status(400).send('Failed to obtain a refresh token. Please try again and ensure consent is granted.');
      return;
    }

    // Initialize Secret Manager client
    const secretManagerAuth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const secretmanager = google.secretmanager({ version: 'v1', auth: secretManagerAuth });
    const projectId = process.env.PROJECT_ID || await secretManagerAuth.getProjectId();

    console.log(`Writing Gmail refresh token to Secret Manager for project: ${projectId}`);
    await secretmanager.projects.secrets.addVersion({
      parent: `projects/${projectId}/secrets/GMAIL_USER_REFRESH_TOKEN`,
      requestBody: {
        payload: {
          data: Buffer.from(tokens.refresh_token).toString('base64'),
        },
      },
    });

    console.log('Successfully saved GMAIL_USER_REFRESH_TOKEN to Secret Manager');
    res.status(200).send('Gmail authentication setup complete. You can now close this window.');
  } catch (error: any) {
    console.error('Failed to complete Gmail authentication callback:', error);
    res.status(500).send(`Error: ${error.message || String(error)}`);
  }
});

// POST /webhook (Public, called by Google Drive Push Notification)
app.post('/webhook', async (req: Request, res: Response) => {
  console.log('Received webhook headers:', req.headers);
  const channelId = req.headers['x-goog-channel-id'] as string;
  const resourceId = req.headers['x-goog-resource-id'] as string;
  const resourceState = req.headers['x-goog-resource-state'] as string;

  console.log(`Webhook Event - Channel: ${channelId}, Resource: ${resourceId}, State: ${resourceState}`);

  if (resourceState === 'sync') {
    console.log('Sync event received. Acknowledging channel verification.');
    res.status(200).send('Sync acknowledged');
    return;
  }

  if (resourceState === 'add' || resourceState === 'update') {
    try {
      const topicName = 'drive-file-changes';
      const dataBuffer = Buffer.from(
        JSON.stringify({
          channelId,
          resourceId,
          resourceState,
        })
      );

      console.log(`Publishing message to topic: ${topicName}`);
      await pubsub.topic(topicName).publishMessage({ data: dataBuffer });
      console.log(`Published event to Pub/Sub successfully.`);
    } catch (error) {
      console.error('Failed to publish message to Pub/Sub:', error);
      res.status(500).send('Internal Server Error: Failed to publish event');
      return;
    }
  }

  res.status(200).send('Webhook received and acknowledged');
});

// POST /pubsub-worker (Private, triggered by Pub/Sub Push subscription)
app.post('/pubsub-worker', async (req: Request, res: Response) => {
  console.log('Pub/Sub worker triggered. Body:', req.body);

  const isAuthorized = await verifyOidcToken(req);
  if (!isAuthorized) {
    res.status(401).send('Unauthorized');
    return;
  }

  // PAUSE FOR 5 SECONDS: Ensures Google Drive has finished writing the file content
  console.log('Pausing for 5 seconds to ensure Google Drive writes are complete...');
  await new Promise((resolve) => setTimeout(resolve, 5000));

  let eventDetails = {};
  if (req.body && req.body.message && req.body.message.data) {
    try {
      const decodedData = Buffer.from(req.body.message.data, 'base64').toString('utf-8');
      eventDetails = JSON.parse(decodedData);
      console.log('Decoded Pub/Sub event details:', eventDetails);
    } catch (decodeError) {
      console.error('Failed to decode Pub/Sub message data:', decodeError);
    }
  }

  try {
    const stagingFolderName = process.env.STAGING_FOLDER_NAME || 'Obsidian Staging';
    const vaultFolderName = process.env.VAULT_FOLDER_NAME || 'Obsidian Vault';

    const stagingFolderId = await getRootFolder(stagingFolderName);
    const vaultFolderId = await getRootFolder(vaultFolderName);

    // List all files currently in the watched Obsidian Staging folder
    const listResponse = await drive.files.list({
      q: `'${stagingFolderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      spaces: 'drive',
    });

    const files = listResponse.data.files || [];
    console.log(`Found ${files.length} active files in staging folder: ${stagingFolderName}`);

    for (const file of files) {
      if (!file.id || !file.name) continue;

      console.log(`Evaluating staging file: ${file.name} (ID: ${file.id}, mimeType: ${file.mimeType})`);

      // Filter by mimeType text/plain or extension .md
      const isTxt = file.mimeType === 'text/plain';
      const isMd = file.name.endsWith('.md');
      if (!isTxt && !isMd) {
        console.log(`Skipping invalid file: ${file.name} (mimeType: ${file.mimeType})`);
        continue;
      }

      const fileRef = db.collection('processed_files').doc(file.id);

      // Acquire distributed lock via transaction
      const acquired = await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(fileRef);
        const now = new Date();
        if (doc.exists) {
          const data = doc.data();
          if (data) {
            if (data.status === 'completed') {
              console.log(`File lock check: ${file.name} is already marked as completed in Firestore.`);
              return false;
            }
            if (data.status === 'processing') {
              const lockedAt = data.lockedAt?.toDate();
              if (lockedAt && (now.getTime() - lockedAt.getTime()) < 15 * 60 * 1000) {
                console.log(`File lock check: ${file.name} is currently locked for processing (locked at ${lockedAt.toISOString()}).`);
                return false;
              } else {
                console.log(`File lock check: ${file.name} lock has expired. Re-acquiring lock.`);
              }
            }
          }
        }
        transaction.set(fileRef, {
          status: 'processing',
          fileName: file.name,
          lockedAt: now,
        }, { merge: true });
        return true;
      });

      if (!acquired) {
        console.log(`Skipping file ${file.name} (ID: ${file.id}) - lock not acquired.`);
        continue;
      }

      console.log(`Processing file: ${file.name} (ID: ${file.id})`);

      try {
        // Download file content
        const contentResponse = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'text' }
        );
        const content = contentResponse.data as string;
        if (!content || content.trim().length === 0) {
          console.log(`File ${file.name} is empty (syncing). Releasing lock for retry.`);
          await fileRef.delete();
          continue;
        }

        // Apply cleaning and classification
        const cleaned = cleanContent(content);
        const { classification, pathParts } = classifyContent(cleaned);

        // Resolve target directory under Obsidian Vault
        const targetFolderId = await resolvePath(pathParts, vaultFolderId);

        // Resolve base filename (extracted H1 title or fallback name)
        let baseName = '';
        const markdownTitle = extractTitleFromContent(cleaned);
        if (markdownTitle) {
          baseName = sanitizeFilename(markdownTitle);
        } else {
          // Fallback to original name without extension
          let fallbackName = file.name.replace(/\.md$/, '').trim();
          if (classification === 'Journal') {
            const currentYear = new Date().getFullYear();
            const inlineDateRegex = /(?<!\d{4}-)\b(\d{2})-(\d{2})\b/g;
            const tempName = fallbackName.replace(inlineDateRegex, `${currentYear}-$1-$2`);
            const cleanTempName = tempName.trim();
            if (!cleanTempName || cleanTempName === '.md' || cleanTempName.trim() === '') {
              baseName = 'Journal Note';
            } else {
              baseName = sanitizeFilename(tempName);
            }
          } else {
            baseName = sanitizeFilename(fallbackName);
          }
        }

        // Safeguard for empty base name
        if (!baseName) {
          baseName = 'Plaud Note';
        }

        // Resolve date (from content, title prefix, filename, or current time)
        let fileDate = extractDateFromContent(cleaned);
        if (!fileDate) {
          const baseNameDateMatch = baseName.match(/^(\d{4}-\d{2}-\d{2})\b/);
          if (baseNameDateMatch) {
            fileDate = baseNameDateMatch[1];
          }
        }
        if (!fileDate) {
          fileDate = extractDateFromFilename(file.name);
        }
        if (!fileDate) {
          fileDate = new Date().toISOString().split('T')[0];
        }

        // Prepend date if not already at the start of baseName
        let targetFileName = '';
        const datePattern = fileDate.replace(/-/g, '');
        if (baseName.startsWith(fileDate)) {
          targetFileName = `${baseName}.md`;
        } else if (baseName.startsWith(datePattern)) {
          targetFileName = `${baseName}.md`;
        } else {
          targetFileName = `${fileDate} - ${baseName}.md`;
        }

        // Double check extension normalization
        if (!targetFileName.endsWith('.md')) {
          if (targetFileName.endsWith('.txt')) {
            targetFileName = targetFileName.substring(0, targetFileName.length - 4) + '.md';
          } else {
            targetFileName = targetFileName + '.md';
          }
        }

        const uniqueFileName = await getUniqueFileName(targetFolderId, targetFileName, file.id);
        console.log(`Updating file ${file.name} to ${uniqueFileName} with cleaned content`);

        // Update file content and metadata in Drive
        await drive.files.update({
          fileId: file.id,
          requestBody: {
            name: uniqueFileName,
            mimeType: 'text/markdown',
          },
          media: {
            mimeType: 'text/markdown',
            body: cleaned,
          },
        });

        // Move file parent
        console.log(`Moving file ${uniqueFileName} from staging to target folder ID: ${targetFolderId}`);
        await drive.files.update({
          fileId: file.id,
          addParents: targetFolderId,
          removeParents: stagingFolderId,
          fields: 'id, parents',
        });

        // Complete lock
        await fileRef.set({
          status: 'completed',
          classification,
          destinationFolderId: targetFolderId,
          completedAt: new Date(),
          error: null,
        }, { merge: true });

        console.log(`Successfully completed routing file: ${uniqueFileName}`);
      } catch (fileError: any) {
        console.error(`Failed to process file ${file.name}:`, fileError);
        await fileRef.set({
          status: 'failed',
          error: fileError.message || String(fileError),
          completedAt: new Date(),
        }, { merge: true });
      }
    }

    res.status(200).send('Pub/Sub worker executed successfully');
  } catch (error: any) {
    console.error('Error running worker list/process loop:', error);
    res.status(500).send(`Error running worker: ${error.message || String(error)}`);
  }
});

// POST /webhooks/gmail (Private, triggered by Pub/Sub Push subscription)
app.post('/webhooks/gmail', async (req: Request, res: Response) => {
  console.log('Gmail webhook triggered. Body:', req.body);

  const isAuthorized = await verifyOidcToken(req);
  if (!isAuthorized) {
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    const gmailRefreshToken = process.env.GMAIL_USER_REFRESH_TOKEN;
    if (!gmailRefreshToken || gmailRefreshToken === 'PLACEHOLDER' || gmailRefreshToken.trim() === '') {
      console.error('GMAIL_USER_REFRESH_TOKEN is not set or is empty');
      res.status(500).send('Gmail client refresh token is missing');
      return;
    }

    const oauth2Client = getGmailOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: gmailRefreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Query for messages with the !to-obsidian label
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: 'label:!to-obsidian',
    });

    const messages = listResponse.data.messages || [];
    console.log(`Found ${messages.length} messages with label "!to-obsidian"`);

    // Resolve dependencies outside the loop to optimize performance and prevent rate limit issues
    const stagingFolderName = process.env.STAGING_FOLDER_NAME || 'Obsidian Staging';
    const stagingFolderId = await getRootFolder(stagingFolderName);

    const toObsidianLabelId = await getOrCreateGmailLabel(gmail, '!to-obsidian');
    const processedToObsidianLabelId = await getOrCreateGmailLabel(gmail, 'processed-to-obsidian');

    const ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.PROJECT_ID,
      location: process.env.GCP_REGION || 'us-central1',
    });

    for (const msg of messages) {
      const messageId = msg.id;
      if (!messageId) continue;

      const emailRef = db.collection('processed_emails').doc(messageId);

      // Acquire distributed lock via transaction
      const lockResult = await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(emailRef);
        const now = new Date();
        if (doc.exists) {
          const data = doc.data();
          if (data) {
            if (data.status === 'completed') {
              console.log(`Email lock check: ${messageId} is already marked as completed.`);
              return { shouldProcess: false, driveFileId: data.driveFileId };
            }
            if (data.status === 'processing') {
              const lockedAt = data.lockedAt?.toDate();
              if (lockedAt && (now.getTime() - lockedAt.getTime()) < 15 * 60 * 1000) {
                console.log(`Email lock check: ${messageId} is currently being processed.`);
                return { shouldProcess: false };
              } else {
                console.log(`Email lock check: ${messageId} lock expired. Re-acquiring lock.`);
              }
            }
          }
        }
        transaction.set(emailRef, {
          status: 'processing',
          lockedAt: now,
        }, { merge: true });
        return { shouldProcess: true, driveFileId: doc.exists ? doc.data()?.driveFileId : undefined };
      });

      if (!lockResult.shouldProcess) {
        continue;
      }

      console.log(`Processing email message: ${messageId}`);

      try {
        // Fetch raw email RFC 822 content
        const messageResponse = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'raw',
        });

        const rawBase64 = messageResponse.data.raw;
        if (!rawBase64) {
          throw new Error('Email raw content is empty');
        }

        const rawBuffer = Buffer.from(rawBase64, 'base64url');
        const parsedEmail = await simpleParser(rawBuffer);

        const subject = parsedEmail.subject || 'No Subject';
        const senderText = parsedEmail.from?.text || 'Unknown Sender';
        const dateObj = (parsedEmail.date && !isNaN(parsedEmail.date.getTime())) ? parsedEmail.date : new Date();
        const dateStr = dateObj.toISOString().split('T')[0];
        const bodyText = parsedEmail.text || '';
        const threadId = messageResponse.data.threadId || msg.threadId || '';

        const prompt = `You are an expert personal data assistant. Analyze the following raw email payload. Extract a concise summary of the email, extract all actionable TODO items or tasks, determine the matching tags for classification, and convert the core body into clean, semantic Markdown. Return your response matching the requested JSON schema exactly.

Sender: ${senderText}
Subject: ${subject}
Date: ${dateStr}
Body:
${bodyText}`;

        const responseSchema = {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'A concise 2-3 sentence summary of the email context.' },
            tasks: {
              type: 'array',
              items: { type: 'string' },
              description: 'Action items or todo tasks extracted from the email body.',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Extracted topics or folders. Example: project/updates, Journal, Project, ProjectPlan',
            },
            cleanMarkdown: {
              type: 'string',
              description: 'The email body converted to clean, reader-friendly Markdown.',
            },
          },
          required: ['summary', 'tasks', 'tags', 'cleanMarkdown'],
        };

        console.log(`Querying Gemini 2.5 Flash for message: ${messageId}`);
        const geminiResponse = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: responseSchema as any,
          },
        });

        const geminiText = geminiResponse.text;
        if (!geminiText) {
          throw new Error('Gemini returned an empty response');
        }

        const result = JSON.parse(geminiText);
        const summary = result.summary || '';
        const tasks = result.tasks || [];
        const tags = result.tags || [];
        const cleanMarkdown = result.cleanMarkdown || '';

        let tasksSection = '';
        if (tasks && tasks.length > 0) {
          tasksSection = tasks.map((t: string) => `- [ ] ${t}`).join('\n');
        }

        // Format tags as hashtags, sanitizing any spaces
        const hashtags = tags.map((t: string) => {
          const cleanTag = t.replace(/\s+/g, '-');
          return `#${cleanTag.startsWith('#') ? cleanTag.substring(1) : cleanTag}`;
        }).join(' ');

        const compiledMarkdown = `---
type: email-capture
sender: "${senderText.replace(/"/g, '\\"')}"
subject: "${subject.replace(/"/g, '\\"')}"
timestamp: "${dateStr}"
email-link: "https://mail.google.com/mail/u/0/#all/${threadId}"
---

# ${subject}

## 📧 Email Details
- **Sender:** ${senderText}
- **Date:** ${dateStr}
- **Link:** [View in Gmail](https://mail.google.com/mail/u/0/#all/${threadId})

## 📝 Summary
${summary}

## ⏳ Action Items
${tasksSection}

---

${cleanMarkdown}

${hashtags}
`;

        // Check if the file was already created in a previous failed run using driveFileId
        let driveFileId = lockResult.driveFileId;
        if (!driveFileId) {
          console.log(`Writing note to staging folder for message: ${messageId}`);
          const driveResponse = await drive.files.create({
            requestBody: {
              name: `gmail-capture-${messageId}.md`,
              parents: [stagingFolderId],
              mimeType: 'text/markdown',
            },
            media: {
              mimeType: 'text/markdown',
              body: compiledMarkdown,
            },
          });
          driveFileId = driveResponse.data.id || undefined;
          if (driveFileId) {
            await emailRef.set({ driveFileId }, { merge: true });
          }
        } else {
          console.log(`File already created in previous run: ${driveFileId}. Skipping file creation.`);
        }

        console.log(`Swapping labels for message: ${messageId}`);
        await gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            removeLabelIds: [toObsidianLabelId],
            addLabelIds: [processedToObsidianLabelId],
          },
        });

        // Set Firestore status to completed
        await emailRef.set({
          status: 'completed',
          subject: subject,
          completedAt: new Date(),
        }, { merge: true });

        console.log(`Successfully completed processing message: ${messageId}`);
      } catch (msgError: any) {
        console.error(`Failed to process message ${messageId}:`, msgError);
        await emailRef.set({
          status: 'failed',
          error: msgError.message || String(msgError),
          completedAt: new Date(),
        }, { merge: true });
      }
    }

    res.status(200).send('Gmail updates processed successfully');
  } catch (error: any) {
    console.error('Error processing Gmail webhook:', error);
    res.status(500).send(`Error processing Gmail webhook: ${error.message || String(error)}`);
  }
});

// POST /renew-watch (Private, triggered by Cloud Scheduler)
app.post('/renew-watch', async (req: Request, res: Response) => {
  console.log('Renew watch triggered');

  const isAuthorized = await verifyOidcToken(req);
  if (!isAuthorized) {
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    const stagingFolderName = process.env.STAGING_FOLDER_NAME || 'Obsidian Staging';
    const stagingFolderId = await getRootFolder(stagingFolderName);

    const channelRef = db.collection('watch_channels').doc('inbox_channel');
    const oldChannelDoc = await channelRef.get();
    const oldChannelData = oldChannelDoc.exists ? oldChannelDoc.data() : null;

    const channelId = uuidv4();
    const domain = process.env.DOMAIN_NAME || 'plaud.billnapier.com';
    const address = `https://${domain}/webhook`;

    console.log(`Renewing watch. Staging folder ID: ${stagingFolderId}. Address: ${address}`);

    const watchResponse = await drive.files.watch({
      fileId: stagingFolderId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: address,
        expiration: String(Date.now() + 24 * 60 * 60 * 1000), // Request 24-hour expiration
      },
    });

    const expiration = parseInt(watchResponse.data.expiration || '0', 10);
    console.log(`New watch channel created: ${channelId}. Expiration: ${expiration}`);

    // If an old channel existed, cleanly stop it
    if (oldChannelData && oldChannelData.channelId && oldChannelData.resourceId) {
      try {
        console.log(`Stopping old channel. ID: ${oldChannelData.channelId}, Resource ID: ${oldChannelData.resourceId}`);
        await drive.channels.stop({
          requestBody: {
            id: oldChannelData.channelId,
            resourceId: oldChannelData.resourceId,
          },
        });
        console.log('Old channel stopped.');
      } catch (stopError) {
        console.error('Failed to stop old watch channel (non-fatal):', stopError);
      }
    }

    // Update watch channel details in Firestore
    const now = new Date();
    await channelRef.set({
      id: 'inbox_channel',
      channelId: channelId,
      resourceId: watchResponse.data.resourceId || '',
      expiration: expiration,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    // Fallback: Trigger Pub/Sub worker to check for new files in staging
    try {
      console.log('Triggering Pub/Sub worker from renew-watch as a scheduled fallback...');
      const topicName = 'drive-file-changes';
      const dataBuffer = Buffer.from(
        JSON.stringify({
          channelId: 'scheduled-fallback-trigger',
          resourceId: stagingFolderId,
          resourceState: 'scheduled',
        })
      );
      await pubsub.topic(topicName).publishMessage({ data: dataBuffer });
      console.log('Successfully published scheduled fallback event to Pub/Sub.');
    } catch (triggerError: any) {
      console.error('Failed to publish scheduled fallback event to Pub/Sub (non-fatal):', triggerError);
    }

    // Gmail Inbox Watch Renewal & Label Inception (Stage 4)
    try {
      const gmailRefreshToken = process.env.GMAIL_USER_REFRESH_TOKEN;
      if (!gmailRefreshToken || gmailRefreshToken === 'PLACEHOLDER' || gmailRefreshToken.trim() === '') {
        console.warn('GMAIL_USER_REFRESH_TOKEN is not set or is empty. Skipping Gmail watch renewal.');
      } else {
        console.log('Initializing Gmail client for watch renewal...');
        const oauth2Client = getGmailOAuth2Client();
        oauth2Client.setCredentials({ refresh_token: gmailRefreshToken });
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        const labelId = await getOrCreateGmailLabel(gmail, '!to-obsidian');

        const projectId = process.env.PROJECT_ID;
        if (!projectId) {
          throw new Error('PROJECT_ID environment variable is missing');
        }

        console.log(`Setting up Gmail watch for topic: projects/${projectId}/topics/gmail-inbox-updates and label ID: ${labelId}`);
        const gmailWatchResponse = await gmail.users.watch({
          userId: 'me',
          requestBody: {
            topicName: `projects/${projectId}/topics/gmail-inbox-updates`,
            labelIds: [labelId],
            labelFilterBehavior: 'INCLUDE',
          },
        });

        console.log('Gmail watch renewed successfully:', gmailWatchResponse.data);
        console.log(`Gmail watch historyId: ${gmailWatchResponse.data.historyId}, expiration: ${gmailWatchResponse.data.expiration}`);
      }
    } catch (gmailError: any) {
      console.error('Failed to renew Gmail watch (non-fatal):', gmailError);
    }

    res.status(200).send('Watch renewal and fallback trigger completed');
  } catch (error: any) {
    console.error('Error renewing watch channel:', error);
    res.status(500).send(`Error renewing watch: ${error.message || String(error)}`);
  }
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
