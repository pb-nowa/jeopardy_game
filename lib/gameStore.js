const { createFileGameStore } = require('./fileGameStore');
const { createRedisGameStore } = require('./redisGameStore');

// Selects the games storage backend: Upstash Redis if UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN are set (e.g. on Render, so uploaded games survive
// redeploys), otherwise local-disk JSON files under games/ (zero-setup local dev).
// Both backends implement the same interface: listGames(), gameExists(id),
// getGame(id), saveGame(id, name, gameData) — see fileGameStore.js/redisGameStore.js.
function createGameStore() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (url && token) {
        console.log('Games storage: Upstash Redis');
        return createRedisGameStore(url, token);
    }

    if (process.env.NODE_ENV === 'production') {
        console.warn('WARNING: no Redis configured (UPSTASH_REDIS_REST_URL/TOKEN) — uploaded games will be stored on local disk and will NOT survive a redeploy on platforms with ephemeral storage (e.g. Render without a Persistent Disk).');
    }
    console.log('Games storage: local disk (games/)');
    return createFileGameStore();
}

module.exports = { createGameStore };
