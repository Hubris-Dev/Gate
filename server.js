import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
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
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[GATE] Utilisation de la version WhatsApp v${version.join('.')}`);

    // 2. Initialise le stockage de session local
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${number}`);

    // 3. Initialise le socket avec la version récupérée et l'empreinte spécifique
    const sock = makeWASocket({
      version, // <-- On injecte la version dynamique ici !
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
      },
      logger: pino({ level: "silent" }),
      msgRetryCounterCache,
      
      // Simule une empreinte ultra-spécifique pour contourner le filtre WhatsApp (Erreur 405)
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      
      // Robustesse de connexion
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 30000,
    });

    sock.ev.on('creds.update', saveCreds);

    const session = { sock, status: 'pending', reason: null };
    activeSessions.set(number, session);

    let codeRequested = false;
    let settled = false;

    // Enveloppe la récupération du code dans une promesse gérée par les événements du socket
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Timeout : le socket ne s'est pas connecté dans le délai imparti."));
        }
      }, 25000);

      sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        // On ne demande le code que lorsque Baileys a initié la poignée de main réseau
        if (!codeRequested && (connection === 'connecting' || qr)) {
          codeRequested = true;
          try {
            // Laisse un court délai pour stabiliser le canal Noise
            await new Promise(r => setTimeout(r, 3000));
            const c = await sock.requestPairingCode(number);
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(c);
            }
          } catch (e) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              reject(e);
            }
          }
        }

        if (connection === 'open') {
          session.status = 'connected';
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : undefined;
          
          session.status = 'failed';
          session.reason = statusCode ?? null;
          console.error(`[GATE] session ${number} fermée (code ${statusCode})`, lastDisconnect?.error);

          if (!settled && !codeRequested) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`Connexion fermée avant le pairing (code ${statusCode})`));
          }
          if (statusCode === DisconnectReason.loggedOut) {
            activeSessions.delete(number);
          }
        }
      });
    });

    res.json({ code });
  } catch (e) {
    console.error('[GATE] Erreur pairing:', e);
    activeSessions.delete(number);
    res.status(500).json({ error: 'Erreur génération. Vérifiez les logs.' });
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

// Port dynamique pour s'adapter au panel TogeHost (Pterodactyl) ou Railway
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GATE ouvert et à l'écoute sur le port ${PORT}`);
});
