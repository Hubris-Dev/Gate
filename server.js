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
          // Gestion du redémarrage automatique
          if (retryCount < MAX_RETRIES) {
            console.log(`[GATE] Reconnexion automatique pour ${number} (Tentative ${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => {
              startSession(number, null, retryCount + 1); 
            }, 3000);
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
          console.error(`[GATE] Erreur génération pairing code pour ${number}:`, e.message);
          if (!res.headersSent) res.status(500).json({ error: 'Erreur lors de la génération du code.' });
        }
      }, 3500); 
    } else if (res && sock.authState.creds.registered) {
      if (!res.headersSent) res.status(400).json({ error: 'Ce numéro est déjà lié.' });
    }
  } catch (e) {
    console.error(`[GATE] Erreur critique session ${number}:`, e.message);
    activeSessions.delete(number);
    if (res && !res.headersSent) res.status(500).json({ error: 'Erreur critique serveur.' });
  }
}

// Restauration automatique de toutes les sessions existantes sur le disque au démarrage
const sessionsDir = './sessions';
if (fs.existsSync(sessionsDir)) {
  try {
    const folders = fs.readdirSync(sessionsDir);
    for (const folder of folders) {
      if (/^\d{8,15}$/.test(folder)) {
        console.log(`[GATE] 🔄 Restauration automatique de la session pour : ${folder}`);
        startSession(folder).catch(err => {
          console.error(`[GATE] Échec restauration ${folder}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.error("[GATE] Erreur lors de la lecture du répertoire des sessions:", err.message);
  }
}

// Route POST : Générer le code
app.post('/api/pair', async (req, res) => {
  const { number } = req.body || {};
  if (!number || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }
  
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
  if (!number) return res.status(400).json({ error: 'Numéro requis' });

  const session = activeSessions.get(number);
  const credsPath = path.join(process.cwd(), `sessions/${number}/creds.json`);
  const fileExists = fs.existsSync(credsPath);
  
  let apiKey = null;
  let isConnected = session?.status === 'connected';

  // 1. Si connecté et le fichier existe, on extrait la clé
  if (fileExists) {
    try {
      const credsData = fs.readFileSync(credsPath);
      apiKey = credsData.toString('base64');
      isConnected = true; // Forcer à true car les identifiants de session existent physiquement
    } catch (e) {
      console.error(`[GATE] Erreur lors de la lecture de creds.json pour ${number}:`, e.message);
    }
  } 
  // 2. Fallback de secours immédiat en mémoire vive si Baileys n'a pas encore fini d'écrire le fichier sur le disque
  else if (session?.status === 'connected' && session.sock?.authState?.creds) {
    try {
      console.log(`[GATE] ⚡ Clé récupérée directement en mémoire vive pour ${number}`);
      const credsJSON = JSON.stringify(session.sock.authState.creds);
      apiKey = Buffer.from(credsJSON).toString('base64');
    } catch (e) {
      console.error(`[GATE] Erreur lors de la sérialisation mémoire de creds pour ${number}:`, e.message);
    }
  }

  res.json({
    connected: isConnected,
    status: isConnected ? 'connected' : (session?.status || 'unknown'),
    apiKey: apiKey 
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GATE ouvert sur le port ${PORT}`);
});
