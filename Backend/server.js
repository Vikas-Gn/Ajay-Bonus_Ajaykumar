const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3062;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection configuration
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'admin123',
  database: process.env.DB_NAME || 'new_employee_db',
  port: process.env.DB_PORT || 5432
});

// Log connection parameters
console.log('Connecting to database with:', {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

// Handle unexpected database connection errors
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(1);
});

// Initialize database and table with retry logic
async function initializeDatabase() {
  const maxRetries = 5;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      const client = await pool.connect();
      console.log('Connected to PostgreSQL database');
      client.release();
      
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bonuses (
          bonus_id VARCHAR(10) PRIMARY KEY,
          employee_id VARCHAR(7) NOT NULL,
          employee_name VARCHAR(40) NOT NULL,
          employee_email VARCHAR(40) NOT NULL,
          bonus_type VARCHAR(20) NOT NULL CHECK (bonus_type IN ('Performance', 'Festival', 'Project Completion', 'Retention', 'Referral')),
          amount DECIMAL(10, 2) NOT NULL,
          month_year DATE NOT NULL,
          reason VARCHAR(200),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('Bonus table initialized');
      return;
    } catch (err) {
      retries++;
      console.error(`Database connection failed (attempt ${retries}/${maxRetries}):`, err);
      if (retries === maxRetries) {
        console.error('Max retries reached. Exiting...');
        process.exit(1);
      }
      await new Promise(res => setTimeout(res, 5000)); // wait 5 seconds
    }
  }
}

// Generate unique bonus ID
async function generateBonusId() {
  const { rows } = await pool.query('SELECT bonus_id FROM bonuses ORDER BY bonus_id DESC LIMIT 1');
  let newId = 'BON0001';
  if (rows.length > 0) {
    const lastId = rows[0].bonus_id;
    const num = parseInt(lastId.replace('BON', '')) + 1;
    newId = `BON${String(num).padStart(4, '0')}`;
  }
  return newId;
}

// Validate input data
function validateBonusData(data) {
  const errors = [];

  if (!/^ATS0[0-9]{3}$/.test(data.employee_id) || data.employee_id === 'ATS0000') {
    errors.push('Invalid employee ID (format: ATS0XXX)');
  }

  if (!/^[a-zA-Z]+(?:\s[a-zA-Z]+)*$/.test(data.employee_name) || data.employee_name.length < 3 || data.employee_name.length > 40) {
    errors.push('Invalid employee name (letters, spaces, 3-40 chars)');
  }

  if (!/^[a-zA-Z0-9._%+-]+@astrolitetech\.com$/i.test(data.employee_email)) {
    errors.push('Invalid email format (must be @astrolitetech.com)');
  }

  if (!['Performance', 'Festival', 'Project Completion', 'Retention', 'Referral'].includes(data.bonus_type)) {
    errors.push('Invalid bonus type');
  }

  if (isNaN(data.amount) || data.amount <= 0) {
    errors.push('Amount must be a positive number');
  }

  const date = new Date(data.month_year + ' 1');
  if (!data.month_year || isNaN(date)) {
    errors.push('Invalid month/year format (e.g., January 2025)');
  }

  if (data.reason && data.reason.length > 200) {
    errors.push('Reason must be 200 characters or less');
  }

  return errors;
}

// Create bonus endpoint
app.post('/api/bonus', async (req, res) => {
  try {
    const errors = validateBonusData(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join(', ') });
    }

    const bonusId = await generateBonusId();
    const { rows } = await pool.query(
      `INSERT INTO bonuses (
        bonus_id, employee_id, employee_name, employee_email,
        bonus_type, amount, month_year, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        bonusId,
        req.body.employee_id,
        req.body.employee_name,
        req.body.employee_email,
        req.body.bonus_type,
        req.body.amount,
        new Date(req.body.month_year + ' 1'),
        req.body.reason || null
      ]
    );

    res.status(201).json({
      message: 'Bonus created successfully',
      bonus: rows[0]
    });
  } catch (err) {
    console.error('Error creating bonus:', err);
    res.status(500).json({ error: `Failed to create bonus: ${err.message}` });
  }
});

// Get bonus history endpoint
app.get('/api/bonus/history', async (req, res) => {
  try {
    const { employee_id, month, year, end_month, end_year, search } = req.query;
    let query = 'SELECT bonus_id, employee_id, employee_name, employee_email, bonus_type, amount, TO_CHAR(month_year, \'Month YYYY\') AS month_year, reason, created_at FROM bonuses WHERE 1=1';
    const params = [];
    let paramCount = 1;

    if (employee_id) {
      query += ` AND employee_id = $${paramCount++}`;
      params.push(employee_id);
    }

    if (month && year) {
      query += ` AND EXTRACT(MONTH FROM month_year) >= $${paramCount++}`;
      query += ` AND EXTRACT(YEAR FROM month_year) >= $${paramCount++}`;
      params.push(parseInt(month), parseInt(year));
    }

    if (end_month && end_year) {
      query += ` AND EXTRACT(MONTH FROM month_year) <= $${paramCount++}`;
      query += ` AND EXTRACT(YEAR FROM month_year) <= $${paramCount++}`;
      params.push(parseInt(end_month), parseInt(end_year));
    } else if (year && !month) {
      query += ` AND EXTRACT(YEAR FROM month_year) = $${paramCount++}`;
      params.push(parseInt(year));
    }

    if (search) {
      query += ` AND (employee_id LIKE $${paramCount++} OR employee_name LIKE $${paramCount++})`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY created_at DESC';

    const { rows } = await pool.query(query, params);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Error fetching bonus history:', err);
    res.status(500).json({ error: `Failed to fetch bonus history: ${err.message}` });
  }
});

// Test DNS resolution endpoint
app.get('/test-dns', async (req, res) => {
  try {
    const dns = require('dns');
    dns.lookup('postgres', (err, address, family) => {
      if (err) {
        return res.status(500).json({ error: `DNS lookup failed: ${err.message}` });
      }
      res.json({ host: 'postgres', address, family });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

// Start server
app.listen(port, async () => {
  console.log(`Server starting on http://0.0.0.0:${port}`);
  await initializeDatabase();
  console.log(`Server running on http://0.0.0.0:${port}`);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  process.exit(1);
});
