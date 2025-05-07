const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const helmet = require('helmet');
const fs = require('fs');
const morgan = require('morgan');

const app = express();
const PORT = 1000;

// Middleware setup
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Determine the database directory
let dbDir;
try {
  if (process.env.RENDER && fs.existsSync('/data')) {
    dbDir = '/data';
    console.log('Using /data directory for database storage');
  } else {
    dbDir = '.';
    console.log('Using local directory for database storage');
  }
} catch (e) {
  console.error('Error determining database directory:', e);
  dbDir = '.';
}

// Create public directory if it doesn't exist
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
  
  // Create default index.html
  fs.writeFileSync(path.join(publicDir, 'index.html'), `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Analytics Server</title>
    </head>
    <body>
      <h1>Analytics Server</h1>
      <p>The analytics server is running.</p>
      <p><a href="/dashboard">View Dashboard</a></p>
    </body>
    </html>
  `);
  
  // Copy dashboard.html if exists
  if (fs.existsSync('./dashboard.html')) {
    fs.copyFileSync('./dashboard.html', path.join(publicDir, 'dashboard.html'));
  }
}

// Enhanced CORS configuration
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (process.env.NODE_ENV !== 'production') return callback(null, true);
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Preflight handling
app.options('*', cors());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url} from ${req.ip}`);
  next();
});

// Serve static files
app.use(express.static(publicDir));
function setupDurationTracking() {
  setInterval(() => {
    const sessionStart = parseInt(sessionStorage.getItem('session_start') || '0');
    if (!sessionStart) return;
    
    const duration = Math.floor((Date.now() - sessionStart) / 1000);
    const visitorId = getVisitorId();
    
    fetch('http://localhost:1000/api/update-duration', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        visitor_id: visitorId,
        duration: duration
      })
    }).catch(error => {
      console.log('Duration update failed:', error);
    });
  }, 30000); // Every 30 seconds
}
// Database setup
const dbPath = path.join(dbDir, 'analytics.db');
console.log(`Database will be stored at: ${path.resolve(dbPath)}`);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
    console.log('Will continue without database persistence');
  } else {
    console.log(`Connected to SQLite database at ${dbPath}`);
  }

  // Create visits table with enhanced schema
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
    device_type TEXT,
    language TEXT,
    event_type TEXT DEFAULT 'page_view',
    duration INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    processed INTEGER DEFAULT 0
  )`, (err) => {
    if (!err) {
      console.log('Visits table ready');
      // Create indexes
      db.run('CREATE INDEX IF NOT EXISTS idx_visitor_id ON visits (visitor_id)');
      db.run('CREATE INDEX IF NOT EXISTS idx_timestamp ON visits (timestamp)');
      db.run('CREATE INDEX IF NOT EXISTS idx_device_type ON visits (device_type)');
    } else {
      console.error('Table creation error:', err.message);
    }
  });
});

// Device detection helper
function detectDeviceType(userAgent) {
  if (!userAgent) return 'Unknown';
  
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) {
    return 'Mobile';
  } else if (/Macintosh|MacIntel/i.test(userAgent)) {
    return 'Desktop';
  } else if (/Windows NT/i.test(userAgent)) {
    return 'Desktop';
  } else if (/Linux/i.test(userAgent)) {
    return 'Desktop';
  } else if (/Chromebook/i.test(userAgent)) {
    return 'Laptop';
  } else {
    return 'Unknown';
  }
}

// Session duration update
function updateSessionDuration(visitorId, duration, response) {
  if (!visitorId) {
    if (response) response.status(400).json({ error: 'Missing visitor ID' });
    return;
  }
  
  db.run(
    `UPDATE visits 
     SET duration = ? 
     WHERE id = (
       SELECT id 
       FROM visits 
       WHERE visitor_id = ? 
       AND event_type = 'page_view' 
       ORDER BY timestamp DESC 
       LIMIT 1
     )`,
    [duration, visitorId],
    function(err) {
      if (err) {
        console.error('Error updating duration:', err);
        if (response) response.status(500).json({ error: 'Failed to update duration' });
        return;
      }
      
      console.log(`Updated duration for visitor ${visitorId}: ${duration} seconds`);
      if (response) response.status(200).json({ success: true, updated: this.changes > 0 });
    }
  );
}

