const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'database-trigpeer.cb4oygik2vf0.us-east-2.rds.amazonaws.com',
  database: 'postgres',
  password: 'Gbrar18129!',
  port: 5432,
  ssl: {
    rejectUnauthorized: false
  }
});

async function testConnection() {
  try {
    console.log('Attempting to connect to database...');
    const client = await pool.connect();
    console.log('Connected successfully!');
    const result = await client.query('SELECT NOW()');
    console.log('Query result:', result.rows[0]);
    client.release();
  } catch (err) {
    console.error('Connection error:', err);
  } finally {
    pool.end();
  }
}

testConnection();