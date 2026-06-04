const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const CLEARFEED_TOKEN = process.env.CLEARFEED_API_TOKEN;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());

app.use(express.json());

app.get('/tickets', async (req, res) => {
  if (!CLEARFEED_TOKEN) {
    return res.status(500).json({ error: 'CLEARFEED_API_TOKEN not set' });
  }

  try {
    const response = await fetch('https://api.clearfeed.app/v1/rest/requests', {
      headers: {
        'Authorization': `Bearer ${CLEARFEED_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`ClearFeed proxy running on port ${PORT}`));
