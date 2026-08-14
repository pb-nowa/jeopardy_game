require('dotenv').config({ quiet: true }); // loads .env if present; no-op (and no error) if it doesn't exist

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const { execSync } = require('child_process');

// Render automatically sets RENDER_GIT_COMMIT to the deployed commit SHA — use that in
// production so the running deploy can be identified without any manual version bump.
// Falls back to reading the local git HEAD for local dev.
function resolveVersion() {
    if (process.env.RENDER_GIT_COMMIT) {
        return process.env.RENDER_GIT_COMMIT.slice(0, 7);
    }
    try {
        return execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
    } catch (err) {
        return 'unknown';
    }
}

const APP_VERSION = resolveVersion();
const APP_STARTED_AT = Date.now();

// Gates the CSV upload/activate endpoints (routes/games.js). Refuse to boot with an
// open, unauthenticated upload endpoint in production; allow an obvious dev fallback
// (with a loud warning) so local development doesn't require env setup.
const HOST_PASSWORD = process.env.HOST_PASSWORD || (process.env.NODE_ENV !== 'production' ? 'dev' : null);
if (!HOST_PASSWORD) {
    console.error('FATAL: HOST_PASSWORD environment variable is not set. Refusing to start in production without it.');
    process.exit(1);
}
if (HOST_PASSWORD === 'dev') {
    console.warn('WARNING: using default dev HOST_PASSWORD ("dev"). Set the HOST_PASSWORD env var before deploying.');
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// Game state management
let gameState = {
    players: [],
    buzzes: [],
    buzzingEnabled: false,
    currentQuestion: null,
    currentQuestionValue: 0, // Current question point value
    currentDailyDoubleWager: null, // {team, amount} once submitted for the current Daily Double, cleared on resolution or new question
    finalJeopardy: {
        phase: 'inactive', // 'inactive' | 'wagering' | 'answering' | 'resolving' | 'complete'
        wagers: { 1: null, 2: null, 3: null, 4: null },
        answers: { 1: null, 2: null, 3: null, 4: null },
        resolved: { 1: false, 2: false, 3: false, 4: false },
        revealed: { 1: false, 2: false, 3: false, 4: false }, // host has shown this team's answer on the board at least once
        revealedTeam: null, // which team's answer the board is currently displaying, for reconnect resync
        wagerRevealed: { 1: false, 2: false, 3: false, 4: false }, // host has shown this team's wager on the board at least once (only after its answer is revealed)
        revealedWagerTeam: null // which team's wager the board is currently displaying, for reconnect resync
    },
    activeGameId: null, // id of the uploaded game currently loaded on the board (routes/games.js)
    activeGameContentVersion: 0, // bumped whenever a question in the active game is edited, so jeopardy.html knows to reload even when activeGameId itself hasn't changed
    teamScores: {
        1: 0,
        2: 0,
        3: 0,
        4: 0
    },
    hostControls: {
        buzzEnabled: false,
        buzzCooldown: 2000, // 2 seconds
        questionActive: false
    },
    lastUpdate: Date.now()
};

// Utility functions
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function generateBuzzId() {
    return 'buzz_' + generateId();
}

function generateQuestionId() {
    return 'question_' + generateId();
}

function getTeamMembers(teamNumber) {
    return gameState.players.filter(p => p.team === teamNumber);
}

function getCurrentQuestionBuzzes() {
    if (!gameState.currentQuestion) return [];
    
    return gameState.buzzes
        .filter(b => b.questionId === gameState.currentQuestion)
        .sort((a, b) => a.timestamp - b.timestamp);
}

function getGameStateForHost() {
    // Return game state with early buzzes filtered out
    return {
        ...gameState,
        buzzes: gameState.buzzes.filter(b => !b.isEarlyBuzz)
    };
}

// Redacts other teams' Final Jeopardy wagers/answers so a player never sees a rival
// team's secret value before the host's public reveal — only the viewer's own team's
// entries keep their real value; every other team's entry is null regardless of
// whether that team has actually submitted (no partial "submitted" signal either —
// full secrecy is simplest to reason about and nothing else needs it). viewerTeam is
// null for a not-yet-registered/not-yet-identified socket, which redacts everything.
function getGameStateForPlayer(viewerTeam) {
    const redactedWagers = {};
    const redactedAnswers = {};
    for (const team of [1, 2, 3, 4]) {
        redactedWagers[team] = team === viewerTeam ? gameState.finalJeopardy.wagers[team] : null;
        redactedAnswers[team] = team === viewerTeam ? gameState.finalJeopardy.answers[team] : null;
    }

    return {
        ...gameState,
        finalJeopardy: {
            ...gameState.finalJeopardy,
            wagers: redactedWagers,
            answers: redactedAnswers
        }
    };
}

function getViewerTeamForSocket(socket) {
    const player = gameState.players.find(p => p.socketId === socket.id);
    return player ? player.team : null;
}

function broadcastGameState() {
    // Send different game states to different client types
    io.sockets.sockets.forEach((socket) => {
        if (socket.clientType === 'player') {
            socket.emit('gameStateUpdate', getGameStateForPlayer(getViewerTeamForSocket(socket)));
        } else {
            socket.emit('gameStateUpdate', getGameStateForHost()); // Hosts get filtered state
        }
    });
}

function cleanupOldData() {
    const cutoff = Date.now() - (30 * 60 * 1000); // 30 minutes
    
    // Remove old buzzes
    gameState.buzzes = gameState.buzzes.filter(b => b.timestamp > cutoff);
    
    // Remove inactive players (not seen for 2 minutes)
    const playerCutoff = Date.now() - (2 * 60 * 1000);
    const disconnectedPlayers = gameState.players.filter(p => 
        !p.lastSeen || p.lastSeen < playerCutoff
    );
    
    gameState.players = gameState.players.filter(p => 
        p.lastSeen && p.lastSeen >= playerCutoff
    );
    
    // Notify all clients if players were removed
    if (disconnectedPlayers.length > 0) {
        broadcastGameState();
        disconnectedPlayers.forEach(player => {
            console.log(`Player ${player.name} (${player.id}) disconnected`);
        });
    }
}

// Run cleanup every minute
setInterval(cleanupOldData, 60000);

// CSV game upload/activation API (mutates the live gameState by reference — see
// resetGame() below, which is careful to mutate in place rather than reassign
// `gameState`, so this reference never goes stale).
app.use('/api/games', require('./routes/games')({ gameState, broadcastGameState, hostPassword: HOST_PASSWORD }));

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);
    
    // Track client type (will be set when they identify themselves)
    socket.clientType = 'unknown';

    // Send current game state to new client. We don't yet know whether this socket
    // will turn out to be a player or a host, so default to the more restrictive
    // player-redacted view (safe either way — a real host's correct full view arrives
    // moments later once identifyClient below completes) rather than assuming host.
    socket.emit('gameStateUpdate', getGameStateForPlayer(null));

    // Handle client identification
    socket.on('identifyClient', (clientType) => {
        socket.clientType = clientType; // 'host', 'player', or 'jeopardy'
        console.log(`Client ${socket.id} identified as: ${clientType}`);

        // Send appropriate game state based on client type
        if (clientType === 'player') {
            socket.emit('gameStateUpdate', getGameStateForPlayer(getViewerTeamForSocket(socket)));
        } else {
            socket.emit('gameStateUpdate', getGameStateForHost()); // Hosts get filtered state
        }
    });

    // Handle player registration
    socket.on('registerPlayer', (playerData) => {
        try {
            // Check if name already exists
            const existingPlayer = gameState.players.find(p => 
                p.name.toLowerCase() === playerData.name.toLowerCase()
            );
            
            if (existingPlayer) {
                socket.emit('registrationError', 'Name already taken. Please choose a different name.');
                return;
            }

            // Add player to game
            const player = {
                id: generateId(),
                socketId: socket.id,
                name: playerData.name,
                team: parseInt(playerData.team),
                joinedAt: Date.now(),
                lastSeen: Date.now(),
                penaltyUntil: 0
            };

            gameState.players.push(player);
            gameState.lastUpdate = Date.now();

            // Send success response with player data
            socket.emit('registrationSuccess', player);
            
            // Broadcast updated game state to all clients (filter out early buzzes)
            broadcastGameState();
            
            console.log(`Player registered: ${player.name} (Team ${player.team})`);
        } catch (error) {
            console.error('Registration error:', error);
            socket.emit('registrationError', 'Failed to register player');
        }
    });

    // Handle player presence updates
    socket.on('updatePresence', (playerId) => {
        const player = gameState.players.find(p => p.id === playerId);
        if (player) {
            player.lastSeen = Date.now();
            player.socketId = socket.id; // Update socket ID in case of reconnection
        }
    });

    // Handle buzz attempts
    socket.on('attemptBuzz', (buzzData) => {
        try {
            const { playerId, playerName, team } = buzzData;
            const now = Date.now();
            
            // Find player and enforce global penalty (regardless of question state)
            const player = gameState.players.find(p => p.id === playerId);
            if (!player) {
                socket.emit('buzzResult', { 
                    success: false, 
                    reason: 'error',
                    message: 'Player not found'
                });
                return;
            }
            if (player.penaltyUntil && now < player.penaltyUntil) {
                const remainingTime = player.penaltyUntil - now;
                socket.emit('buzzResult', { 
                    success: false, 
                    reason: 'cooldown', 
                    remainingTime: remainingTime,
                    message: `Please wait ${Math.ceil(remainingTime / 1000)} seconds (early buzz penalty)`
                });
                return;
            }
            
            // Check if player is in cooldown (only applies to early buzzes for current question)
            const existingBuzz = gameState.buzzes.find(b => 
                b.playerId === playerId && b.questionId === gameState.currentQuestion
            );
            if (existingBuzz && existingBuzz.isEarlyBuzz && (now - existingBuzz.timestamp) < gameState.hostControls.buzzCooldown) {
                const remainingTime = gameState.hostControls.buzzCooldown - (now - existingBuzz.timestamp);
                socket.emit('buzzResult', { 
                    success: false, 
                    reason: 'cooldown', 
                    remainingTime: remainingTime,
                    message: `Please wait ${Math.ceil(remainingTime / 1000)} seconds (early buzz penalty)`
                });
                return;
            }
            
            // Check if there's already a winner for this question
            const currentWinner = gameState.buzzes.find(b => 
                b.questionId === gameState.currentQuestion && b.isWinner
            );
            if (currentWinner) {
                socket.emit('buzzResult', { 
                    success: false, 
                    reason: 'already_answered',
                    message: 'Question already answered'
                });
                return;
            }
            
            // Check if someone else has already buzzed in for this question
            const currentQuestionBuzzes = gameState.buzzes.filter(b => 
                b.questionId === gameState.currentQuestion && !b.isWinner
            );
            const someoneElseBuzzed = currentQuestionBuzzes.find(b => b.playerId !== playerId);
            
            if (someoneElseBuzzed) {
                socket.emit('buzzResult', { 
                    success: false, 
                    reason: 'someone_already_buzzed',
                    message: `${someoneElseBuzzed.playerName} already buzzed in`
                });
                return;
            }
            
            // Determine if this is an early buzz (before host enables buzzing)
            const isEarlyBuzz = !gameState.hostControls.buzzEnabled;
            
            // If early buzz, set/extend player penalty
            if (isEarlyBuzz) {
                const newPenaltyUntil = now + (gameState.hostControls.buzzCooldown || 2000);
                player.penaltyUntil = Math.max(player.penaltyUntil || 0, newPenaltyUntil);
            }
            
            // Add or update buzz for current question
            const buzzIndex = gameState.buzzes.findIndex(b => 
                b.playerId === playerId && b.questionId === gameState.currentQuestion
            );
            const newBuzz = {
                id: generateBuzzId(),
                playerId: playerId,
                playerName: playerName,
                team: team,
                timestamp: now,
                questionId: gameState.currentQuestion,
                isWinner: false,
                isEarlyBuzz: isEarlyBuzz
            };
            
            if (buzzIndex >= 0) {
                // Replace existing buzz for this question
                gameState.buzzes[buzzIndex] = newBuzz;
            } else {
                // Add new buzz
                gameState.buzzes.push(newBuzz);
            }
            
            gameState.lastUpdate = Date.now();
            
            // Send success response
            const responseMessage = isEarlyBuzz ? 
                'Early buzz! You will have a cooldown penalty.' : 
                'Buzz successful!';
            
            socket.emit('buzzResult', { 
                success: true, 
                buzzId: newBuzz.id,
                isEarlyBuzz: isEarlyBuzz,
                message: responseMessage
            });
            
            // Send different updates based on buzz type
            if (isEarlyBuzz) {
                // broadcastGameState() already sends each socket the right shape (players
                // get their own Final-Jeopardy-redacted view, hosts get the filtered view)
                // — no newBuzz event for early buzzes, unlike the branch below, since
                // those shouldn't trigger the loud "buzz!" notification.
                broadcastGameState();
            } else {
                // For normal buzzes, broadcast to all clients appropriately
                broadcastGameState();
                io.emit('newBuzz', newBuzz); // Special event for immediate buzz notification
            }
            
            const buzzType = isEarlyBuzz ? '(EARLY)' : '';
            console.log(`Buzz ${buzzType}: ${playerName} (Team ${team}) - ${new Date(now).toLocaleTimeString()}`);
        } catch (error) {
            console.error('Buzz error:', error);
            socket.emit('buzzResult', { 
                success: false, 
                reason: 'error',
                message: 'Failed to process buzz'
            });
        }
    });

    // Handle host controls
    socket.on('enableBuzzing', (questionId) => {
        if (!questionId) {
            questionId = generateQuestionId();
        }
        
        gameState.hostControls.buzzEnabled = true;
        gameState.currentQuestion = questionId;
        gameState.lastUpdate = Date.now();
        
        // Clear old buzzes for new question
        gameState.buzzes = gameState.buzzes.filter(b => 
            b.questionId !== questionId
        );
        
        broadcastGameState();
        io.emit('buzzingEnabled', { questionId });
        
        console.log(`Buzzing enabled for question: ${questionId}`);
    });

    socket.on('disableBuzzing', () => {
        gameState.hostControls.buzzEnabled = false;
        gameState.currentQuestion = null;
        gameState.lastUpdate = Date.now();
        
        broadcastGameState();
        io.emit('buzzingDisabled');
        
        console.log('Buzzing disabled');
    });

    socket.on('clearBuzzes', () => {
        if (gameState.currentQuestion) {
            gameState.buzzes = gameState.buzzes.filter(b => 
                b.questionId !== gameState.currentQuestion
            );
        } else {
            gameState.buzzes = [];
        }
        
        gameState.lastUpdate = Date.now();
        broadcastGameState();
        
        console.log('Buzzes cleared');
    });

    socket.on('markBuzzCorrect', (buzzId) => {
        const buzz = gameState.buzzes.find(b => b.id === buzzId);
        if (buzz) {
            // Clear other winners for this question
            gameState.buzzes.forEach(b => {
                if (b.questionId === buzz.questionId) {
                    b.isWinner = false;
                }
            });
            
            // Set this buzz as winner
            buzz.isWinner = true;
            
            // Add points to the team
            const pointsToAdd = gameState.currentQuestionValue || 0;
            if (gameState.teamScores[buzz.team] !== undefined) {
                gameState.teamScores[buzz.team] += pointsToAdd;
                console.log(`Added ${pointsToAdd} points to Team ${buzz.team}. New score: ${gameState.teamScores[buzz.team]}`);
            }
            
            gameState.lastUpdate = Date.now();
            
            // Disable buzzing after correct answer
            gameState.hostControls.buzzEnabled = false;
            
            broadcastGameState();
            io.emit('buzzMarkedCorrect', { 
                buzzId, 
                playerName: buzz.playerName, 
                team: buzz.team,
                pointsAdded: pointsToAdd,
                newTeamScore: gameState.teamScores[buzz.team]
            });
            
            console.log(`Marked correct: ${buzz.playerName} (Team ${buzz.team}) +${pointsToAdd} points`);
        }
    });

    socket.on('markBuzzWrong', (buzzId) => {
        const buzz = gameState.buzzes.find(b => b.id === buzzId);
        let pointsDeducted = 0;
        let team = null;
        let playerName = '';
        
        if (buzz) {
            // Deduct half the question value, rounded up to the nearest $50 (standard questions only)
            const baseValue = gameState.currentQuestionValue || 0;
            pointsDeducted = Math.ceil((baseValue / 2) / 50) * 50;
            team = buzz.team;
            playerName = buzz.playerName;
            
            if (gameState.teamScores[buzz.team] !== undefined) {
                gameState.teamScores[buzz.team] -= pointsDeducted;
                console.log(`Deducted ${pointsDeducted} points from Team ${buzz.team}. New score: ${gameState.teamScores[buzz.team]}`);
            }
        }
        
        // Remove this buzz, keep buzzing enabled
        gameState.buzzes = gameState.buzzes.filter(b => b.id !== buzzId);
        gameState.lastUpdate = Date.now();
        
        broadcastGameState();
        io.emit('buzzMarkedWrong', { 
            buzzId, 
            playerName,
            team,
            pointsDeducted,
            newTeamScore: team ? gameState.teamScores[team] : 0
        });
        
        console.log(`Buzz marked wrong: ${playerName} (Team ${team}) -${pointsDeducted} points`);
    });

    socket.on('dismissBuzz', (buzzId) => {
        const buzz = gameState.buzzes.find(b => b.id === buzzId);
        let playerName = '';
        let team = null;
        
        if (buzz) {
            playerName = buzz.playerName;
            team = buzz.team;
        }
        
        // Remove this buzz without affecting score, keep buzzing enabled
        gameState.buzzes = gameState.buzzes.filter(b => b.id !== buzzId);
        gameState.lastUpdate = Date.now();
        
        broadcastGameState();
        io.emit('buzzDismissed', { 
            buzzId, 
            playerName,
            team
        });
        
        console.log(`Buzz dismissed: ${playerName} (Team ${team}) - no score change`);
    });

    // Daily Double: no buzz-in happens (the picking team already has control), so
    // scoring can't reuse the buzz-based markBuzzCorrect/markBuzzWrong flow above —
    // there's no buzz object to attach a winner to. Instead the host submits a
    // {team, amount} wager up front, then resolves it for 100% gain/loss of that
    // wager (not the board's fixed value, which doesn't apply to a Daily Double).
    socket.on('submitDailyDoubleWager', (data) => {
        const team = parseInt(data && data.team, 10);
        const amount = parseInt(data && data.amount, 10);

        if (!(team >= 1 && team <= 4) || !(Number.isInteger(amount) && amount > 0)) {
            socket.emit('dailyDoubleWagerError', 'Please select a team and enter a wager amount greater than $0.');
            return;
        }

        gameState.currentDailyDoubleWager = { team, amount };
        gameState.lastUpdate = Date.now();

        broadcastGameState();
        io.emit('dailyDoubleWagerSubmitted', { team, amount });

        console.log(`Daily Double wager submitted: Team ${team}, $${amount}`);
    });

    socket.on('markDailyDoubleCorrect', () => {
        const wager = gameState.currentDailyDoubleWager;
        if (!wager) return;

        if (gameState.teamScores[wager.team] !== undefined) {
            gameState.teamScores[wager.team] += wager.amount;
        }

        gameState.hostControls.buzzEnabled = false;
        gameState.currentDailyDoubleWager = null;
        gameState.lastUpdate = Date.now();

        broadcastGameState();
        io.emit('dailyDoubleResolved', {
            team: wager.team,
            amount: wager.amount,
            correct: true,
            newTeamScore: gameState.teamScores[wager.team]
        });

        console.log(`Daily Double correct: Team ${wager.team} +$${wager.amount}. New score: ${gameState.teamScores[wager.team]}`);
    });

    socket.on('markDailyDoubleWrong', () => {
        const wager = gameState.currentDailyDoubleWager;
        if (!wager) return;

        if (gameState.teamScores[wager.team] !== undefined) {
            gameState.teamScores[wager.team] -= wager.amount;
        }

        gameState.hostControls.buzzEnabled = false;
        gameState.currentDailyDoubleWager = null;
        gameState.lastUpdate = Date.now();

        broadcastGameState();
        io.emit('dailyDoubleResolved', {
            team: wager.team,
            amount: wager.amount,
            correct: false,
            newTeamScore: gameState.teamScores[wager.team]
        });

        console.log(`Daily Double wrong: Team ${wager.team} -$${wager.amount}. New score: ${gameState.teamScores[wager.team]}`);
    });

    // Final Jeopardy: all four teams compete simultaneously (unlike Daily Double's
    // single team), each wagering privately based on the category, then writing an
    // answer, then getting scored individually by the host. gameState.finalJeopardy
    // .phase gates which actions are valid at any given moment: 'inactive' ->
    // 'wagering' -> 'answering' -> 'resolving' -> 'complete'. Player-facing broadcasts
    // redact every team's wagers/answers except the viewer's own (see
    // getGameStateForPlayer) until each team's individual public reveal during
    // resolution.
    socket.on('enterFinalJeopardy', () => {
        // Only the first entry starts wagering — re-visiting the board's Final
        // Jeopardy tab after progress has already begun must never reset it.
        if (gameState.finalJeopardy.phase !== 'inactive') return;

        gameState.finalJeopardy.phase = 'wagering';
        gameState.lastUpdate = Date.now();
        broadcastGameState();

        console.log('Final Jeopardy: wagering opened');
    });

    socket.on('submitFinalJeopardyWager', (data) => {
        if (gameState.finalJeopardy.phase !== 'wagering') {
            socket.emit('finalJeopardySubmitError', 'Wagers are not open right now.');
            return;
        }

        const team = parseInt(data && data.team, 10);
        const maxWager = (team >= 1 && team <= 4) ? Math.max(0, gameState.teamScores[team] || 0) : 0;
        const amount = parseInt(data && data.amount, 10);

        if (!(team >= 1 && team <= 4) || !Number.isInteger(amount) || amount < 0 || amount > maxWager) {
            socket.emit('finalJeopardySubmitError', `Wager must be a whole number between $0 and $${maxWager}.`);
            return;
        }

        gameState.finalJeopardy.wagers[team] = amount;
        gameState.lastUpdate = Date.now();
        broadcastGameState();

        console.log(`Final Jeopardy wager: Team ${team} -> $${amount}`);
    });

    socket.on('lockFinalJeopardyWagers', () => {
        if (gameState.finalJeopardy.phase !== 'wagering') return;

        // A team that never submitted (or has zero players) can't block the host.
        for (const team of [1, 2, 3, 4]) {
            if (gameState.finalJeopardy.wagers[team] === null) {
                gameState.finalJeopardy.wagers[team] = 0;
            }
        }

        gameState.finalJeopardy.phase = 'answering';
        gameState.lastUpdate = Date.now();
        broadcastGameState();
        // Signal only — no wager data in the payload. The real per-team values already
        // flow correctly through the redacted gameStateUpdate broadcast above; this
        // event exists purely to trigger the board's imperative transition to the hint.
        io.emit('finalJeopardyWagersLocked');

        console.log('Final Jeopardy: wagers locked, answering opened');
    });

    socket.on('submitFinalJeopardyAnswer', (data) => {
        if (gameState.finalJeopardy.phase !== 'answering') {
            socket.emit('finalJeopardySubmitError', 'Answers are not open right now.');
            return;
        }

        const team = parseInt(data && data.team, 10);
        const answer = String((data && data.answer) || '').trim().slice(0, 200);

        if (!(team >= 1 && team <= 4) || !answer) {
            socket.emit('finalJeopardySubmitError', 'Please enter an answer.');
            return;
        }

        gameState.finalJeopardy.answers[team] = answer;
        gameState.lastUpdate = Date.now();
        broadcastGameState();

        console.log(`Final Jeopardy answer: Team ${team} submitted an answer`);
    });

    socket.on('lockFinalJeopardyAnswers', () => {
        if (gameState.finalJeopardy.phase !== 'answering') return;

        gameState.finalJeopardy.phase = 'resolving';
        gameState.lastUpdate = Date.now();
        broadcastGameState();
        // Signal only, same reasoning as finalJeopardyWagersLocked above.
        io.emit('finalJeopardyAnswersLocked');

        console.log('Final Jeopardy: answers locked, resolving');
    });

    // Host-controlled per-team reveal: unlike the real Final Jeopardy answer (kept
    // hidden until every team is scored), a team's own submitted answer is fair to
    // show the whole party the moment the host clicks through to it, so this is a
    // full broadcast rather than the redacted gameStateUpdate path.
    socket.on('revealFinalJeopardyTeamAnswer', (data) => {
        if (gameState.finalJeopardy.phase !== 'resolving') return;
        const team = parseInt(data && data.team, 10);
        if (!(team >= 1 && team <= 4)) return;

        gameState.finalJeopardy.revealed[team] = true;
        gameState.finalJeopardy.revealedTeam = team;
        gameState.lastUpdate = Date.now();
        broadcastGameState();
        io.emit('finalJeopardyTeamAnswerRevealed', {
            team,
            answer: gameState.finalJeopardy.answers[team]
        });

        console.log(`Final Jeopardy: revealed Team ${team}'s answer`);
    });

    // Second reveal step — only after the team's answer is already shown, mirroring
    // the real show's beat of seeing the response before the amount riding on it.
    socket.on('revealFinalJeopardyTeamWager', (data) => {
        if (gameState.finalJeopardy.phase !== 'resolving') return;
        const team = parseInt(data && data.team, 10);
        if (!(team >= 1 && team <= 4)) return;
        if (!gameState.finalJeopardy.revealed[team]) return;

        gameState.finalJeopardy.wagerRevealed[team] = true;
        gameState.finalJeopardy.revealedWagerTeam = team;
        gameState.lastUpdate = Date.now();
        broadcastGameState();
        io.emit('finalJeopardyTeamWagerRevealed', {
            team,
            wager: gameState.finalJeopardy.wagers[team]
        });

        console.log(`Final Jeopardy: revealed Team ${team}'s wager`);
    });

    function resolveFinalJeopardyTeam(team, correct) {
        if (gameState.finalJeopardy.phase !== 'resolving') return;
        if (gameState.finalJeopardy.resolved[team]) return;
        if (!gameState.finalJeopardy.wagerRevealed[team]) return;

        const wager = gameState.finalJeopardy.wagers[team] || 0;
        if (gameState.teamScores[team] !== undefined) {
            gameState.teamScores[team] += correct ? wager : -wager;
        }
        gameState.finalJeopardy.resolved[team] = true;
        gameState.lastUpdate = Date.now();

        // Once every team has been scored, Final Jeopardy is complete — the board/
        // panels keep showing the full results (nobody wants the final reveal to
        // vanish instantly); returning to 'inactive' is an explicit host action
        // (resetFinalJeopardy, below).
        const allResolved = [1, 2, 3, 4].every(t => gameState.finalJeopardy.resolved[t]);
        if (allResolved) {
            gameState.finalJeopardy.phase = 'complete';
        }

        broadcastGameState();
        // Full broadcast is correct here, unlike the lock events above — once a team's
        // result is being revealed, that's the public dramatic-reveal moment in real
        // Final Jeopardy too, with no secrecy left to protect.
        io.emit('finalJeopardyTeamResolved', {
            team,
            correct,
            wager,
            newTeamScore: gameState.teamScores[team]
        });

        if (allResolved) {
            // Signal only — every team's result is already public via
            // finalJeopardyTeamResolved above. This just tells the board it's safe
            // to reveal the actual correct answer now that nothing is left to protect.
            io.emit('finalJeopardyComplete');
        }

        console.log(`Final Jeopardy resolved: Team ${team} ${correct ? 'correct' : 'wrong'} (wager $${wager}). New score: ${gameState.teamScores[team]}`);
    }

    socket.on('markFinalJeopardyTeamCorrect', (data) => {
        const team = parseInt(data && data.team, 10);
        if (team >= 1 && team <= 4) resolveFinalJeopardyTeam(team, true);
    });

    socket.on('markFinalJeopardyTeamWrong', (data) => {
        const team = parseInt(data && data.team, 10);
        if (team >= 1 && team <= 4) resolveFinalJeopardyTeam(team, false);
    });

    socket.on('resetFinalJeopardy', () => {
        gameState.finalJeopardy = {
            phase: 'inactive',
            wagers: { 1: null, 2: null, 3: null, 4: null },
            answers: { 1: null, 2: null, 3: null, 4: null },
            resolved: { 1: false, 2: false, 3: false, 4: false },
            revealed: { 1: false, 2: false, 3: false, 4: false },
            revealedTeam: null,
            wagerRevealed: { 1: false, 2: false, 3: false, 4: false },
            revealedWagerTeam: null
        };
        gameState.lastUpdate = Date.now();
        broadcastGameState();
        io.emit('finalJeopardyReset');

        console.log('Final Jeopardy reset');
    });

    socket.on('resetTeamScores', () => {
        // Reset all team scores to 0
        gameState.teamScores = {
            1: 0,
            2: 0,
            3: 0,
            4: 0
        };
        gameState.lastUpdate = Date.now();
        
        broadcastGameState();
        io.emit('teamScoresReset');
        
        console.log('Team scores reset to 0');
    });

    socket.on('updateTeamScore', (data) => {
        const { teamNumber, newScore } = data;
        
        // Validate team number
        if (teamNumber >= 1 && teamNumber <= 4) {
            gameState.teamScores[teamNumber] = newScore;
            gameState.lastUpdate = Date.now();
            
            broadcastGameState();
            io.emit('teamScoreUpdated', { teamNumber, newScore });
            
            console.log(`Team ${teamNumber} score updated to ${newScore}`);
        } else {
            console.error('Invalid team number:', teamNumber);
        }
    });

    socket.on('closeJeopardyModal', () => {
        // Send event to jeopardy board to close modal
        io.emit('closeModal');
        console.log('Close modal command sent to jeopardy board');
    });

    socket.on('clearHostJeopardyDisplay', () => {
        // Send event to host to clear jeopardy question display
        io.emit('clearJeopardyDisplay');
        console.log('Clear jeopardy display command sent to host');
    });

    socket.on('newQuestion', () => {
        // Reset for new question
        gameState.hostControls.buzzEnabled = false;
        gameState.currentQuestion = null;
        gameState.buzzes = [];
        gameState.currentDailyDoubleWager = null;
        gameState.lastUpdate = Date.now();
        
        broadcastGameState();
        io.emit('newQuestion');
        
        console.log('New question started');
    });

    socket.on('resetGame', () => {
        // Reset buzzer/score state in place (never reassign `gameState` — routes/games.js
        // holds a reference to this exact object). activeGameId is deliberately left
        // untouched: switching the buzzer/score state isn't the same as unloading the
        // currently active question set.
        Object.assign(gameState, {
            players: [],
            buzzes: [],
            buzzingEnabled: false,
            currentQuestion: null,
            currentQuestionValue: 0,
            currentDailyDoubleWager: null,
            finalJeopardy: {
                phase: 'inactive',
                wagers: { 1: null, 2: null, 3: null, 4: null },
                answers: { 1: null, 2: null, 3: null, 4: null },
                resolved: { 1: false, 2: false, 3: false, 4: false },
                revealed: { 1: false, 2: false, 3: false, 4: false },
                revealedTeam: null,
                wagerRevealed: { 1: false, 2: false, 3: false, 4: false },
                revealedWagerTeam: null
            },
            teamScores: {
                1: 0,
                2: 0,
                3: 0,
                4: 0
            },
            hostControls: {
                buzzEnabled: false,
                buzzCooldown: 2000,
                questionActive: false
            },
            lastUpdate: Date.now()
        });

        broadcastGameState();
        io.emit('gameReset');

        console.log('Game reset');
    });

    // Handle Jeopardy question display
    socket.on('jeopardyQuestion', (questionData) => {
        console.log(`Jeopardy question displayed: $${questionData.value}`);
        
        // Store current question value for scoring. A fresh question — Daily Double or
        // not — always invalidates any prior wager.
        gameState.currentQuestionValue = questionData.value || 0;
        gameState.currentDailyDoubleWager = null;
        gameState.lastUpdate = Date.now();
        
        // Broadcast to all connected clients (especially host)
        io.emit('jeopardyQuestionUpdate', questionData);
    });

    // The Final Jeopardy category/hint/correct-answer live only in the board's
    // client-side gameData, not in server state — the board relays them here purely
    // so the host's screen can show them too, the same way it sees every other
    // question. This never reaches players, and the board itself withholds the
    // correct answer from its own public display until every team is scored.
    socket.on('finalJeopardyQuestionData', (data) => {
        io.emit('finalJeopardyQuestionDataUpdate', data);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        
        // Mark player as potentially disconnected, but don't remove immediately
        // The cleanup function will handle removing inactive players
        const player = gameState.players.find(p => p.socketId === socket.id);
        if (player) {
            console.log(`Player ${player.name} socket disconnected`);
        }
    });

    // Handle errors
    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });
});

// REST API endpoints (backup/debugging)
app.get('/api/gamestate', (req, res) => {
    res.json(gameState);
});

app.get('/api/stats', (req, res) => {
    const stats = {
        totalPlayers: gameState.players.length,
        activePlayers: gameState.players.filter(p => 
            p.lastSeen && (Date.now() - p.lastSeen) < 120000
        ).length,
        totalBuzzes: getCurrentQuestionBuzzes().length,
        buzzingEnabled: gameState.hostControls.buzzEnabled,
        currentQuestion: gameState.currentQuestion,
        uptime: process.uptime()
    };
    res.json(stats);
});

app.get('/api/version', (req, res) => {
    res.json({
        version: APP_VERSION,
        startedAt: APP_STARTED_AT
    });
});

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎯 Jeopardy Buzzer Server running on port ${PORT}`);
    console.log(`📱 Open http://localhost:${PORT} to play`);
    console.log(`🎮 Host controls: http://localhost:${PORT}/host.html`);
    console.log(`🎲 Game board: http://localhost:${PORT}/jeopardy.html`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\nSIGINT received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
}); 