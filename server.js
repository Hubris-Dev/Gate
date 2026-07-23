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
import crypto from 'crypto';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const msgRetryCounterCache = new NodeCache();
const activeSessions = new Map();

// GATE est un service PUBLIC : /api/pair et /api/status ne sont plus derrière
// la clé maître. Chaque appairage reçoit son propre token à usage unique —
// c'est ce token (pas le numéro) qui prouve qu'on a le droit de lire une clé.
// Sans ça, n'importe qui connaissant un numéro pourrait voler sa session.
const pairingTokens = new Map(); // number -> { token, expiresAt }
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 min pour compléter le pairing

// Rate limit basique par IP sur /api/pair, pour empêcher qu'on spam/tue
// la session d'un numéro qui n'est pas le sien.
const rateLimitMap = new Map(); // ip -> timestamps[]
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

const MAX_RETRIES = 5;
const GATE_API_KEY = process.env.GATE_API_KEY; // réservée aux routes d'admin (purge)

// Version Baileys mise en cache pour éviter un appel réseau à chaque session
let cachedVersion = null;
async function getBaileysVersion() {
  if (!cachedVersion) {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
  }
  return cachedVersion;
}

// Middleware de protection par clé API — réservé aux routes d'admin (purge)
function requireApiKey(req, res, next) {
  if (!GATE_API_KEY) {
    console.warn('[GATE] ⚠️ GATE_API_KEY non défini — routes non protégées (à éviter en production)');
    return next();
  }
  const key = req.headers['x-api-key'];
  if (key !== GATE_API_KEY) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// Limite le nombre d'invocations par IP — évite qu'on puisse harceler/tuer
// en boucle la session d'un numéro qui ne nous appartient pas.
function rateLimitPair(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'inconnu';
  const now = Date.now();
  const attempts = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);

  if (attempts.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans quelques minutes.' });
  }

  attempts.push(now);
  rateLimitMap.set(ip, attempts);
  next();
}

