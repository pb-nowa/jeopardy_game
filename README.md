# 🎯 Jeopardy Buzzer System with WebSocket

A real-time multi-device Jeopardy buzzer system with WebSocket support for seamless network-based gameplay.

## 🚀 Quick Start

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

- `GET /api/gamestate` - Current game state (JSON)
- `GET /api/stats` - Game statistics and server uptime
- All real-time communication via WebSocket events

## 🔧 Configuration

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
├── jeopardy.html      # Original game board
└── package.json       # Node.js dependencies
```

Enjoy your real-time Jeopardy buzzer experience! 🎉 