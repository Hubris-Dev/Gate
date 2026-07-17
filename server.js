import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json());
app.use(express.static('public')); 

const msgRetryCounterCache = new NodeCache();
const activeSessions = new Map(); 

const MAX_RETRIES = 5;

// Fonction de gestion de session WhatsApp
async function startSession(number, res = null, retryCount = 0) {
  const sessionPath = `./sessions/${number}`;

  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      logger: pino({ level: "silent" }),
      msgRetryCounterCache,
      browser: ['Chrome', 'Chrome', '120.0.0.0'],
      generateHighQualityLinkPreview: true,
      retryRequestDelay: 500, 
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 30000,
      printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    const session = { sock, status: 'pending', reason: null };
    activeSessions.set(number, session);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'open') {
        session.status = 'connected';
        console.log(`[GATE] ✅ Connexion RÉUSSIE pour le numéro ${number} !`);
        retryCount = 0; 
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : undefined;
        
        console.error(`[GATE] session ${number} fermée (code ${statusCode})`);

        if (statusCode === DisconnectReason.loggedOut) {
          activeSessions.delete(number);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        } else {
          // Gestion du redémarrage (Code 515)
          if (retryCount < MAX_RETRIES) {
            console.log(`[GATE] Reconnexion automatique (Tentative ${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => {
              startSession(number, null, retryCount + 1); 
            }, 2000);
          } else {
            session.status = 'failed';
            activeSessions.delete(number);
          }
        }
      }
    });

    // Demande du Pairing Code
    if (res && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(number);
          if (!res.headersSent) res.json({ code });
        } catch (e) {
          if (!res.headersSent) res.status(500).json({ error: 'Erreur lors de la génération du code.' });
        }
      }, 3500); 
    } else if (res && sock.authState.creds.registered) {
      if (!res.headersSent) res.status(400).json({ error: 'Ce numéro est déjà lié.' });
    }

  } catch (e) {
    activeSessions.delete(number);
    if (res && !res.headersSent) res.status(500).json({ error: 'Erreur critique serveur.' });
  }
}

// Route POST : Générer le code
app.post('/api/pair', async (req, res) => {
  const { number } = req.body || {};
  if (!number || !/^\d{8,15}$/.test(number)) return res.status(400).json({ error: 'Numéro invalide' });

  const previous = activeSessions.get(number);
  if (previous && previous.sock) {
    try { previous.sock.end(undefined); } catch (e) {}
    activeSessions.delete(number);
  }

  const sessionPath = `./sessions/${number}`;
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  startSession(number, res, 0);
});

// Route GET : Vérifier le statut et renvoyer la CLÉ API
app.get('/api/status', (req, res) => {
  const { number } = req.query;
  const session = activeSessions.get(number);
  
  let apiKey = null;

  if (session?.status === 'connected') {
    try {
      // Convertit les identifiants en clé Base64 pour l'infrastructure Infernum
      const credsPath = path.join(process.cwd(), `sessions/${number}/creds.json`);
      if (fs.existsSync(credsPath)) {
        const credsData = fs.readFileSync(credsPath);
        apiKey = credsData.toString('base64');
      }
    } catch (e) {
      console.error("[GATE] Erreur génération clé:", e.message);
    }
  }

  res.json({
    connected: session?.status === 'connected',
    status: session?.status || 'unknown',
    apiKey: apiKey 
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GATE ouvert sur le port ${PORT}`);
});
