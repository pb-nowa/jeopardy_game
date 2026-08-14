// WebSocket-based game state management
let socket = null;
let gameState = {
    players: [],
    buzzes: [],
    buzzingEnabled: false,
    currentQuestion: null,
    hostControls: {
        buzzEnabled: false,
        buzzCooldown: 2000, // 2 seconds
        questionActive: false
    },
    lastUpdate: Date.now()
};

// Initialize WebSocket connection
function initializeSocket() {
    if (socket && socket.connected) {
        return socket;
    }

    // Connect to server
    socket = io();
    // `socket` above is module-scoped to this <script> (a `let`, not `var`, so it never
    // became a `window` property on its own) — some pages reach for `window.socket`
    // directly for one-off emits/listeners beyond the wrapper functions below, so it's
    // exposed explicitly here.
    window.socket = socket;

    // Connection events
    socket.on('connect', () => {
        console.log('Connected to server:', socket.id);
        // Trigger connected event for UI updates
        window.dispatchEvent(new CustomEvent('socketConnected'));
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        window.dispatchEvent(new CustomEvent('socketDisconnected'));
    });
    
    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        window.dispatchEvent(new CustomEvent('socketError', { detail: error }));
    });
    
    // Game state events
    socket.on('gameStateUpdate', (newGameState) => {
        console.log('Socket received gameStateUpdate:', newGameState);
        gameState = newGameState;
        window.dispatchEvent(new CustomEvent('gameStateChanged', {
            detail: gameState
        }));
    });
    
    socket.on('newBuzz', (buzz) => {
        console.log('Socket received newBuzz event:', buzz);
        window.dispatchEvent(new CustomEvent('newBuzzAlert', { detail: buzz }));
    });
    
    socket.on('buzzingEnabled', (data) => {
        window.dispatchEvent(new CustomEvent('buzzingEnabled', { detail: data }));
    });
    
    socket.on('buzzingDisabled', () => {
        window.dispatchEvent(new CustomEvent('buzzingDisabled'));
    });
    
    socket.on('buzzMarkedCorrect', (data) => {
        window.dispatchEvent(new CustomEvent('buzzMarkedCorrect', { detail: data }));
    });
    
    socket.on('buzzMarkedWrong', (data) => {
        window.dispatchEvent(new CustomEvent('buzzMarkedWrong', { detail: data }));
    });
    
    socket.on('newQuestion', () => {
        window.dispatchEvent(new CustomEvent('newQuestion'));
    });
    
    socket.on('gameReset', () => {
        window.dispatchEvent(new CustomEvent('gameReset'));
    });
    
    socket.on('jeopardyQuestionUpdate', (questionData) => {
        console.log('Socket received jeopardyQuestionUpdate:', questionData);
        window.dispatchEvent(new CustomEvent('jeopardyQuestionReceived', { detail: questionData }));
    });
    
    socket.on('clearJeopardyDisplay', () => {
        console.log('Socket received clearJeopardyDisplay event');
        window.dispatchEvent(new CustomEvent('clearJeopardyDisplayReceived'));
    });
    
    socket.on('teamScoreUpdated', (data) => {
        console.log('Socket received teamScoreUpdated event:', data);
        window.dispatchEvent(new CustomEvent('teamScoreUpdated', { detail: data }));
    });
    
    return socket;
}

// Get current game state (now from memory, updated via WebSocket)
function getGameState() {
    return gameState;
}

// Set game state (not needed with WebSocket - server manages state)
function setGameState(state) {
    console.warn('setGameState called - state is now managed by server');
    // This function is kept for compatibility but doesn't do anything
}

// Identify client type to server
function identifyClient(clientType) {
    if (socket && socket.connected) {
        socket.emit('identifyClient', clientType);
    }
}

// Register a new player
function registerPlayer(playerData) {
    return new Promise((resolve, reject) => {
        if (!socket || !socket.connected) {
            reject(new Error('Not connected to server'));
            return;
        }
        
        // Identify as player client
        identifyClient('player');
        
        socket.emit('registerPlayer', playerData);
        
        socket.once('registrationSuccess', (player) => {
            resolve(player);
        });
        
        socket.once('registrationError', (error) => {
            reject(new Error(error));
        });
    });
}

// Update player's presence
function updatePlayerPresence(playerId) {
    if (socket && socket.connected) {
        socket.emit('updatePresence', playerId);
    }
}

