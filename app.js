// server.js
const express = require('express');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { Pool } = require('pg');
const http = require('http');
const cors = require('cors');

// === CONFIG ===
const REGION = 'us-east-2';
const USER_POOL_ID = 'us-east-2_WSq529He2';
const PORT = 3000;
const HOST = '0.0.0.0';

// === DB SETUP ===
const db = new Pool({
  user: 'postgres',
  host: 'database-trigpeer.cb4oygik2vf0.us-east-2.rds.amazonaws.com',
  database: 'database-trigpeer',
  password: 'Gbrar18129!',
  port: 5432,
  connectionTimeoutMillis: 5000, // 5 seconds
  idleTimeoutMillis: 30000, // 30 seconds
  max: 20, // maximum number of clients in the pool
  ssl: {
    rejectUnauthorized: false // Required for AWS RDS
  }
});

// Add better error handling for database connection
db.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Test database connection with retry
async function testDatabaseConnection(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await db.query('SELECT NOW()');
      console.log('Database connected successfully');
      return true;
    } catch (err) {
      console.error(`Database connection attempt ${i + 1} failed:`, err);
      if (i === retries - 1) {
        console.error('All database connection attempts failed');
        return false;
      }
      // Wait for 2 seconds before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  return false;
}

// Call the test function
testDatabaseConnection();

// === EXPRESS SERVER ===
const app = express();
const server = http.createServer(app);

// Add CORS middleware BEFORE any routes or WebSocket setup
app.use(cors());

// === JWKS CLIENT FOR COGNITO JWT ===
const client = jwksClient({
  jwksUri: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

// === WebSocket Setup ===
const wss = new WebSocketServer({ 
  server,
  path: '/ws',
  clientTracking: true,
  perMessageDeflate: false
});

const connections = new Map(); // Map of sub -> ws

// Function to broadcast online count to all clients
async function broadcastOnlineCount() {
  try {
    const result = await db.query(`SELECT COUNT(*) FROM users WHERE is_online = true`);
    const count = parseInt(result.rows[0].count);
    console.log('Broadcasting online count:', count);
    
    const message = JSON.stringify({
      type: 'onlineCount',
      count: count
    });

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (error) {
    console.error('Error broadcasting online count:', error);
  }
}

// === On WebSocket Connect ===
wss.on('connection', async function connection(ws, req) {
  console.log('New WebSocket connection attempt from:', req.socket.remoteAddress);
  
  try {
    // Parse URL to get token
    const url = new URL(req.url, `ws://${req.headers.host}`);
    const token = url.searchParams.get('token');
    
    if (!token) {
      console.log('No token provided');
      ws.close(1008, 'Token required');
      return;
    }

    // Verify token
    jwt.verify(token, getKey, {}, async (err, decoded) => {
      if (err) {
        console.error('Token verification failed:', err);
        ws.close(1008, 'Invalid token');
        return;
      }

      console.log('Token verified successfully. Full decoded token:', decoded);
      
      // Extract user data with fallbacks
      const sub = decoded.sub;
      const email = decoded.email || decoded['cognito:username'] || 'unknown@email.com';
      const name = decoded.name || decoded['cognito:username'] || 'Unknown User';
      
      console.log('Extracted user data:', { sub, email, name });
      
      connections.set(sub, ws);

      // Mark user online in DB
      try {
        console.log('Attempting to update user status in database:', { sub, email, name });
        
        const query = `
          INSERT INTO users (cognito_sub, email, name, is_online, last_active)
          VALUES ($1, $2, $3, true, NOW())
          ON CONFLICT (cognito_sub)
          DO UPDATE SET 
            is_online = true, 
            last_active = NOW(),
            email = COALESCE($2, users.email),
            name = COALESCE($3, users.name)
          RETURNING *
        `;
        
        const result = await db.query(query, [sub, email, name]);
        console.log('Database update result:', result.rows[0]);
        
        // Broadcast updated count after user connects
        await broadcastOnlineCount();
      } catch (dbError) {
        console.error('Database error:', dbError);
        console.error('Error details:', {
          message: dbError.message,
          code: dbError.code,
          detail: dbError.detail,
          hint: dbError.hint,
          position: dbError.position,
          where: dbError.where
        });
      }

      ws.on('close', async () => {
        connections.delete(sub);
        try {
          console.log('User disconnecting, updating database:', sub);
          const result = await db.query(
            `UPDATE users SET is_online = false WHERE cognito_sub = $1 RETURNING *`,
            [sub]
          );
          console.log('Disconnect update result:', result.rows[0]);
          
          // Broadcast updated count after user disconnects
          await broadcastOnlineCount();
        } catch (dbError) {
          console.error('Database error on disconnect:', dbError);
          console.error('Error details:', {
            message: dbError.message,
            code: dbError.code,
            detail: dbError.detail
          });
        }
      });
    });
  } catch (error) {
    console.error('Connection error:', error);
    ws.close(1011, 'Internal server error');
  }
});

// Add a test endpoint to verify server is running
app.get('/', (req, res) => {
  res.send('WebSocket server is running');
});

// === REST ROUTE to get online count ===
app.get('/online-count', async (req, res) => {
  try {
    const result = await db.query(`SELECT COUNT(*) FROM users WHERE is_online = true`);
    res.send({ onlineUsers: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error('Error getting online count:', error);
    res.status(500).send({ error: 'Failed to get online count' });
  }
});

// Start the server
server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket server running on ws://${HOST}:${PORT}/ws`);
});