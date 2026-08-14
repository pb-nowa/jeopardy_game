const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const GAMES_DIR = path.join(__dirname, '..', 'games');
const INDEX_PATH = path.join(GAMES_DIR, 'index.json');

function loadRegistrySync() {
    try {
        const raw = fs.readFileSync(INDEX_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return [];
    }
}

// Local-disk game store — used when no Redis credentials are configured (e.g. local
// dev, or a production deploy that hasn't set up Redis yet). Registry writes are
// serialized through a promise queue since two concurrent uploads could otherwise
// race on read-modify-write of index.json.
function createFileGameStore() {
    fs.mkdirSync(GAMES_DIR, { recursive: true });
    const registry = loadRegistrySync();
    let writeQueue = Promise.resolve();

    function persistRegistry() {
        const snapshot = JSON.stringify(registry, null, 2);
        writeQueue = writeQueue
            .then(() => fsp.writeFile(INDEX_PATH, snapshot))
            .catch(err => console.error('Failed to persist games/index.json:', err));
        return writeQueue;
    }

    return {
        backend: 'file',

        async listGames() {
            return registry
                .slice()
                .sort((a, b) => b.uploadedAt - a.uploadedAt)
                .map(({ id, name, uploadedAt }) => ({ id, name, uploadedAt }));
        },

        async gameExists(id) {
            return registry.some(g => g.id === id);
        },

        async getGame(id) {
            try {
                const raw = await fsp.readFile(path.join(GAMES_DIR, `${id}.json`), 'utf8');
                return JSON.parse(raw);
            } catch (err) {
                return null;
            }
        },

        async saveGame(id, name, gameData) {
            await fsp.writeFile(path.join(GAMES_DIR, `${id}.json`), JSON.stringify(gameData, null, 2));
            registry.push({ id, name, uploadedAt: Date.now() });
            await persistRegistry();
        },

        // Overwrites an already-saved game's content (e.g. after attaching a photo to a
        // question) without touching its registry entry.
        async updateGame(id, gameData) {
            await fsp.writeFile(path.join(GAMES_DIR, `${id}.json`), JSON.stringify(gameData, null, 2));
        },

        // Removes a game's blob and its registry entry. Does not touch any images
        // attached to its questions (Cloudinary/uploads/ files are left orphaned).
        async deleteGame(id) {
            const idx = registry.findIndex(g => g.id === id);
            if (idx !== -1) {
                registry.splice(idx, 1);
                await persistRegistry();
            }
            try {
                await fsp.unlink(path.join(GAMES_DIR, `${id}.json`));
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
        }
    };
}

module.exports = { createFileGameStore };