// Fonction de gestion de session WhatsApp
async function startSession(number, res = null, retryCount = 0, token = null) {
  const sessionPath = `./sessions/${number}`;
  try {
    const version = await getBaileysVersion();
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
          // Reconnexion automatique avec backoff exponentiel (couvre le code 515 et les autres coupures réseau)
          if (retryCount < MAX_RETRIES) {
            const delay = Math.min(3000 * Math.pow(2, retryCount), 30000);
            console.log(`[GATE] Reconnexion automatique pour ${number} dans ${delay}ms (Tentative ${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => {
              startSession(number, null, retryCount + 1, token);
            }, delay);
          } else {
            session.status = 'failed';
            activeSessions.delete(number);
            console.error(`[GATE] ❌ Abandon après ${MAX_RETRIES} tentatives pour ${number}`);
          }
        }
      }
    });

    // Demande du Pairing Code
    if (res && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(number);
          if (!res.headersSent) res.json({ code, sessionToken: token });
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

// Route POST : Générer le code — PUBLIQUE (rate limitée), pas de clé maître ici.
// Chaque appel reçoit un sessionToken unique : lui seul pourra relire cette clé.
app.post('/api/pair', rateLimitPair, async (req, res) => {
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

  const token = crypto.randomBytes(24).toString('hex');
  pairingTokens.set(number, { token, expiresAt: Date.now() + TOKEN_TTL_MS });

  startSession(number, res, 0, token);
});

// Route GET : Vérifier le statut et renvoyer la CLÉ — PUBLIQUE, mais protégée par
// le sessionToken émis lors du /api/pair. Sans le bon token, un numéro seul ne
// suffit pas à récupérer une clé qui n'est pas la tienne.
app.get('/api/status', (req, res) => {
  const { number, token } = req.query;
  if (!number || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }

  const pairing = pairingTokens.get(number);
  if (!pairing || pairing.token !== token) {
    return res.status(403).json({ error: 'Token invalide — cette session ne t\'appartient pas.' });
  }
  if (Date.now() > pairing.expiresAt) {
    pairingTokens.delete(number);
    return res.status(410).json({ error: 'Session expirée. Relance un appairage.' });
  }

  const session = activeSessions.get(number);
  const credsPath = path.join(process.cwd(), `sessions/${number}/creds.json`);
  const fileExists = fs.existsSync(credsPath);

  let apiKey = null;
  let isConnected = session?.status === 'connected';

  // On ne renvoie la clé que si la session est réellement connectée (évite un faux positif sur un vieux creds.json)
  if (fileExists && isConnected) {
    try {
      const credsData = fs.readFileSync(credsPath);
      apiKey = credsData.toString('base64');
    } catch (e) {
      console.error(`[GATE] Erreur lors de la lecture de creds.json pour ${number}:`, e.message);
    }
  } else if (isConnected && session.sock?.authState?.creds) {
    try {
      console.log(`[GATE] ⚡ Clé récupérée directement en mémoire vive pour ${number}`);
      const credsJSON = JSON.stringify(session.sock.authState.creds);
      apiKey = Buffer.from(credsJSON).toString('base64');
    } catch (e) {
      console.error(`[GATE] Erreur lors de la sérialisation mémoire de creds pour ${number}:`, e.message);
    }
  }

  // Auto-destruction : AVANT de livrer la clé, on ferme et purge la session côté Gate.
  // Ça évite une connexion simultanée avec Gilgamesh qui va utiliser la même clé.
  // Gate disparaît complètement après ça — il n'existe plus pour ce numéro.
  if (apiKey) {
    pairingTokens.delete(number);
    // Tuer d'abord
    const s = activeSessions.get(number);
    if (s?.sock) { try { s.sock.end(undefined); } catch (e) {} }
    activeSessions.delete(number);
    const purgePath = `./sessions/${number}`;
    if (fs.existsSync(purgePath)) {
      fs.rmSync(purgePath, { recursive: true, force: true });
    }
    console.log(`[GATE] 🔥 Session ${number} tuée avant livraison de la clé — Gate disparaît.`);
  }

  res.json({
    connected: isConnected,
    status: isConnected ? 'connected' : (session?.status || 'unknown'),
    apiKey: apiKey
  });
});

// Route DELETE : Purger UNE session (numéro mort, code 401/loggedOut, etc.)
app.delete('/api/session/:number', requireApiKey, (req, res) => {
  const { number } = req.params;
  if (!number || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }

  const session = activeSessions.get(number);
  if (session?.sock) {
    try { session.sock.end(undefined); } catch (e) {}
  }
  activeSessions.delete(number);

  const sessionPath = `./sessions/${number}`;
  let deleted = false;
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    deleted = true;
  }

  console.log(`[GATE] 🗑️ Session ${number} purgée manuellement (dossier supprimé : ${deleted}).`);
  res.json({ purged: number, folderDeleted: deleted });
});

// Route DELETE : Purger TOUTES les sessions (reset complet, remplace le terminal Railway)
app.delete('/api/sessions', requireApiKey, (req, res) => {
  for (const [number, session] of activeSessions) {
    try { session.sock?.end(undefined); } catch (e) {}
  }
  activeSessions.clear();

  const sessionsDir = './sessions';
  let purgedFolders = [];
  if (fs.existsSync(sessionsDir)) {
    purgedFolders = fs.readdirSync(sessionsDir);
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  console.log(`[GATE] 🗑️ TOUTES les sessions purgées (${purgedFolders.length} dossier(s)).`);
  res.json({ purged: purgedFolders });
});

// Fermeture propre des sessions lors d'un redéploiement/arrêt (Render envoie SIGTERM)
function shutdown() {
  console.log('[GATE] 🛑 Arrêt en cours, fermeture des sessions actives...');
  for (const [, session] of activeSessions) {
    try { session.sock?.end(undefined); } catch (e) {}
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 GATE ouvert sur le port ${PORT}`);
  console.log('[GATE] /api/pair et /api/status sont publiques, protégées par sessionToken (pas la clé maître).');
  if (!GATE_API_KEY) {
    console.warn('[GATE] ⚠️ Aucune GATE_API_KEY définie — les routes DELETE (/api/session, /api/sessions) sont accessibles sans authentification.');
  }
});
