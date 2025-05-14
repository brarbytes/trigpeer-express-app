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
  database: 'postgres',
  password: 'Gbrar18129!',
  port: 5432,
  connectionTimeoutMillis: 30000, // Increased to 30 seconds
  idleTimeoutMillis: 60000, // Increased to 60 seconds
  max: 20,
  ssl: {
    rejectUnauthorized: false
  },
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  application_name: 'trigpeer-express-app',
  statement_timeout: 30000, // 30 seconds
  query_timeout: 30000 // 30 seconds
});

// Add better error handling for database connection
db.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Test database connection with retry and more detailed error logging
async function testDatabaseConnection(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`Attempting database connection ${i + 1}/${retries}...`);
      const result = await db.query('SELECT NOW()');
      console.log('Database connected successfully');
      return true;
    } catch (err) {
      console.error(`Database connection attempt ${i + 1} failed:`, err);
      console.error('Connection details:', {
        host: db.options.host,
        port: db.options.port,
        database: db.options.database,
        user: db.options.user,
        ssl: db.options.ssl ? 'enabled' : 'disabled'
      });
      
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
      if (client.readyState === 1) { // 1 is OPEN state
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
  
  // Store the sub outside the try block so it's accessible in the close handler
  let userSub = null;
  
  // Set up close handler immediately
  ws.on('close', async () => {
    if (userSub) {
      connections.delete(userSub);
      try {
        console.log('User disconnecting, updating database:', userSub);
        const result = await db.query(
          `UPDATE users SET is_online = false WHERE cognito_sub = $1 RETURNING *`,
          [userSub]
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
    }
  });
  
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
      userSub = sub; // Store the sub for the close handler
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

// === Question Endpoints ===
app.post('/questions', async (req, res) => {
  try {
    const { question_text } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Verify token and get user info
    jwt.verify(token, getKey, {}, async (err, decoded) => {
      if (err) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const userSub = decoded.sub;
      
      // Insert question
      const result = await db.query(
        `INSERT INTO questions (user_sub, question_text)
         VALUES ($1, $2)
         RETURNING *`,
        [userSub, question_text]
      );

      // Broadcast new question to all connected clients
      const question = result.rows[0];
      const message = JSON.stringify({
        type: 'newQuestion',
        question: {
          ...question,
          user: {
            name: decoded.name || decoded['cognito:username'],
            email: decoded.email
          }
        }
      });

      wss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(message);
        }
      });

      res.json(result.rows[0]);
    });
  } catch (error) {
    console.error('Error submitting question:', error);
    res.status(500).json({ error: 'Failed to submit question' });
  }
});

app.get('/questions', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT q.*, u.name as user_name, u.email as user_email,
             a.name as answerer_name
      FROM questions q
      LEFT JOIN users u ON q.user_sub = u.cognito_sub
      LEFT JOIN users a ON q.answered_by = a.cognito_sub
      ORDER BY q.created_at DESC
      LIMIT 50
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
});

app.post('/questions/:id/answer', async (req, res) => {
  try {
    const { id } = req.params;
    const { answer_text } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    jwt.verify(token, getKey, {}, async (err, decoded) => {
      if (err) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const answererSub = decoded.sub;
      
      const result = await db.query(
        `UPDATE questions 
         SET answered_by = $1, 
             answer_text = $2, 
             answered_at = CURRENT_TIMESTAMP,
             status = 'answered'
         WHERE id = $3
         RETURNING *`,
        [answererSub, answer_text, id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Question not found' });
      }

      // Broadcast answer to all connected clients
      const question = result.rows[0];
      const message = JSON.stringify({
        type: 'questionAnswered',
        question: {
          ...question,
          answerer: {
            name: decoded.name || decoded['cognito:username'],
            email: decoded.email
          }
        }
      });

      wss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(message);
        }
      });

      res.json(result.rows[0]);
    });
  } catch (error) {
    console.error('Error submitting answer:', error);
    res.status(500).json({ error: 'Failed to submit answer' });
  }
});

// Start the server
server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket server running on ws://${HOST}:${PORT}/ws`);
});

// Add this after your WebSocket server setup
// Periodic cleanup of stale connections
setInterval(async () => {
  try {
    // Update any users who haven't been active in the last 5 minutes
    const result = await db.query(`
      UPDATE users 
      SET is_online = false 
      WHERE is_online = true 
      AND last_active < NOW() - INTERVAL '5 minutes'
      RETURNING *
    `);
    
    if (result.rows.length > 0) {
      console.log('Cleaned up stale connections:', result.rows.length);
      await broadcastOnlineCount();
    }
  } catch (error) {
    console.error('Error cleaning up stale connections:', error);
  }
}, 60000); // Run every minute