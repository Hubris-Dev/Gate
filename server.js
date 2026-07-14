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
app.use(express.static('public')); // Place ton fichier HTML dans un dossier "public"

const msgRetryCounterCache = new NodeCache();
const activeSessions = new Map(); // number -> { sock, status, reason }

// Route pour générer le code
app.post('/api/pair', async (req, res) => {
  const { number } = req.body || {};

  if (!number || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }

  // Ferme une éventuelle session déjà ouverte pour ce numéro avant d'en relancer une
  const previous = activeSessions.get(number);
  if (previous?.sock) {
    try { previous.sock.end(); } catch (_) {}
    activeSessions.delete(number);
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${number}`);

    if (state.creds.registered) {
      return res.status(409).json({
        error: `Ce numéro est déjà pairé. Supprime ./sessions/${number} pour relancer un pairing.`
      });
    }

    const { version } = await fetchLatestBaileysVersion(); // évite les déconnexions 405 liées à une version WA obsolète

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      logger: pino({ level: 'silent' }),
      msgRetryCounterCache,
      browser: Browsers.macOS('Google Chrome'), // requis pour le pairing code, sinon l'appairage échoue
    });

    const session = { sock, status: 'pending', reason: null };
    activeSessions.set(number, session);
    sock.ev.on('creds.update', saveCreds);

    let codeRequested = false;
    let settled = false;

    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Timeout : le socket ne s'est jamais connecté"));
        }
      }, 20000);

      sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        // Le code ne peut être demandé qu'une fois le socket en train de se connecter (ou qu'un QR est émis) :
        // le demander juste après makeWASocket() est la cause n°1 des erreurs "Connection Closed".
        if (!codeRequested && (connection === 'connecting' || qr)) {
          codeRequested = true;
          try {
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
    console.error('[GATE] Erreur pairing:', e); // on log la vraie erreur au lieu de l'avaler
    activeSessions.delete(number);
    res.status(500).json({ error: 'Erreur génération' });
  }
});

// Route pour vérifier la connexion
app.get('/api/status', (req, res) => {
  const { number } = req.query;
  const session = activeSessions.get(number);
  res.json({
    connected: session?.status === 'connected',
    status: session?.status || 'unknown', // 'pending' | 'connected' | 'failed' | 'unknown'
  });
});

app.listen(8080, () => console.log('GATE ouvert sur le port 8080'));
