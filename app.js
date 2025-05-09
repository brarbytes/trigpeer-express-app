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
const wss = new WebSocketServer({ server });
const connections = new Map(); // Map of sub -> ws

// === On WebSocket Connect ===
wss.on('connection', async function connection(ws, req) {
  const token = req.url.split('token=')[1];
  if (!token) {
    ws.close();
    return;
  }

  jwt.verify(token, getKey, {}, async (err, decoded) => {
    if (err) {
      ws.close();
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
});

// === REST ROUTE to get online count ===
app.get('/online-count', async (req, res) => {
  const result = await db.query(`SELECT COUNT(*) FROM users WHERE is_online = true`);
  res.send({ onlineUsers: parseInt(result.rows[0].count) });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});