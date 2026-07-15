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

const app = express();
app.use(express.json());
app.use(express.static('public')); // Distribue ton dossier public (index.html)

const msgRetryCounterCache = new NodeCache();
const activeSessions = new Map(); // structure : number -> { sock, status, reason }

// Route pour générer le code de jumelage
app.post('/api/pair', async (req, res) => {
  const { number } = req.body || {};

  if (!number || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }

  // Ferme une éventuelle session active précédente pour ce numéro
  const previous = activeSessions.get(number);
  if (previous && previous.sock) {
    try {
      previous.sock.end(undefined);
    } catch (e) {
      // ignore
    }
    activeSessions.delete(number);
  }

  try {
    // 1. Récupère dynamiquement la TOUTE DERNIÈRE version de WhatsApp Web
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[GATE] Utilisation de la version WhatsApp v${version.join('.')}`);

    // 2. Initialise le stockage de session local
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${number}`);

    // 3. Initialise le socket
    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      logger: pino({ level: "silent" }),
      msgRetryCounterCache,
      
      // L'empreinte ultra-spécifique pour éviter l'erreur 405
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    const session = { sock, status: 'pending', reason: null };
    activeSessions.set(number, session);

    // Écoute des mises à jour de connexion en arrière-plan (sans bloquer la demande de code)
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'open') {
        session.status = 'connected';
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
        }
      }
    });

    // MÉTHODE DIRECTE : On attend 3.5 secondes que le flux s'ouvre, puis on force la demande
    if (!sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(number);
          // Si la réponse n'a pas encore été envoyée, on renvoie le code
          if (!res.headersSent) {
            res.json({ code });
          }
        } catch (e) {
          console.error('[GATE] Erreur requestPairingCode:', e.message);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Erreur lors de la génération du code WhatsApp.' });
          }
        }
      }, 3500); // 3500 ms = 3.5 secondes
    } else {
      if (!res.headersSent) {
        res.status(400).json({ error: 'Ce numéro est déjà lié et enregistré.' });
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

// Route pour vérifier l'état d'authentification
app.get('/api/status', (req, res) => {
  const { number } = req.query;
  const session = activeSessions.get(number);
  res.json({
    connected: session?.status === 'connected',
    status: session?.status || 'unknown',
  });
});

// Port dynamique pour Railway
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GATE ouvert et à l'écoute sur le port ${PORT}`);
});
