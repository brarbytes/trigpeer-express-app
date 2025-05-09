// server.js
const express = require('express');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { Pool } = require('pg');
const http = require('http');

// === CONFIG ===
const REGION = 'us-east-2';
const USER_POOL_ID = 'us-east-2_WSq529He2';
const PORT = 3000;

// === DB SETUP ===
const db = new Pool({
  user: 'postgres',
  host: 'database-trigpeer.cb4oygik2vf0.us-east-2.rds.amazonaws.com',
  database: 'database-trigpeer',
  password: 'Gbrar18129!',
  port: 5432,
});

// === EXPRESS SERVER ===
const app = express();
const server = http.createServer(app);

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
  noServer: true // Important: Let Express handle the upgrade
});

const connections = new Map(); // Map of sub -> ws

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'ws://localhost').pathname;

  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// === On WebSocket Connect ===
wss.on('connection', async function connection(ws, req) {
  try {
    const url = new URL(req.url, 'ws://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(1008, 'Token required');
      return;
    }

    jwt.verify(token, getKey, {}, async (err, decoded) => {
      if (err) {
        console.error('Token verification failed:', err);
        ws.close(1008, 'Invalid token');
        return;
      }

      const { sub, email, name } = decoded;
      connections.set(sub, ws);

      // Mark user online in DB
      await db.query(`
        INSERT INTO users (cognito_sub, email, name, is_online, last_active)
        VALUES ($1, $2, $3, true, NOW())
        ON CONFLICT (cognito_sub)
        DO UPDATE SET is_online = true, last_active = NOW()
      `, [sub, email, name]);

      console.log(`${sub} connected`);

      ws.on('close', async () => {
        connections.delete(sub);
        await db.query(`UPDATE users SET is_online = false WHERE cognito_sub = $1`, [sub]);
        console.log(`${sub} disconnected`);
      });
    });
  } catch (error) {
    console.error('Connection error:', error);
    ws.close(1011, 'Internal server error');
  }
});

// === REST ROUTE to get online count ===
app.get('/online-count', async (req, res) => {
  const result = await db.query(`SELECT COUNT(*) FROM users WHERE is_online = true`);
  res.send({ onlineUsers: parseInt(result.rows[0].count) });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});