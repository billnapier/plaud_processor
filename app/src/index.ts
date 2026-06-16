import express, { Request, Response } from 'express';

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

// Root path for status checks / smoke tests
app.get('/', (req: Request, res: Response) => {
  res.status(200).send('Plaud Processor Scaffolding is running');
});

// health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).send('OK');
});

// POST /webhook
app.post('/webhook', (req: Request, res: Response) => {
  console.log('Received webhook headers:', req.headers);
  const channelId = req.headers['x-goog-channel-id'];
  const resourceId = req.headers['x-goog-resource-id'];
  const resourceState = req.headers['x-goog-resource-state'];

  console.log(`Webhook Event - Channel: ${channelId}, Resource: ${resourceId}, State: ${resourceState}`);

  // Immediate acknowledgment to prevent Google Drive timing out
  res.status(200).send('Webhook received and acknowledged');
});

// POST /pubsub-worker
app.post('/pubsub-worker', (req: Request, res: Response) => {
  console.log('Pub/Sub worker triggered. Body:', req.body);
  
  // Scaffolding success response
  res.status(200).send('Pub/Sub worker executed successfully');
});

// POST /renew-watch
app.post('/renew-watch', (req: Request, res: Response) => {
  console.log('Renew watch triggered');

  // Scaffolding success response
  res.status(200).send('Watch renewal completed');
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