// Attempt to buzz in
function addBuzz(playerId, playerName, team) {
    return new Promise((resolve, reject) => {
        if (!socket || !socket.connected) {
            reject({ success: false, reason: 'no_connection', message: 'Not connected to server' });
            return;
        }
        
        socket.emit('attemptBuzz', { playerId, playerName, team });
        
        socket.once('buzzResult', (result) => {
            if (result.success) {
                resolve(result);
            } else {
                reject(result);
            }
        });
    });
}

// Host control functions
function setBuzzingEnabled(enabled, questionId = null) {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return;
    }
    
    if (enabled) {
        socket.emit('enableBuzzing', questionId);
    } else {
        socket.emit('disableBuzzing');
    }
}

function setBuzzWinner(buzzId) {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return false;
    }
    
    socket.emit('markBuzzCorrect', buzzId);
    return true;
}

function markBuzzWrong(buzzId) {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return false;
    }
    
    socket.emit('markBuzzWrong', buzzId);
    return true;
}

function dismissBuzz(buzzId) {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return false;
    }
    
    socket.emit('dismissBuzz', buzzId);
    return true;
}

function clearBuzzes() {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return;
    }
    
    socket.emit('clearBuzzes');
}

function newQuestion() {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return;
    }
    
    socket.emit('newQuestion');
}

function resetGame() {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return;
    }
    
    socket.emit('resetGame');
}

function resetTeamScores() {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return;
    }
    
    socket.emit('resetTeamScores');
}

function closeJeopardyModal() {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return;
    }
    
    socket.emit('closeJeopardyModal');
}

function clearHostJeopardyDisplay() {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return;
    }
    
    socket.emit('clearHostJeopardyDisplay');
}

function updateTeamScore(teamNumber, newScore) {
    if (!socket || !socket.connected) {
        console.error('Not connected to server');
        return;
    }
    
    socket.emit('updateTeamScore', { teamNumber, newScore });
}

// Get team members
function getTeamMembers(teamNumber) {
    return gameState.players.filter(p => p.team === teamNumber);
}

// Get recent buzzes for current question
function getCurrentQuestionBuzzes() {
    if (!gameState.currentQuestion) return [];
    
    return gameState.buzzes
        .filter(b => b.questionId === gameState.currentQuestion)
        .sort((a, b) => a.timestamp - b.timestamp);
}

// Get fastest buzz for current question
function getFastestBuzz() {
    const buzzes = getCurrentQuestionBuzzes();
    return buzzes.length > 0 ? buzzes[0] : null;
}

// Generate unique IDs (now handled by server, but kept for compatibility)
function generateQuestionId() {
    return 'question_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Utility functions for formatting
function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
}

function getTeamColor(teamNumber) {
    const colors = {
        1: '#ff6b6b',
        2: '#4ecdc4', 
        3: '#ffe66d',
        4: '#a8e6cf'
    };
    return colors[teamNumber] || '#666';
}

function getTeamName(teamNumber) {
    return `Team ${teamNumber}`;
}

// Connection status helpers
function isConnected() {
    return socket && socket.connected;
}

function getConnectionStatus() {
    if (!socket) return 'not_initialized';
    if (socket.connected) return 'connected';
    if (socket.disconnected) return 'disconnected';
    return 'connecting';
}

// Auto-initialize socket when script loads
if (typeof window !== 'undefined') {
    // Initialize socket connection
    initializeSocket();
    
    // Auto-reconnect on page visibility change
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && (!socket || !socket.connected)) {
            console.log('Page became visible, reconnecting...');
            initializeSocket();
        }
    });
    
    // Heartbeat to keep connection alive
    setInterval(() => {
        if (socket && socket.connected) {
            socket.emit('ping');
        }
    }, 30000); // Every 30 seconds
}

// Export for Node.js if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initializeSocket,
        getGameState,
        identifyClient,
        registerPlayer,
        updatePlayerPresence,
        addBuzz,
        setBuzzingEnabled,
        setBuzzWinner,
        markBuzzWrong,
        dismissBuzz,
        clearBuzzes,
        newQuestion,
        resetGame,
        resetTeamScores,
        closeJeopardyModal,
        clearHostJeopardyDisplay,
        updateTeamScore,
        getTeamMembers,
        getCurrentQuestionBuzzes,
        getFastestBuzz,
        generateQuestionId,
        formatTime,
        getTeamColor,
        getTeamName,
        isConnected,
        getConnectionStatus
    };
} 