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

const app = express();
app.use(express.json());
app.use(express.static('public')); 

const msgRetryCounterCache = new NodeCache();
const activeSessions = new Map(); 

// Plafond de tentatives de reconnexion pour éviter le spam WhatsApp
const MAX_RETRIES = 5;

// Fonction récursive pour gérer la connexion et les redémarrages (515)
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
        console.log(`[GATE] ✅ Connexion RÉUSSIE et finalisée pour le numéro ${number} !`);
        retryCount = 0; // On remet le compteur à zéro après un succès
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : undefined;
        
        console.error(`[GATE] session ${number} fermée (code ${statusCode})`);

        // Si c'est une vraie déconnexion volontaire/ban (401)
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[GATE] Déconnexion définitive (loggedOut). Nettoyage de ${number}.`);
          activeSessions.delete(number);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        } else {
          // GESTION DU CODE 515 ET AUTRES REDÉMARRAGES REQUIS
          if (retryCount < MAX_RETRIES) {
            console.log(`[GATE] Redémarrage requis. Reconnexion automatique (Tentative ${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => {
              startSession(number, null, retryCount + 1); // null pour ne pas renvoyer de réponse Express
            }, 2000);
          } else {
            console.error(`[GATE] Échec définitif pour ${number} : plafond de reconnexions atteint.`);
            session.status = 'failed';
            session.reason = 'max_retries_reached';
            activeSessions.delete(number);
          }
        }
      }
    });

    // Demande du code de jumelage (Uniquement s'il y a une requête Express active et que ce n'est pas déjà enregistré)
    if (res && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(number);
          if (!res.headersSent) res.json({ code });
        } catch (e) {
          console.error('[GATE] Erreur requestPairingCode:', e.message);
          if (!res.headersSent) res.status(500).json({ error: 'Erreur lors de la génération du code.' });
        }
      }, 3500); 
    } else if (res && sock.authState.creds.registered) {
      if (!res.headersSent) res.status(400).json({ error: 'Ce numéro est déjà lié.' });
    }

  } catch (e) {
    console.error('[GATE] Erreur fatale init:', e);
    activeSessions.delete(number);
    if (res && !res.headersSent) res.status(500).json({ error: 'Erreur critique serveur.' });
  }
}

// Route principale
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

  // On nettoie le dossier de force UNIQUEMENT lors d'une nouvelle demande manuelle depuis l'API
  const sessionPath = `./sessions/${number}`;
  if (fs.existsSync(sessionPath)) {
    console.log(`[GATE] Nouvelle demande API : Suppression des anciennes clés pour ${number}`);
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  // On lance la machine
  startSession(number, res, 0);
});

app.get('/api/status', (req, res) => {
  const { number } = req.query;
  const session = activeSessions.get(number);
  res.json({
    connected: session?.status === 'connected',
    status: session?.status || 'unknown',
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GATE ouvert et à l'écoute sur le port ${PORT}`);
});
