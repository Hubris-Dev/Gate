const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const app = express();
const NodeCache = require('node-cache');

app.use(express.json());
app.use(express.static('public')); // Place ton fichier HTML dans un dossier "public"

const msgRetryCounterCache = new NodeCache();
const activeSessions = new Map();

// Route pour générer le code
app.post('/api/pair', async (req, res) => {
    const { number } = req.body;
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${number}`);
    
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        logger: pino({ level: "silent" }),
        msgRetryCounterCache
    });

    sock.ev.on('creds.update', saveCreds);

    try {
        const code = await sock.requestPairingCode(number);
        activeSessions.set(number, { sock, connected: false });
        
        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'open') {
                activeSessions.get(number).connected = true;
            }
        });

        res.json({ code });
    } catch (e) {
        res.status(500).json({ error: 'Erreur génération' });
    }
});

// Route pour vérifier la connexion
app.get('/api/status', (req, res) => {
    const { number } = req.query;
    const session = activeSessions.get(number);
    res.json({ connected: session ? session.connected : false });
});

app.listen(8080, () => console.log('GATE ouvert sur le port 8080'));
