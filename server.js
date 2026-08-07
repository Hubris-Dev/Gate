/**
 * GATE v3 — Service de Pairing WhatsApp Headless
 * 
 * Rôle : Générer des codes de pairing WhatsApp via Baileys.
 * Lifecycle : Éphémère. Après livraison de la clé, la session est DÉTRUITE.
 * 
 * Cette service est conçue pour être réutilisée par n'importe quel bot :
 * - Gilgamesh
 * - Autres démons du Codex
 * - N'importe quel projet qui a besoin de credentials WhatsApp frais
 * 
 * IMPORTANT : Gate n'est PAS un proxy vivant. C'est un générateur de clés.
 * Après /api/status, la session n'existe plus. Le bot utilise la clé en standalone.
 */

import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';
import Boom from '@hapi/boom';
import pino from 'pino';
import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import { PassThrough } from 'stream';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ============================================
// CONFIG
// ============================================
const PORT = process.env.PORT || 8080;
const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '600000'); // 10 min par défaut
const TOKEN_TTL_MS = parseInt(process.env.TOKEN_TTL_MS || '600000'); // 10 min
const GATE_API_KEY = process.env.GATE_API_KEY; // Optionnel, pour /api/session DELETE

// ============================================
// STATE GLOBAL
// ============================================
const activeSessions = new Map(); // number -> { sock, status, reason, createdAt, cleanupScheduled }
const pairingTokens = new Map(); // number -> { token, expiresAt }
const msgRetryCounterCache = new NodeCache();
let cachedVersion = null;

// ============================================
// NETTOYAGE AUTOMATIQUE
// ============================================

/**
 * Nettoie les tokens expirés toutes les 5 min
 * Évite les fuites mémoire.
 */
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [number, pairing] of pairingTokens) {
    if (now > pairing.expiresAt) {
      pairingTokens.delete(number);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[GATE] 🧹 Nettoyage tokens : ${cleaned} expirés supprimés.`);
  }
}, 5 * 60 * 1000);

/**
 * Tue les sessions qui ont dépassé leur TTL (inactivité trop longue)
 */
setInterval(() => {
  const now = Date.now();
  const toDestroy = [];
  
  for (const [number, session] of activeSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      toDestroy.push(number);
    }
  }
  
  toDestroy.forEach(number => {
    console.warn(`[GATE] ⏰ Session ${number} expirée (${SESSION_TTL_MS}ms) — destruction forcée.`);
    destroySessionImmediately(number);
  });
}, 30 * 1000); // Vérif toutes les 30s

// ============================================
// HELPERS DE DESTRUCTION
// ============================================

/**
 * Détruit COMPLÈTEMENT une session.
 * - Ferme la socket Baileys (tous les listeners)
 * - Supprime le dossier session
 * - Vire de activeSessions
 * 
 * ATOMIQUE : après cet appel, aucune trace n'existe.
 */
function destroySessionImmediately(number) {
  const session = activeSessions.get(number);
  
  if (session?.sock) {
    try {
      // Désenregistre tous les listeners Baileys pour éviter les calls après destruction
      session.sock.ev.removeAllListeners();
      // Ferme la socket
      session.sock.end(undefined);
    } catch (e) {
      console.warn(`[GATE] Erreur lors de la fermeture socket ${number}:`, e.message);
    }
  }
  
  activeSessions.delete(number);
  pairingTokens.delete(number);
  
  const sessionPath = path.join(SESSIONS_DIR, number);
  if (fs.existsSync(sessionPath)) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[GATE] Erreur suppression dossier ${number}:`, e.message);
    }
  }
  
  console.log(`[GATE] ✅ Session ${number} détruite complètement (socket + dossier purgés).`);
}

// ============================================
// HELPERS DE SESSION
// ============================================

async function getBaileysVersion() {
  if (!cachedVersion) {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
  }
  return cachedVersion;
}

async function zipSessionToBase64(sessionPath) {
  return new Promise((resolve, reject) => {
    try {
      const archive = archiver('zip', { zlib: { level: 9 } });
      const pass = new PassThrough();
      const chunks = [];

      pass.on('data', c => chunks.push(c));
      pass.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          resolve(buffer.toString('base64'));
        } catch (e) {
          reject(e);
        }
      });

      archive.on('warning', err => {
        if (err.code !== 'ENOENT') reject(err);
      });
      archive.on('error', err => reject(err));

      archive.pipe(pass);
      archive.directory(sessionPath, false);
      archive.finalize();
    } catch (e) {
      reject(e);
    }
  });
}

// ============================================
// SESSION LIFECYCLE
// ============================================

/**
 * Crée une nouvelle session Baileys et attend le pairing code.
 * 
 * Process :
 * 1. init useMultiFileAuthState
 * 2. créer socket
 * 3. enregistrer event handlers (creds.update, connection.update)
 * 4. attendre "connection: open" OU timeout
 * 5. quand connecté → générer pairing code
 * 6. retourner le code au client
 * 
 * La session reste en attente dans activeSessions jusqu'à /api/status
 */
