const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const helmet = require('helmet'); // For security

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Set up middleware
app.use(helmet({
  contentSecurityPolicy: false, // Adjust as needed
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Configure CORS - be explicit about allowed origins in production
app.use(cors({
  origin: function(origin, callback) {
    // In production, replace with your actual allowed domains
    const allowedOrigins = [
      'https://faraz6188.github.io',
      'http://localhost:3000',
      'http://localhost:8000'
    ];
    
    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      // Allow anyway in development, but log the blocked origin
      callback(null, true);
      
      // In production, use this to block unauthorized origins:
      // callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

// Increase JSON payload size limit for tracking data
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Create and initialize the database with improved schema
const db = new sqlite3.Database('./analytics.db', (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    
    // Create visits table with additional fields
    db.run(`CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      url TEXT,
      path TEXT,
      referrer TEXT,
      user_agent TEXT,
      screen_width INTEGER,
      screen_height INTEGER,
      ip_address TEXT,
      country TEXT,
      event_type TEXT DEFAULT 'page_view',
      duration INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      processed INTEGER DEFAULT 0
    )`, (err) => {
      if (err) {
        console.error('Error creating table:', err.message);
      } else {
        console.log('Visits table ready');
        
        // Create index on visitor_id for faster queries
        db.run('CREATE INDEX IF NOT EXISTS idx_visitor_id ON visits (visitor_id)');
      }
    });
  }
});

// Middleware for logging requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url} - ${req.ip}`);
  next();
});

// Helper function to safely insert data
function safeInsertVisit(data, response) {
  // Validate required fields
  if (!data.visitor_id || !data.timestamp) {
    console.error('Missing required fields in visit data');
    if (response) response.status(400).json({ error: 'Missing required fields' });
    return;
  }
  
  // Prepare query with all possible fields
  const sql = `INSERT INTO visits 
    (visitor_id, timestamp, url, path, referrer, user_agent, screen_width, screen_height, ip_address, event_type, duration) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  
  db.run(sql, [
    data.visitor_id,
    data.timestamp,
    data.url || '',
    data.path || '',
    data.referrer || '',
    data.user_agent || '',
    data.screen_width || 0,
    data.screen_height || 0,
    data.ip_address || '',
    data.event_type || 'page_view',
    data.duration || 0
  ], function(err) {
    if (err) {
      console.error('Error saving visit:', err.message);
      if (response) response.status(500).json({ error: 'Failed to save visit data' });
      return;
    }
    
    console.log(`Visit recorded with ID: ${this.lastID}`);
    if (response) response.status(200).json({ success: true, id: this.lastID });
  });
}

// Regular API endpoint for POST data
app.post('/api/track', (req, res) => {
  try {
    const visitData = req.body;
    
    // Add IP address from various possible headers
    visitData.ip_address = 
      req.headers['x-forwarded-for']?.split(',')[0] || 
      req.headers['x-real-ip'] || 
      req.connection.remoteAddress || 
      req.ip;
    
    // Insert into database
    safeInsertVisit(visitData, res);
  } catch (e) {
    console.error('Error in track endpoint:', e);
    res.status(500).json({ error: 'Server error processing request' });
  }
});

// Pixel tracking endpoint for GET requests
app.get('/api/track-pixel', (req, res) => {
  try {
    // Try to parse the data parameter
    let visitData;
    try {
      visitData = JSON.parse(decodeURIComponent(req.query.data || '{}'));
    } catch (parseError) {
      visitData = req.query;
      console.warn('Could not parse tracking data, using raw query params');
    }
    
    // Add IP address
    visitData.ip_address = 
      req.headers['x-forwarded-for']?.split(',')[0] || 
      req.headers['x-real-ip'] || 
      req.connection.remoteAddress || 
      req.ip;
    
    // Insert into database - don't pass response as we want to send image regardless
    safeInsertVisit(visitData);
    
    // Send a 1x1 transparent GIF
    res.set({
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  } catch (e) {
    console.error('Error in pixel tracking:', e);
    // Still return the image to avoid errors
    res.set('Content-Type', 'image/gif');
    res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  }
});

// Special endpoint for iOS devices
app.get('/api/ios-track', (req, res) => {
  try {
    // Extract simple parameters with fallbacks
    const visitData = {
      visitor_id: req.query.vid || 'ios-unknown',
      timestamp: new Date().toISOString(),
      url: decodeURIComponent(req.query.url || ''),
      path: '',
      referrer: req.headers.referer || '',
      user_agent: req.headers['user-agent'] || '',
      screen_width: parseInt(req.query.w) || 0,
      screen_height: parseInt(req.query.h) || 0,
      ip_address: req.headers['x-forwarded-for']?.split(',')[0] || 
                  req.headers['x-real-ip'] || 
                  req.connection.remoteAddress || 
                  req.ip,
      event_type: 'ios_visit'
    };
    
    // Insert into database
    safeInsertVisit(visitData);
    
    // Send no-cache headers with the GIF
    res.set({
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  } catch (e) {
    console.error('iOS tracking error:', e);
    res.set('Content-Type', 'image/gif');
    res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API endpoint to get analytics data with basic auth
app.get('/api/analytics', (req, res) => {
  // Simple authentication - in production use proper auth middleware
  const authHeader = req.headers.authorization;
  
  if (!authHeader || authHeader !== 'Bearer your-secret-token') {
    // Uncomment in production:
    // return res.status(401).json({ error: 'Unauthorized' });
    console.warn('Unauthenticated analytics access');
  }
  
  db.all('SELECT * FROM visits ORDER BY timestamp DESC LIMIT 1000', [], (err, rows) => {
    if (err) {
      console.error('Error fetching visits:', err.message);
      return res.status(500).json({ error: 'Failed to fetch analytics data' });
    }
    
    res.json(rows);
  });
});

// Dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Catch-all route for 404s
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error', message: err.message });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Analytics server running on port ${PORT}`);
  console.log(`Server URL: http://localhost:${PORT}`);
});