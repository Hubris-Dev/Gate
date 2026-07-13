const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    Browsers,
    makeCacheableSignalKeyStore // LE SECRET DES BOTS MD EST ICI
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json());

// On s'assure que le serveur pointe vers le bon dossier de manière absolue
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const sessions = new Map();
const msgRetryCounterCache = new NodeCache(); // Cache pour stabiliser WhatsApp

app.post('/api/get-code', async (req, res) => {
    const phone = req.body.phone?.replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'Numéro invalide' });

    const sessionId = `session-${phone}-${Date.now()}`;
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    fs.mkdirSync(sessionPath, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const logger = pino({ level: "silent" });

        const sock = makeWASocket({
            auth: {
                creds: state.creds,
                // On met en cache les clés pour répondre super vite à WhatsApp
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger: logger,
            browser: Browsers.ubuntu('Chrome'), // Signature robuste
            msgRetryCounterCache, // Activation du cache
            syncFullHistory: false // On ne télécharge pas les anciens messages
        });

        sessions.set(sessionId, { status: 'pending', path: sessionPath });

        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(`[SUCCESS] Session ouverte pour ${phone}`);
                if (sessions.has(sessionId)) sessions.get(sessionId).status = 'ready';
                
                // On laisse la connexion ouverte 5 secondes pour être sûr que WhatsApp valide bien le tout
                setTimeout(() => {
                    try { sock.ws.close(); } catch(e) {}
                }, 5000); 
            }
        });

        // On attend que la connexion soit bien stable avant de demander le code
        await delay(2000); 
        const code = await sock.requestPairingCode(phone);
        
        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
        res.json({ code: formattedCode, sessionId });

    } catch (error) {
        console.error("Erreur de génération:", error);
        res.status(500).json({ error: 'Erreur lors de la génération du code WhatsApp' });
    }
});

// ... (Garde tes endpoints /api/status et /api/download exactement comme avant) ...

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Serveur Gilgamesh Pairing lancé sur le port ${PORT}`);
});
