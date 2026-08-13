# 🎯 Jeopardy Buzzer System with WebSocket

A real-time multi-device Jeopardy buzzer system with WebSocket support for seamless network-based gameplay.

## 🚀 Quick Start

**Requires Node 18+.** A `.nvmrc` is included — run `nvm use` (or `nvm install` if you don't have 18 yet) before the steps below if you use nvm. Older Node versions will fail to load the `csv-parse`/`multer` dependencies.

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Start the Server**
   ```bash
   npm start
   ```

3. **Access the Game**
   - Main registration: http://localhost:3000
   - Host controls: http://localhost:3000/host.html
   - Game board: http://localhost:3000/jeopardy.html
   - Upload/manage games: http://localhost:3000/upload.html

## 📱 How to Play

### For Players:
1. Open http://localhost:3000 on your device
2. Enter your name and select a team (1-4)
3. Click "Join Game" to access the buzzer interface
4. Wait for the host to enable buzzing
5. Tap the large 🚨 button to buzz in when ready!

### For Host:
1. Open http://localhost:3000/host.html
2. Monitor player registrations across all 4 teams
3. Click "Enable Buzzing" when ready for a question
4. Watch live buzzes come in with timing and rankings
5. Mark answers as correct ✅ or wrong ❌
6. Use "New Question" to reset for the next question
7. Use the "📁 Upload Game" link at the bottom to jump to `/upload.html` and switch which question set is active

## 🌐 Network Features

### Real-time Communication:
- **WebSocket-based**: Instant updates across all devices
- **Auto-reconnection**: Handles network interruptions gracefully
- **Presence tracking**: Shows online/offline status for all players
- **2-second cooldown**: Prevents spam buzzing with lockout period

### Multi-device Support:
- **Cross-platform**: Works on phones, tablets, laptops
- **Mobile optimized**: Large touch-friendly buttons for phones
- **Network play**: Multiple devices can connect over local network
- **Team management**: 4-team system with color coding

## 🎮 System Architecture

### Server (Node.js + Express + Socket.IO):
- `server.js` - Main Express server with WebSocket handling
- Real-time game state management
- Player registration and presence tracking
- Buzz timing and validation
- Host control commands

### Client (HTML + JavaScript):
- `index.html` - Player registration page
- `player.html` - Player buzzer interface
- `host.html` - Host control panel
- `shared.js` - WebSocket communication layer
- `jeopardy.html` - Original game board (optional)

## 📊 API Endpoints

- `GET /api/gamestate` - Current game state (JSON), including `activeGameId`
- `GET /api/stats` - Game statistics and server uptime
- `GET /api/version` - Deployed commit SHA and server start time (see "Checking which version is deployed" below)
- `GET /api/games` - List uploaded games (id, name, upload time)
- `GET /api/games/:id` - Fetch a specific uploaded game's board data
- `POST /api/games/upload` - Upload a CSV game (requires `x-host-password` header, see below)
- `POST /api/games/activate` - Make an uploaded game the active one (requires `x-host-password` header)
- `POST /api/games/verify-password` - Checks whether a password is correct without performing any action (used by `/upload.html`'s "Unlock" button); requires `x-host-password` header
- All real-time communication via WebSocket events

## 📁 Uploading Custom Games (CSV)

Visit `/upload.html` to upload a CSV of questions instead of hand-editing `hints.json`. You'll need the host password (see Configuration below) to upload or activate a game; anyone can view the saved-games list.

**CSV columns**: `Name, Difficulty, Question, Answer, "Round, order", isDoubleJeopardy` (an optional `Image URL` column is also accepted — reserved for an upcoming photo-question feature and currently unused).

- `Name` is the category, `Difficulty` (1-5) sets which dollar-value row the question lands on.
- `"Round, order"` is a single column holding `"<round>,<order>"`, e.g. `"1,3"` means round 1, 3rd category from the left. Each round you use needs exactly 5 distinct categories (orders 1-5) with exactly 5 questions each (difficulties 1-5) — rounds 1, 2, and 3 are each optional, but whichever you include must be complete.
- **Final Jeopardy**: put the literal text `Final Jeopardy` in the `Round, order` column for that row. `Name` becomes the FJ category, `Question` the clue, `Answer` the response.
- `isDoubleJeopardy` is `TRUE`/`FALSE` per question.

After uploading, click **Activate** on the game in the saved-games list — the game board (`jeopardy.html`) picks up the change live via WebSocket, no refresh needed. Team scores are not affected by switching games; use the host's "Reset Team Scores" action separately if you want a clean scoreboard for a new match.

Clicking **Unlock** on `/upload.html` actually verifies the password against the server before showing "Unlocked" — a wrong password shows an error instead of a false-positive unlocked state, and if a password is ever rejected mid-session (e.g. it was changed on the server), the UI drops back to locked automatically.

## 🔖 Checking Which Version Is Deployed

`GET /api/version` returns the deployed commit SHA — on Render this comes from the automatically-set `RENDER_GIT_COMMIT` env var, so it always matches whatever was actually pushed (no manual version bumping needed). It's also shown as a small tag at the bottom of the home page (`index.html`), which is the fastest way to confirm a redeploy actually picked up your latest push.

## 🔧 Configuration

### Environment Variables:
Copy `.env.example` to `.env` and fill in real values for local development — it's loaded automatically (and gitignored, so secrets never get committed).

- **`HOST_PASSWORD`** — required in production; gates the CSV upload/activate endpoints. If unset locally (not in production), the server falls back to the dev password `dev` and prints a warning. **The server refuses to start in production without `HOST_PASSWORD` set**, rather than running with an open upload endpoint.
- **`UPSTASH_REDIS_REST_URL`** / **`UPSTASH_REDIS_REST_TOKEN`** — optional. When both are set, uploaded games are stored in [Upstash Redis](https://upstash.com) instead of local disk, so they survive redeploys on hosts with ephemeral storage (see the Render section below). Get these free from the Upstash console:
  1. Sign up at [console.upstash.com](https://console.upstash.com) (free tier, no credit card).
  2. Create a Redis database (any region close to your Render service).
  3. Open the database → **REST API** tab → copy the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` values.
  4. Set both as environment variables (in `.env` locally, or in Render's dashboard for production).

  If these aren't set, the app automatically falls back to storing uploaded games as JSON files under `games/` (today's behavior) — no setup required, just less durable on ephemeral hosts.

### Server Settings (server.js):
- **Port**: 3000 (or environment PORT)
- **Buzz Cooldown**: 2 seconds
- **Player Timeout**: 2 minutes of inactivity
- **Data Cleanup**: Every 30 minutes

### Network Access:
To allow other devices on your network to connect:
1. Find your computer's IP address
2. Other devices can access: `http://YOUR_IP:3000`
3. Make sure firewall allows connections on port 3000

## 🌍 Deploying to Render

This app needs a host that keeps a Node process running persistently (in-memory game state + WebSockets) — that rules out static hosts and serverless functions. [Render](https://render.com) works well:

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In the Render dashboard: **New → Web Service**, connect the repo.
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. Under **Environment**, add `HOST_PASSWORD` set to a password of your choice — the server will refuse to start without it.
6. Also add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (see above) so uploaded games persist across redeploys — strongly recommended for anything beyond a one-off local test.
7. Deploy. Render assigns a public URL and sets `PORT` automatically (already handled by `server.js`).

**⚠️ Storage caveat (only if you skip Redis)**: without the Upstash env vars set, uploaded games fall back to a `games/` folder on local disk. Render's standard (non-Persistent-Disk) tier wipes that folder on every redeploy — fine for a single party (you won't redeploy mid-event), but games won't survive across multiple separate deploys. Setting up the free Upstash Redis database above avoids this entirely.

## 🎯 Features

### Buzzer System:
- ✅ Real-time buzzing with instant feedback
- ✅ Visual indicators (waiting, enabled, locked, answered)
- ✅ Buzz ranking and timing display
- ✅ Mobile vibration feedback
- ✅ Early buzz lockout (2-second penalty)

### Team Management:
- ✅ 4-team system with distinct colors
- ✅ Real-time teammate lists
- ✅ Online/offline status indicators
- ✅ Player count per team

### Host Controls:
- ✅ Enable/disable buzzing on demand
- ✅ Mark correct/wrong answers
- ✅ Clear buzzes between questions
- ✅ Real-time player monitoring
- ✅ Game statistics dashboard
- ✅ Export game data

### Mobile Optimization:
- ✅ Responsive design for all screen sizes
- ✅ Large touch-friendly buttons
- ✅ Portrait/landscape orientation support
- ✅ Optimized for phone screens

## 🎊 Perfect for Birthday Jeopardy!

This system is ideal for party games where:
- Guests use their own phones as buzzers
- Host controls the game from a central device
- Real-time competition with instant feedback
- No need for physical buzzer hardware
- Supports large groups (unlimited players across 4 teams)

## 🔍 Troubleshooting

### Connection Issues:
- Check that server is running (`npm start`)
- Verify all devices are on same network
- Try refreshing the page to reconnect
- Check browser console for error messages

### Performance:
- Server automatically cleans up old data
- Inactive players removed after 2 minutes
- WebSocket reconnection handles network drops
- Tested with multiple simultaneous users

## 🎮 Development

### Start Development Server:
```bash
npm run dev  # Uses nodemon for auto-restart
```

### Project Structure:
```
├── server.js          # Express + Socket.IO server
├── shared.js          # WebSocket client communication
├── index.html         # Player registration
├── player.html        # Player buzzer interface
├── host.html          # Host control panel
├── jeopardy.html      # Game board
├── upload.html        # CSV game upload / activation
├── lib/csvToGameData.js  # CSV parsing + validation
├── lib/gameStore.js    # Picks Redis vs local-disk storage backend
├── lib/fileGameStore.js   # Local-disk backend (games/*.json)
├── lib/redisGameStore.js  # Upstash Redis backend
├── routes/games.js    # Upload/list/activate/fetch API for uploaded games
├── games/              # Local-disk game storage, used when Redis isn't configured (gitignored)
├── .env.example        # Template for local environment variables
└── package.json       # Node.js dependencies
```

Enjoy your real-time Jeopardy buzzer experience! 🎉 