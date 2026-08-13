const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { parseGameCsv } = require('../lib/csvToGameData');
const { createGameStore } = require('../lib/gameStore');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 80;

// Factory takes the live server.js gameState by reference (mutated in place, never
// reassigned — see server.js resetGame()) so activation updates flow through the
// existing broadcastGameState() socket pipeline without any new event wiring.
module.exports = function createGamesRouter({ gameState, broadcastGameState, hostPassword }) {
    const router = express.Router();
    const store = createGameStore();

    const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 2 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const isCsv = file.mimetype === 'text/csv' ||
                file.mimetype === 'application/vnd.ms-excel' ||
                file.originalname.toLowerCase().endsWith('.csv');
            cb(isCsv ? null : new Error('Only .csv files are accepted.'), isCsv);
        }
    });

    function requireHostPassword(req, res, next) {
        const provided = Buffer.from(String(req.headers['x-host-password'] || ''), 'utf8');
        const expected = Buffer.from(String(hostPassword || ''), 'utf8');
        const match = provided.length === expected.length &&
            crypto.timingSafeEqual(provided, expected);
        if (!match) {
            return res.status(401).json({ errors: ['Invalid or missing host password.'] });
        }
        next();
    }

    // Lets upload.html confirm a typed password is actually correct before showing
    // "Unlocked" in the UI, instead of just trusting whatever was typed.
    router.post('/verify-password', requireHostPassword, (req, res) => {
        res.json({ ok: true });
    });

    router.post('/upload', requireHostPassword, (req, res) => {
        upload.single('csv')(req, res, async (uploadErr) => {
            if (uploadErr) {
                return res.status(400).json({ errors: [uploadErr.message] });
            }
            if (!req.file) {
                return res.status(400).json({ errors: ['No CSV file was uploaded (expected field name "csv").'] });
            }

            const name = String((req.body && req.body.name) || '').trim();
            if (!name) {
                return res.status(400).json({ errors: ['A game name is required.'] });
            }
            if (name.length > MAX_NAME_LENGTH) {
                return res.status(400).json({ errors: [`Game name must be ${MAX_NAME_LENGTH} characters or fewer.`] });
            }

            const { gameData, errors } = parseGameCsv(req.file.buffer);
            if (errors.length > 0) {
                return res.status(400).json({ errors });
            }

            const id = crypto.randomUUID();

            try {
                await store.saveGame(id, name, gameData);
                res.status(201).json({ id, name });
            } catch (saveErr) {
                console.error('Failed to save game:', saveErr);
                res.status(500).json({ errors: ['Failed to save the parsed game data.'] });
            }
        });
    });

    router.get('/', async (req, res) => {
        try {
            const list = await store.listGames();
            res.json(list);
        } catch (err) {
            console.error('Failed to list games:', err);
            res.status(500).json({ errors: ['Failed to load saved games.'] });
        }
    });

    router.post('/activate', requireHostPassword, async (req, res) => {
        const gameId = req.body && req.body.gameId;
        try {
            if (!gameId || !(await store.gameExists(gameId))) {
                return res.status(404).json({ errors: ['Unknown gameId.'] });
            }

            gameState.activeGameId = gameId;
            gameState.lastUpdate = Date.now();
            broadcastGameState();

            res.json({ activeGameId: gameId });
        } catch (err) {
            console.error('Failed to activate game:', err);
            res.status(500).json({ errors: ['Failed to activate game.'] });
        }
    });

    router.get('/:id', async (req, res) => {
        const { id } = req.params;
        if (!UUID_RE.test(id)) {
            return res.status(404).json({ errors: ['Game not found.'] });
        }

        try {
            const gameData = await store.getGame(id);
            if (!gameData) {
                return res.status(404).json({ errors: ['Game not found.'] });
            }
            res.json(gameData);
        } catch (err) {
            console.error('Failed to fetch game:', err);
            res.status(500).json({ errors: ['Failed to fetch game.'] });
        }
    });

    return router;
};