// In the /api/update-duration endpoint
app.post('/api/update-duration', (req, res) => {
  try {
    const { visitor_id, duration } = req.body;
    
    if (!visitor_id || duration === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    db.run(
      `UPDATE visits 
       SET duration = ? 
       WHERE id = (
         SELECT id 
         FROM visits 
         WHERE visitor_id = ? 
         AND event_type = 'page_view' 
         ORDER BY timestamp DESC 
         LIMIT 1
       )`,
      [duration, visitor_id],
      function(err) {
        if (err) {
          console.error('Error updating duration:', err);
          return res.status(500).json({ error: 'Failed to update duration' });
        }
        
        console.log(`Updated duration for visitor ${visitor_id}: ${duration} seconds`);
        res.status(200).json({ 
          success: true, 
          updated: this.changes > 0 
        });
      }
    );
  } catch (e) {
    console.error('Error in /api/update-duration:', e);
    res.status(500).json({ error: 'Server error processing request' });
  }
});

// Safe visit insertion
function safeInsertVisit(data, req, response) {
  if (!data.visitor_id || !data.timestamp) {
    console.error('Missing required fields in visit data:', data);
    if (response) response.status(400).json({ error: 'Missing required fields' });
    return;
  }
  
  const deviceType = detectDeviceType(data.user_agent);
  const language = req?.headers['accept-language']?.split(',')[0] || data.language || 'Unknown';
  let eventType = data.event_type || 'page_view';
  let duration = data.duration || 0;
  
  if (eventType === 'session_duration') {
    updateSessionDuration(data.visitor_id, duration, response);
    return;
  }
  
  const sql = `INSERT INTO visits 
    (visitor_id, timestamp, url, path, referrer, user_agent, screen_width, screen_height, 
     ip_address, device_type, language, event_type, duration) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  
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
    deviceType,
    language,
    eventType,
    duration
  ], function (err) {
    if (err) {
      console.error('Error saving visit:', err.message);
      if (response) response.status(500).json({ error: 'Failed to save visit data' });
      return;
    }
    console.log(`Visit recorded (ID: ${this.lastID})`);
    if (response) response.status(200).json({ success: true, id: this.lastID });
  });
}

// API Endpoints

// Test endpoint
app.get('/api/test-db', (req, res) => {
  db.all('SELECT name FROM sqlite_master WHERE type="table"', [], (err, tables) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database error', details: err.message });
    }
    res.json({ tables: tables.map(t => t.name), dbPath });
  });
});

// Tracking endpoint
app.post('/api/track', (req, res) => {
  try {
    const visitData = req.body;
    
    visitData.ip_address = req.headers['x-forwarded-for']?.split(',')[0] ||
                       req.headers['x-real-ip'] ||
                       req.connection.remoteAddress ||
                       req.ip;
    
    if (visitData.event_type === 'session_duration') {
      updateSessionDuration(visitData.visitor_id, visitData.duration, res);
    } else {
      safeInsertVisit(visitData, req, res);
    }
  } catch (e) {
    console.error('Error in /api/track POST:', e);
    res.status(500).json({ error: 'Server error processing request' });
  }
});

// Pixel tracking endpoint
app.get('/api/track-pixel', (req, res) => {
  let visitData;
  try {
    visitData = JSON.parse(decodeURIComponent(req.query.data || '{}'));
  } catch (e) {
    visitData = req.query;
    console.warn('Failed to parse tracking data in pixel endpoint; using raw query params');
  }
  
  visitData.ip_address = req.headers['x-forwarded-for']?.split(',')[0] ||
                     req.headers['x-real-ip'] ||
                     req.connection.remoteAddress ||
                     req.ip;
  
  if (visitData.event_type === 'session_duration') {
    updateSessionDuration(visitData.visitor_id, visitData.duration);
  } else {
    safeInsertVisit(visitData, req);
  }
  
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  }).send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

// Analytics data endpoint for dashboard
app.get('/api/analytics/visits', (req, res) => {
  db.all(`
    SELECT 
      id, 
      visitor_id, 
      timestamp, 
      url, 
      path, 
      referrer, 
      device_type as device, 
      screen_width, 
      screen_height, 
      duration, 
      event_type,
      ip_address,
      language
    FROM visits 
    ORDER BY timestamp DESC
    LIMIT 1000
  `, [], (err, rows) => {
    if (err) {
      console.error('Error fetching visits data:', err.message);
      return res.status(500).json({ 
        error: 'Database error',
        details: err.message 
      });
    }
    
    console.log(`Returning ${rows.length} visits`);
    res.json(rows);
  });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  db.all(`
    SELECT 
      COUNT(*) as total_visits,
      COUNT(DISTINCT visitor_id) as unique_visitors,
      AVG(duration) as avg_duration,
      SUM(CASE WHEN device_type = 'Mobile' THEN 1 ELSE 0 END) as mobile_visits,
      SUM(CASE WHEN device_type = 'Desktop' THEN 1 ELSE 0 END) as desktop_visits
    FROM visits
  `, [], (err, rows) => {
    if (err) {
      console.error('Error fetching stats:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    
    res.json(rows[0]);
  });
});

// Status endpoint
app.get('/api/status', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM visits', (err, row) => {
    res.json({
      status: 'ok',
      visitsCount: row ? row.count : 0,
      dbPath,
      uptime: process.uptime()
    });
  });
});

// Backup endpoint
app.get('/api/backup', (req, res) => {
  const backupPath = path.join(dbDir, `analytics-backup-${Date.now()}.db`);
  try {
    fs.copyFileSync(dbPath, backupPath);
    res.json({ success: true, backupPath });
  } catch (e) {
    console.error('Backup failed:', e);
    res.status(500).json({ error: 'Backup failed', details: e.message });
  }
});

// Dashboard route
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Analytics server running on port ${PORT}`);
});

// Add this to your server code
app.get('/api/test-db', (req, res) => {
  db.get('SELECT sqlite_version() AS version', async (err, row) => {
    if (err) return res.status(500).json({error: err.message});
    res.json({
      status: 'connected',
      version: row.version,
      tables: await new Promise(resolve => {
        db.all("SELECT name FROM sqlite_master WHERE type='table'", [], (err, tables) => {
          resolve(tables.map(t => t.name));
        });
      })
    });
  });
});
// Add this with your other API endpoints
app.post('/api/update-duration', (req, res) => {
  try {
    const { visitor_id, duration } = req.body;
    
    if (!visitor_id || duration === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Update the most recent visit for this visitor
    db.run(
      `UPDATE visits 
       SET duration = ? 
       WHERE visitor_id = ? 
       ORDER BY timestamp DESC 
       LIMIT 1`,
      [duration, visitor_id],
      function(err) {
        if (err) {
          console.error('Error updating duration:', err);
          return res.status(500).json({ error: 'Failed to update duration' });
        }
        
        console.log(`Updated duration for visitor ${visitor_id}: ${duration} seconds`);
        res.status(200).json({ 
          success: true, 
          updated: this.changes > 0 
        });
      }
    );
  } catch (e) {
    console.error('Error in /api/update-duration:', e);
    res.status(500).json({ error: 'Server error processing request' });
  }
});