const { Redis } = require('@upstash/redis');

const GAME_KEY_PREFIX = 'jeopardy:game:';
const INDEX_KEY = 'jeopardy:games:index'; // Redis hash: field=id, value=JSON {name, uploadedAt}

// Upstash-backed game store — used when UPSTASH_REDIS_REST_URL/TOKEN are set (e.g. on
// Render), so uploaded games survive redeploys instead of living only on local disk.
// Unlike the file store, registry writes are naturally atomic per-field via HSET, so
// no serialized-write-queue workaround is needed here.
function createRedisGameStore(url, token) {
    const redis = new Redis({ url, token });

    // The Upstash client may hand back an already-parsed object (it auto-detects JSON
    // in some configurations) or a raw string, depending on how the value was written.
    function parseIfString(value) {
        return typeof value === 'string' ? JSON.parse(value) : value;
    }

    return {
        backend: 'redis',

        async listGames() {
            const all = await redis.hgetall(INDEX_KEY);
            if (!all) return [];
            return Object.entries(all)
                .map(([id, entry]) => {
                    const parsed = parseIfString(entry);
                    return { id, name: parsed.name, uploadedAt: parsed.uploadedAt };
                })
                .sort((a, b) => b.uploadedAt - a.uploadedAt);
        },

        async gameExists(id) {
            return Boolean(await redis.hexists(INDEX_KEY, id));
        },

        async getGame(id) {
            const raw = await redis.get(GAME_KEY_PREFIX + id);
            if (!raw) return null;
            return parseIfString(raw);
        },

        async saveGame(id, name, gameData) {
            await redis.set(GAME_KEY_PREFIX + id, JSON.stringify(gameData));
            await redis.hset(INDEX_KEY, { [id]: JSON.stringify({ name, uploadedAt: Date.now() }) });
        },

        // Overwrites an already-saved game's content (e.g. after attaching a photo to a
        // question) without touching its registry entry.
        async updateGame(id, gameData) {
            await redis.set(GAME_KEY_PREFIX + id, JSON.stringify(gameData));
        },

        // Removes a game's blob and its registry entry. Does not touch any images
        // attached to its questions (Cloudinary/uploads/ files are left orphaned).
        async deleteGame(id) {
            await redis.del(GAME_KEY_PREFIX + id);
            await redis.hdel(INDEX_KEY, id);
        }
    };
}

module.exports = { createRedisGameStore };
