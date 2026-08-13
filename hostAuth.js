// Shared host-password gate, used by upload.html and edit-photos.html. Verifies a
// typed password against the server (POST /api/games/verify-password) before
// caching it in sessionStorage — never trusts whatever was typed. Also silently
// re-verifies a cached password on page load, in case it was changed server-side
// since the last visit.
//
// Usage:
//   const auth = initHostAuth({ onChange: () => { ...update your page's UI... } });
//   auth.isUnlocked()          -> boolean
//   auth.getPassword()         -> string (only meaningful once unlocked)
//   auth.unlock(candidate)     -> Promise<boolean>
//   auth.resetToLocked(reason) -> call this when a real request comes back 401,
//                                 so a stale/rejected password doesn't leave the
//                                 UI stuck showing "Unlocked"
function initHostAuth({ onChange } = {}) {
    let hostPassword = '';
    let unlocked = false;

    function notify() {
        if (typeof onChange === 'function') onChange();
    }

    async function verifyPassword(candidate) {
        try {
            const res = await fetch('/api/games/verify-password', {
                method: 'POST',
                headers: { 'x-host-password': candidate }
            });
            return res.ok;
        } catch (err) {
            return false;
        }
    }

    async function unlock(candidate) {
        const ok = await verifyPassword(candidate);
        if (ok) {
            hostPassword = candidate;
            unlocked = true;
            sessionStorage.setItem('hostPassword', hostPassword);
        } else {
            unlocked = false;
        }
        notify();
        return ok;
    }

    function resetToLocked() {
        hostPassword = '';
        unlocked = false;
        sessionStorage.removeItem('hostPassword');
        notify();
    }

    const ready = (async function restoreSession() {
        const cached = sessionStorage.getItem('hostPassword');
        if (!cached) return;
        const ok = await verifyPassword(cached);
        if (ok) {
            hostPassword = cached;
            unlocked = true;
        } else {
            sessionStorage.removeItem('hostPassword');
        }
        notify();
    })();

    return {
        isUnlocked: () => unlocked,
        getPassword: () => hostPassword,
        unlock,
        resetToLocked,
        ready
    };
}
