const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { parseGameCsv, escapeHtml } = require('../lib/csvToGameData');
const { createGameStore } = require('../lib/gameStore');
const { createImageStore } = require('../lib/imageStore');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 80;
const IMAGE_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Factory takes the live server.js gameState by reference (mutated in place, never
// reassigned — see server.js resetGame()) so activation updates flow through the
// existing broadcastGameState() socket pipeline without any new event wiring.
module.exports = function createGamesRouter({ gameState, broadcastGameState, hostPassword }) {
    const router = express.Router();
    const store = createGameStore();
    const imageStore = createImageStore();

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

    const uploadImage = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 8 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const isImage = IMAGE_MIMETYPES.includes(file.mimetype);
            cb(isImage ? null : new Error('Only JPEG, PNG, WebP, or GIF images are accepted.'), isImage);
        }
    });

    // Serializes read-modify-write updates to a single game's blob (GET full JSON ->
    // mutate one question -> PUT full JSON back isn't atomic on either storage backend).
    // Covers both backends from one place rather than duplicating locking into each store.
    const updateLocks = new Map();
    function withGameLock(id, fn) {
        const prev = updateLocks.get(id) || Promise.resolve();
        const run = prev.catch(() => {}).then(fn);
        updateLocks.set(id, run.catch(() => {}));
        return run;
    }

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

    // Attaches/replaces/removes a single question's photo and/or hint text within an
    // already-saved game. Multipart fields: round ("1"/"2"/"3"/"final"), category +
    // difficulty ("1"-"5", both required unless round==="final"), hint (optional text,
    // including "" to blank it), image (optional file), removeImage ("true").
    router.post('/:id/questions', requireHostPassword, (req, res) => {
        uploadImage.single('image')(req, res, async (uploadErr) => {
            if (uploadErr) {
                return res.status(400).json({ errors: [uploadErr.message] });
            }

            const { id } = req.params;
            if (!UUID_RE.test(id)) {
                return res.status(404).json({ errors: ['Game not found.'] });
            }

            const body = req.body || {};
            const round = String(body.round || '');
            const isFinal = round === 'final';
            // category must round-trip the exact string GET /api/games/:id returned —
            // never trimmed/normalized. Some CSV-parsed category names contain literal
            // quote characters (e.g. a `"""USA"""` cell parses to the string `"USA"`),
            // so a straight === lookup against the stored key is the only correct match.
            const category = body.category;
            const difficulty = parseInt(body.difficulty, 10);
            const removeImage = body.removeImage === 'true';
            const hintProvided = Object.prototype.hasOwnProperty.call(body, 'hint');
            const hint = hintProvided ? String(body.hint) : undefined;

            if (!isFinal && !['1', '2', '3'].includes(round)) {
                return res.status(400).json({ errors: ['round must be "1", "2", "3", or "final".'] });
            }
            if (!isFinal && !category) {
                return res.status(400).json({ errors: ['category is required for non-Final-Jeopardy questions.'] });
            }
            if (!isFinal && !(difficulty >= 1 && difficulty <= 5)) {
                return res.status(400).json({ errors: ['difficulty must be 1-5 for non-Final-Jeopardy questions.'] });
            }

            try {
                const question = await withGameLock(id, async () => {
                    const gameData = await store.getGame(id);
                    if (!gameData) {
                        throw Object.assign(new Error('Game not found.'), { status: 404 });
                    }

                    let target;
                    if (isFinal) {
                        target = gameData.finalJeopardy;
                        if (!target) {
                            throw Object.assign(new Error('This game has no Final Jeopardy question.'), { status: 404 });
                        }
                    } else {
                        const roundData = gameData[`round${round}`];
                        const categoryQuestions = roundData && roundData.questions && roundData.questions[category];
                        target = categoryQuestions && categoryQuestions[difficulty - 1];
                        if (!target) {
                            throw Object.assign(new Error('Question not found — check round/category/difficulty.'), { status: 404 });
                        }
                    }

                    if (hintProvided) {
                        target.hint = escapeHtml(hint);
                    }

                    if (req.file) {
                        const { url, publicId } = await imageStore.uploadImage(req.file.buffer, { mimetype: req.file.mimetype });
                        target.imageUrl = url;
                        target.imagePublicId = publicId;
                    } else if (removeImage) {
                        target.imageUrl = null;
                        target.imagePublicId = null;
                    }

                    await store.updateGame(id, gameData);

                    // Live-update the board if this game is currently active. Bumping a
                    // version counter (rather than just re-broadcasting) matters here:
                    // jeopardy.html only reloads when activeGameId *changes*, so setting
                    // it to the same value again would be a silent no-op client-side.
                    if (gameState.activeGameId === id) {
                        gameState.activeGameContentVersion = (gameState.activeGameContentVersion || 0) + 1;
                        gameState.lastUpdate = Date.now();
                        broadcastGameState();
                    }

                    return target;
                });

                res.json(question);
            } catch (err) {
                if (err.status) {
                    return res.status(err.status).json({ errors: [err.message] });
                }
                console.error('Failed to update question:', err);
                res.status(500).json({ errors: ['Failed to update question.'] });
            }
        });
    });

    return router;
};
