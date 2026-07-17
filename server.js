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
import fs from 'fs'; // <-- Ajout du module File System

const app = express();
app.use(express.json());
app.use(express.static('public')); 

const msgRetryCounterCache = new NodeCache();
const activeSessions = new Map(); 

app.post('/api/pair', async (req, res) => {
  const { number } = req.body || {};

  if (!number || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }

  // 1. Ferme la session active si elle existe en mémoire
  const previous = activeSessions.get(number);
  if (previous && previous.sock) {
    try { previous.sock.end(undefined); } catch (e) {}
    activeSessions.delete(number);
  }

  // 2. NETTOYAGE PHYSIQUE DU DOSSIER (La solution au code 500 / 515)
  const sessionPath = `./sessions/${number}`;
  if (fs.existsSync(sessionPath)) {
    console.log(`[GATE] Suppression des anciennes clés corrompues pour ${number}`);
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[GATE] Utilisation de la version WhatsApp v${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      logger: pino({ level: "silent" }),
      msgRetryCounterCache,
      browser: ['Chrome', 'Chrome', '120.0.0.0'], // Empreinte standard anti-détection
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    const session = { sock, status: 'pending', reason: null };
    activeSessions.set(number, session);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'open') {
        session.status = 'connected';
        console.log(`[GATE] ✅ Connexion RÉUSSIE pour le numéro ${number} !`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : undefined;
        
        session.status = 'failed';
        session.reason = statusCode ?? null;
        console.error(`[GATE] session ${number} fermée (code ${statusCode})`, lastDisconnect?.error?.message);

        if (statusCode === DisconnectReason.loggedOut) {
          activeSessions.delete(number);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        }
      }
    });

    // 3. Demande du code après une temporisation de 3.5 secondes
    if (!sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(number);
          if (!res.headersSent) {
            res.json({ code });
          }
        } catch (e) {
          console.error('[GATE] Erreur requestPairingCode:', e.message);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Erreur lors de la génération du code WhatsApp.' });
          }
        }
      }, 3500); 
    } else {
      if (!res.headersSent) {
        res.status(400).json({ error: 'Ce numéro est déjà lié.' });
      }
    }

  } catch (e) {
    console.error('[GATE] Erreur fatale init:', e);
    activeSessions.delete(number);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Erreur critique serveur.' });
    }
  }
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