async function startSession(number, res = null, retryCount = 0, token = null) {
  const sessionPath = path.join(SESSIONS_DIR, number);
  
  try {
    const version = await getBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      logger: pino({ level: 'silent' }),
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

    const session = {
      sock,
      status: 'pending',
      reason: null,
      pairingCodeSent: false,
      createdAt: Date.now(),
      cleanupScheduled: false
    };
    activeSessions.set(number, session);

    // ─── Connection Update Handler ───
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        session.status = 'connected';
        console.log(`[GATE] ✅ Connexion établie pour ${number}`);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error instanceof Boom.Boom)
          ? lastDisconnect.error.output?.statusCode
          : undefined;

        console.error(`[GATE] Déconnexion ${number} (code ${statusCode})`);

        if (statusCode === DisconnectReason.loggedOut) {
          // Session révoquée côté WhatsApp → destruction immédiate
          console.warn(`[GATE] ${number} : loggedOut détecté → destruction.`);
          destroySessionImmediately(number);
        } else if (statusCode === 515 || statusCode === 408) {
          // Connexion perdue (réseau, etc.) → retry avec backoff
          if (retryCount < 5) {
            const delay = Math.min(3000 * Math.pow(2, retryCount), 30000);
            console.log(`[GATE] ${number} retry ${retryCount + 1}/5 dans ${delay}ms...`);
            setTimeout(() => {
              startSession(number, null, retryCount + 1, token);
            }, delay);
          } else {
            session.status = 'failed';
            console.error(`[GATE] ${number} : abandon après 5 retries.`);
            destroySessionImmediately(number);
          }
        }
      }
    });

    // ─── Pairing Code Request ───
    // On attend un peu que la connexion soit prête avant de demander le code
    const requestPairingWithDelay = () => {
      setTimeout(async () => {
        if (session.pairingCodeSent || session.status === 'failed') return;
        
        try {
          const code = await sock.requestPairingCode(number);
          session.pairingCodeSent = true;
          
          if (res && !res.headersSent) {
            console.log(`[GATE] 📱 Code pairing pour ${number} : ${code}`);
            res.json({ code, sessionToken: token });
          }
        } catch (e) {
          console.error(`[GATE] Erreur pairing code ${number}:`, e.message);
          if (res && !res.headersSent) {
            res.status(500).json({ error: 'Erreur génération code.' });
          }
        }
      }, 1000); // Attendre 1s que la socket soit prête
    };

    if (res) {
      requestPairingWithDelay();
    }

  } catch (err) {
    console.error(`[GATE] Erreur startSession ${number}:`, err.message);
    if (res && !res.headersSent) {
      res.status(500).json({ error: `Erreur : ${err.message}` });
    }
    destroySessionImmediately(number);
  }
}

// ============================================
// RESTAURATION AU DÉMARRAGE
// ============================================

async function restoreSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    return;
  }

  const folders = fs.readdirSync(SESSIONS_DIR).filter(f => 
    fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()
  );

  if (folders.length === 0) {
    console.log('[GATE] Aucune session sauvegardée.');
    return;
  }

  console.log(`[GATE] Restauration de ${folders.length} session(s)...`);
  const results = await Promise.allSettled(
    folders.map(folder => startSession(folder))
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;
  console.log(`[GATE] Restauration : ${succeeded} OK, ${failed} échouées.`);
}

// ============================================
// MIDDLEWARE
// ============================================

function requireApiKey(req, res, next) {
  if (!GATE_API_KEY) {
    console.warn('[GATE] ⚠️ Pas de GATE_API_KEY — DELETE endpoints accessibles sans auth');
    return next();
  }
  if (req.headers['x-api-key'] !== GATE_API_KEY) {
    return res.status(401).json({ error: 'API key invalide' });
  }
  next();
}

// Rate limit basique sur /api/pair
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

function rateLimitPair(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const attempts = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);

  if (attempts.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Trop de tentatives.' });
  }

  attempts.push(now);
  rateLimitMap.set(ip, attempts);
  next();
}

// ============================================
// ROUTES
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    activeSessions: activeSessions.size,
    pendingTokens: pairingTokens.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

/**
 * POST /api/pair
 * 
 * Crée une nouvelle session et retourne un pairing code.
 * 
 * Body : { number: "50944448099" }
 * Response : { code: "5E6G66RJ", sessionToken: "abc123..." }
 * 
 * Le sessionToken est nécessaire pour appeler /api/status.
 */
app.post('/api/pair', rateLimitPair, async (req, res) => {
  const { number } = req.body || {};
  
  if (!number || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ error: 'Numéro invalide (8-15 chiffres)' });
  }

  console.log(`[GATE] Nouvelle session demandée pour ${number}`);

  // Si une session existe, la tuer complètement (sinon on crée des doublons)
  const previous = activeSessions.get(number);
  if (previous) {
    destroySessionImmediately(number);
  }

  // Créer un token unique pour cette session
  const token = crypto.randomBytes(24).toString('hex');
  pairingTokens.set(number, { token, expiresAt: Date.now() + TOKEN_TTL_MS });

  // Lancer la session — elle répondra avec le code une fois prête
  startSession(number, res, 0, token);
});

