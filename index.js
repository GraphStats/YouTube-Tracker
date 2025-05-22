const express = require('express');
const fs = require('fs');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 8005;
const DATA_DIR = path.join(__dirname, 'data');
const SEARCH_INTERVAL = 40000;
const REFRESH_INTERVAL = 1800000; // 10 min
const RETRY_DELAY = 30000; // 30 sec
const MAX_RETRIES = 5;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

let channels = [];
let failCount = {};

function loadChannels() {
  const filePath = path.join(__dirname, 'channels.json');
  if (fs.existsSync(filePath)) channels = JSON.parse(fs.readFileSync(filePath));
}

function saveChannels() {
  fs.writeFileSync(path.join(__dirname, 'channels.json'), JSON.stringify(channels, null, 2));
}

function getTimestamp() {
  return new Date().toISOString();
}

function isRouteAlreadyRegistered(path) {
  return app._router.stack.some(r => r.route && r.route.path === path);
}

function setupChannel(channelId) {
  const apiURL = `https://backend.mixerno.space/api/youtube/estv3/${channelId}`;
  const filePath = path.join(DATA_DIR, `${channelId}.json`);
  const routePath = `/data/${channelId}`;

  if (isRouteAlreadyRegistered(routePath)) {
    console.log(`⚠️ Route déjà setup pour ${channelId}`);
    return;
  }

  app.get(routePath, (req, res) => {
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Data not found' });
    res.sendFile(filePath);
  });

  let retries = 0;

  async function fetchData() {
    if (failCount[channelId] >= MAX_RETRIES) {
      console.log(`🚫 ${channelId} mis en pause après ${MAX_RETRIES} échecs`);
      return;
    }

    try {
      const response = await fetch(apiURL);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      const newEntry = {
        timestamp: getTimestamp(),
        channelId,
        subscribers: data.items?.[0]?.statistics?.subscriberCount || 0
      };

      let history = [];
      if (fs.existsSync(filePath)) {
        try {
          history = JSON.parse(fs.readFileSync(filePath));
          if (!Array.isArray(history)) history = [];

          const twoDaysAgo = new Date();
          twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
          history = history.filter(entry => new Date(entry.timestamp) > twoDaysAgo);
        } catch {
          history = [];
        }
      }

      history.push(newEntry);
      fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
      console.log(`📈 Donnée ajoutée pour ${channelId}`);
      failCount[channelId] = 0;
    } catch (err) {
      failCount[channelId] = (failCount[channelId] || 0) + 1;
      console.error(`❌ Erreur pour ${channelId}: ${err.message}`);
      setTimeout(fetchData, RETRY_DELAY);
    }
  }

  setInterval(fetchData, REFRESH_INTERVAL);
  fetchData();
}

function generateRandomName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const length = Math.floor(Math.random() * 60) + 1;
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function autoScan() {
  setInterval(async () => {
    const name = generateRandomName();
    const url = `https://mixerno.space/api/youtube-channel-counter/search/${name}`;

    try {
      const res = await fetch(url);
      const data = await res.json();

      if (data.list && Array.isArray(data.list)) {
        for (const item of data.list) {
          const id = item[2];
          if (!channels.includes(id)) {
            channels.push(id);
            saveChannels();
            setupChannel(id);
            console.log(`📡 Ajout auto : ${item[0]} (${id})`);
          }
        }
      }
    } catch (err) {
      console.error(`🔍 Erreur recherche "${name}": ${err.message}`);
    }
  }, SEARCH_INTERVAL);
}

app.get('/api/channels', (req, res) => {
  const channelsData = channels.map(channelId => {
    const filePath = path.join(DATA_DIR, `${channelId}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const history = JSON.parse(fs.readFileSync(filePath));
        const latest = history[history.length - 1] || {};
        return {
          channelId,
          subscribers: latest.subscribers || 0,
          timestamp: latest.timestamp || 'N/A'
        };
      } catch {
        return { channelId, subscribers: 0, timestamp: 'N/A' };
      }
    } else {
      return { channelId, subscribers: 0, timestamp: 'N/A' };
    }
  });

  res.json(channelsData);
});

app.post('/add-channel', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing channel ID' });
  if (channels.includes(id)) return res.status(400).json({ error: 'Channel already added' });

  channels.push(id);
  saveChannels();
  setupChannel(id);
  res.json({ success: true, route: `/data/${id}` });
});

// 🚀 Initialisation
loadChannels();
channels.forEach(setupChannel);
autoScan();

app.listen(PORT, () => {
  console.log(`🚀 Serveur lancé sur http://localhost:${PORT}`);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
