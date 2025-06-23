const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { SteamIdler } = require('./steam-idler'); // Adjust path if needed
const qrcode = require('qrcode');

const app = express();
const PORT = 3001;
const USERS_DIR = path.join(__dirname, 'users');
const QR_DIR = path.join(__dirname, 'qr');

app.use(cors());
app.use(express.json());

if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR);
if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR);

// Store active idler instances and login sessions
const activeIdlers = {};
const loginSessions = {};

// Serve static files (for QR codes)
app.use('/qr', express.static(QR_DIR));

// Initialize login process
app.post('/login', async (req, res) => {
  console.log('⚠️ /login endpoint hit');
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const userDir = path.join(USERS_DIR, username);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir);

    // Create new SteamIdler instance
    const idler = new SteamIdler({
      accountName: username,
      dataDirectory: userDir,
      logLevel: 'info'
    });

    // Store the idler instance and status
    loginSessions[username] = {
      idler: idler,
      status: 'initializing',
      qrCode: null
    };

    // Event listeners
    idler.on('steamGuardQrCode', async (qrData) => {
      try {
        console.log(`QR Code received for ${username}`);
        
        const qrCodePath = path.join(QR_DIR, `${username}.png`);
        await qrcode.toFile(qrCodePath, qrData);
        
        loginSessions[username].status = 'qr_ready';
        loginSessions[username].qrCode = `/qr/${username}.png`;
        
        console.log(`QR code saved for ${username}`);
      } catch (error) {
        console.error('Error generating QR code:', error);
        loginSessions[username].status = 'error';
        loginSessions[username].error = 'Failed to generate QR code';
      }
    });

    idler.on('loggedOn', () => {
      console.log(`${username} logged in successfully`);
      loginSessions[username].status = 'logged_in';
      
      // Move to active idlers and remove from loginSessions
      activeIdlers[username] = loginSessions[username].idler;
      delete loginSessions[username];
    });

    idler.on('error', (error) => {
      console.error(`Error for ${username}:`, error);
      if (loginSessions[username]) {
        loginSessions[username].status = 'error';
        loginSessions[username].error = error.message;
      }
    });

    idler.on('disconnected', () => {
      console.log(`${username} disconnected`);
      delete activeIdlers[username];
      if (loginSessions[username]) {
        delete loginSessions[username];
      }
    });

    // Start login process
    await idler.login();

    res.json({
      message: 'Login process started',
      username: username
    });

  } catch (error) {
    console.error('Login initialization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get login status
app.get('/login-status/:username', (req, res) => {
  const username = req.params.username;

  if (activeIdlers[username]) {
    return res.json({
      status: 'logged_in',
      username: username
    });
  }

  if (loginSessions[username]) {
    const session = loginSessions[username];
    return res.json({
      status: session.status,
      username: username,
      qrCode: session.qrCode,
      error: session.error
    });
  }

  res.json({
    status: 'not_found',
    username: username
  });
});

// Start idling games (single endpoint, per user)
app.post('/start-idle', async (req, res) => {
  const { username, appIds } = req.body;

  if (!username || !appIds || !Array.isArray(appIds) || appIds.length === 0) {
    return res.status(400).json({ error: 'Username and appIds array are required' });
  }

  const idler = activeIdlers[username];
  if (!idler) {
    return res.status(400).json({ error: 'User not logged in' });
  }

  try {
    // Convert string IDs to numbers
    const gameIds = appIds.map(id => parseInt(id.toString().trim())).filter(id => !isNaN(id));
    
    if (gameIds.length === 0) {
      return res.status(400).json({ error: 'No valid app IDs provided' });
    }

    await idler.startIdle(gameIds);

    res.json({
      message: `Started idling ${gameIds.length} games for ${username}`,
      appIds: gameIds
    });

  } catch (error) {
    console.error('Start idle error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stop idling
app.post('/stop-idle', async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const idler = activeIdlers[username];
  if (!idler) {
    return res.status(400).json({ error: 'User not logged in' });
  }

  try {
    await idler.stopIdle();
    res.json({ message: `Stopped idling for ${username}` });
  } catch (error) {
    console.error('Stop idle error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get idling status
app.get('/idle-status/:username', (req, res) => {
  const username = req.params.username;
  const idler = activeIdlers[username];

  if (!idler) {
    return res.json({
      username: username,
      loggedIn: false,
      idling: false
    });
  }

  res.json({
    username: username,
    loggedIn: true,
    idling: idler.isIdling || false,
    currentGames: idler.currentlyIdling || []
  });
});

// Logout user
app.post('/logout', async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    // Clean up login session
    if (loginSessions[username]) {
      if (loginSessions[username].idler) {
        try {
          await loginSessions[username].idler.logout();
        } catch (err) {
          console.error('Error logging out from session:', err);
        }
      }
      delete loginSessions[username];
    }

    // Clean up active idler
    if (activeIdlers[username]) {
      try {
        await activeIdlers[username].logout();
      } catch (err) {
        console.error('Error logging out active idler:', err);
      }
      delete activeIdlers[username];
    }

    // Clean up QR code file
    const qrPath = path.join(QR_DIR, `${username}.png`);
    if (fs.existsSync(qrPath)) {
      try {
        fs.unlinkSync(qrPath);
      } catch (err) {
        console.error('Error deleting QR file:', err);
      }
    }

    res.json({ message: `Logged out ${username}` });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeUsers: Object.keys(activeIdlers).length,
    loginSessions: Object.keys(loginSessions).length
  });
});

app.listen(PORT, () => {
  console.log(`Steam Idler API running at http://localhost:${PORT}`);
  console.log('Make sure your steam-idler folder exists in the same directory as this file');
  console.log('Install dependencies: npm install express cors qrcode');
});