/**
 * GET /api/status
 * 
 * Vérifie l'état de la session et retourne la clé si connectée.
 * 
 * Query : ?number=50944448099&token=abc123...
 * Response : 
 *   - Si pas connecté : { connected: false, status: "pending" }
 *   - Si connecté : { connected: true, status: "connected", apiKey: "base64..." }
 * 
 * ⚠️ IMPORTANT : Une fois apiKey retournée, la session est DÉTRUITE.
 * Plus de trace après ça. Le bot utilise la clé en standalone.
 */
app.get('/api/status', async (req, res) => {
  const { number, token } = req.query;

  if (!number || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }

  // Vérifier le token (sécurité)
  const pairing = pairingTokens.get(number);
  if (!pairing || pairing.token !== token) {
    return res.status(403).json({ error: 'Token invalide ou expiré' });
  }

  const session = activeSessions.get(number);
  const sessionPath = path.join(SESSIONS_DIR, number);
  const credsPath = path.join(sessionPath, 'creds.json');

  // Vérifier que la session existe ET est connectée
  const hasSessionDir = fs.existsSync(sessionPath);
  const hasCredsFile = hasSessionDir && fs.existsSync(credsPath);
  const isConnected = session?.status === 'connected' && hasCredsFile;

  // ─── Cas 1 : Pas connecté → retourner l'état ───
  if (!isConnected) {
    return res.json({
      connected: false,
      status: session?.status || 'unknown',
      apiKey: null
    });
  }

  // ─── Cas 2 : Connecté → extraire clé + DÉTRUIRE la session ───
  let apiKey = null;
  try {
    apiKey = await zipSessionToBase64(sessionPath);
    console.log(`[GATE] ✅ Clé générée pour ${number} (${(apiKey.length / 1024).toFixed(1)}KB)`);
  } catch (e) {
    console.error(`[GATE] Erreur zippage ${number}:`, e.message);
    return res.status(500).json({ error: 'Erreur extraction clé' });
  }

  // ─── DESTRUCTION IMMÉDIATE ───
  // C'est CRITIQUE. Une fois la clé donnée, la session doit mourir.
  // Pas de proxy vivant après.
  destroySessionImmediately(number);

  console.log(`[GATE] 🚀 Clé livrée à ${number} — session AUTO-DÉTRUITE. Gate disparaît pour ce numéro.`);

  res.json({
    connected: true,
    status: 'connected',
    apiKey: apiKey,
    message: 'Clé extraite. Session détruite côté Gate. Utilise cette clé en standalone.'
  });
});

/**
 * DELETE /api/session/:number
 * 
 * Purge manuellement une session (sécurité, admin).
 * Nécessite GATE_API_KEY si définie.
 */
app.delete('/api/session/:number', requireApiKey, (req, res) => {
  const { number } = req.params;

  if (!number || !/^\d{8,15}$/.test(number)) {
    return res.status(400).json({ error: 'Numéro invalide' });
  }

  console.log(`[GATE] Purge manuelle de ${number} (DELETE request)`);
  destroySessionImmediately(number);

  res.json({ purged: number, message: 'Session purgée complètement.' });
});

/**
 * DELETE /api/sessions
 * 
 * Purge TOUTES les sessions (reset complet).
 * Nécessite GATE_API_KEY si définie.
 */
app.delete('/api/sessions', requireApiKey, (req, res) => {
  const count = activeSessions.size;
  
  for (const number of activeSessions.keys()) {
    destroySessionImmediately(number);
  }

  res.json({ purgedCount: count, message: 'Toutes les sessions purgées.' });
});

// ============================================
// DÉMARRAGE
// ============================================

restoreSessions().catch(err => {
  console.error('[GATE] Erreur restauration:', err.message);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[GATE] SIGTERM — arrêt gracieux...');
  for (const number of activeSessions.keys()) {
    destroySessionImmediately(number);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[GATE] SIGINT — arrêt gracieux...');
  for (const number of activeSessions.keys()) {
    destroySessionImmediately(number);
  }
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [GATE] Ouvert sur port ${PORT}`);
  console.log('[GATE] POST /api/pair — Créer une nouvelle session + code');
  console.log('[GATE] GET /api/status?number=...&token=... — Vérifier + extraire clé (destruction après)');
  console.log('[GATE] DELETE /api/session/:number — Purger une session (admin)');
  console.log('[GATE] /health et /ping pour monitoring');
  console.log(`[GATE] SESSION_TTL_MS: ${SESSION_TTL_MS}ms, TOKEN_TTL_MS: ${TOKEN_TTL_MS}ms`);
  if (!GATE_API_KEY) {
    console.warn('[GATE] ⚠️ Pas de GATE_API_KEY — DELETE accessibles sans auth (à éviter en prod)');
  }
});
