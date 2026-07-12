const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, delay, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const app = express();
app.use(express.json());
app.use(express.static('public')); // C'est ici qu'on mettra la page web

// Stockage temporaire des sessions en cours
const sessions = new Map();

// 1. Endpoint pour générer le code
app.post('/api/get-code', async (req, res) => {
    // Nettoyer le numéro pour ne garder que les chiffres
    const phone = req.body.phone?.replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'Numéro invalide' });

    // Créer un dossier unique pour cette tentative de session
    const sessionId = `session-${phone}-${Date.now()}`;
    const sessionPath = path.join(__dirname, 'sessions', sessionId);
    fs.mkdirSync(sessionPath, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: "silent" }), // Désactive les logs abusifs de Baileys
            browser: Browsers.macOS('Chrome'), // Obligatoire pour que le pairing code fonctionne
        });

        // Enregistrer la session dans notre mémoire temporaire
        sessions.set(sessionId, { status: 'pending', path: sessionPath });

        // Sauvegarder les identifiants au fur et à mesure
        sock.ev.on('creds.update', saveCreds);
        
        // Écouter le changement d'état (quand le mec valide sur son tel)
        sock.ev.on('connection.update', (update) => {
            const { connection } = update;
            if (connection === 'open') {
                console.log(`[SUCCESS] Session ouverte pour ${phone}`);
                if (sessions.has(sessionId)) sessions.get(sessionId).status = 'ready';
                // On ferme le socket websocket pour ne pas consommer de RAM inutilement sur Railway
                setTimeout(() => sock.ws.close(), 3000); 
            }
        });

        // Attendre un peu que Baileys s'initialise puis demander le code
        await delay(1500); 
        const code = await sock.requestPairingCode(phone);
        
        // Renvoyer le code formaté (ex: ABCD-1234)
        const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
        res.json({ code: formattedCode, sessionId });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Erreur lors de la génération du code WhatsApp' });
    }
});

// 2. Endpoint pour vérifier si le gars a validé sur son téléphone
app.get('/api/status/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session expirée ou introuvable' });
    res.json({ status: session.status });
});

// 3. Endpoint pour télécharger le dossier auth en .zip
app.get('/api/download/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session || session.status !== 'ready') {
        return res.status(400).send('La session n\'est pas encore prête.');
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=${req.params.sessionId}.zip`);

    const archive = archiver('zip', { zlib: { level: 9 } }); // Compression max
    archive.pipe(res);
    archive.directory(session.path, false);
    archive.finalize();

    // Nettoyage de sécurité une fois le téléchargement terminé
    res.on('finish', () => {
        console.log(`[CLEANUP] Suppression de ${session.path}`);
        fs.rm(session.path, { recursive: true, force: true }, () => {});
        sessions.delete(req.params.sessionId);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur Gilgamesh Pairing lancé sur le port ${PORT}`);
});
