const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

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

function broadcastGameState() {
    // Send different game states to different client types
    io.sockets.sockets.forEach((socket) => {
        if (socket.clientType === 'player') {
            socket.emit('gameStateUpdate', gameState); // Players get full state
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

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`New client connected: ${socket.id}`);
    
    // Track client type (will be set when they identify themselves)
    socket.clientType = 'unknown';
    
    // Send current game state to new client (filter out early buzzes for now)
    socket.emit('gameStateUpdate', getGameStateForHost());
    
    // Handle client identification
    socket.on('identifyClient', (clientType) => {
        socket.clientType = clientType; // 'host', 'player', or 'jeopardy'
        console.log(`Client ${socket.id} identified as: ${clientType}`);
        
        // Send appropriate game state based on client type
        if (clientType === 'player') {
            socket.emit('gameStateUpdate', gameState); // Players need full state for cooldowns
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
                lastSeen: Date.now()
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
                // For early buzzes, send full state to the player and filtered state to others
                socket.emit('gameStateUpdate', gameState); // Player gets full state for cooldown
                socket.broadcast.emit('gameStateUpdate', getGameStateForHost()); // Others get filtered state
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
            // Deduct points from the team
            pointsDeducted = gameState.currentQuestionValue || 0;
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

    socket.on('newQuestion', () => {
        // Reset for new question
        gameState.hostControls.buzzEnabled = false;
        gameState.currentQuestion = null;
        gameState.buzzes = [];
        gameState.lastUpdate = Date.now();
        
        broadcastGameState();
        io.emit('newQuestion');
        
        console.log('New question started');
    });

    socket.on('resetGame', () => {
        // Reset entire game state
        gameState = {
            players: [],
            buzzes: [],
            buzzingEnabled: false,
            currentQuestion: null,
            currentQuestionValue: 0,
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
        };
        
        broadcastGameState();
        io.emit('gameReset');
        
        console.log('Game reset');
    });

    // Handle Jeopardy question display
    socket.on('jeopardyQuestion', (questionData) => {
        console.log(`Jeopardy question displayed: $${questionData.value}`);
        
        // Store current question value for scoring
        gameState.currentQuestionValue = questionData.value || 0;
        gameState.lastUpdate = Date.now();
        
        // Broadcast to all connected clients (especially host)
        io.emit('jeopardyQuestionUpdate', questionData);
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