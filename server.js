const express = require('express');
const session = require('express-session');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const rootDir = __dirname;
const uploadsDir = path.join(rootDir, 'uploads');
const dbPath = path.join(rootDir, 'data.sqlite3');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function buildUsers() {
  const defaults = [
    { username: 'mira', password: 'orange-ombre-1' },
    { username: 'leo', password: 'navy-echo-2' }
  ];

  return [
    {
      username: process.env.SHARE_USER_1 || defaults[0].username,
      passwordHash: hashPassword(process.env.SHARE_PASS_1 || defaults[0].password)
    },
    {
      username: process.env.SHARE_USER_2 || defaults[1].username,
      passwordHash: hashPassword(process.env.SHARE_PASS_2 || defaults[1].password)
    }
  ];
}

const users = buildUsers();

function verifyCredentials(username, password) {
  const passwordHash = hashPassword(password);
  return users.find((user) => user.username === username && user.passwordHash === passwordHash) || null;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const safeName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}-${safeName}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image, video, and PDF files are allowed.'));
    }
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(rootDir, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'shared-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));

class LRUCache {
  constructor(limit = 8) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  values() {
    return Array.from(this.map.values());
  }
}

const recentFilesCache = new LRUCache(8);
const tagIndex = new Map();
const locationIndex = new Map();

function normalizeTags(rawTags) {
  return Array.from(new Set((rawTags || '')
    .split(',')
    .flatMap((tag) => tag.split(/\s+/))
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)));
}

function initializeDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          parent_id INTEGER,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `, (err) => {
        if (err) return reject(err);
      });
      db.run(`
        CREATE TABLE IF NOT EXISTS files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          original_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          folder_id INTEGER,
          stored_name TEXT NOT NULL,
          uploaded_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          location TEXT,
          tags TEXT
        )
      `, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
}

function addColumnsIfNeeded() {
  return new Promise((resolve) => {
    const statements = [
      ["ALTER TABLE files ADD COLUMN location TEXT", /duplicate column name/i],
      ["ALTER TABLE files ADD COLUMN tags TEXT", /duplicate column name/i]
    ];

    db.serialize(() => {
      let index = 0;
      function runNext() {
        if (index >= statements.length) return resolve();
        const [sql, pattern] = statements[index];
        index += 1;
        db.run(sql, (err) => {
          if (err && !pattern.test(err.message)) {
            console.error('Migration error', err.message);
          }
          runNext();
        });
      }
      runNext();
    });
  });
}

function listFolders(parentId) {
  return new Promise((resolve, reject) => {
    const query = parentId === null || parentId === undefined
      ? 'SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name ASC'
      : 'SELECT * FROM folders WHERE parent_id = ? ORDER BY name ASC';
    const params = parentId === null || parentId === undefined ? [] : [parentId];
    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function listFiles(folderId) {
  return new Promise((resolve, reject) => {
    const query = folderId === null || folderId === undefined
      ? 'SELECT * FROM files WHERE folder_id IS NULL ORDER BY created_at DESC'
      : 'SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC';
    const params = folderId === null || folderId === undefined ? [] : [folderId];
    db.all(query, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function listFilesByIds(ids) {
  return new Promise((resolve, reject) => {
    if (!ids.length) return resolve([]);
    const placeholders = ids.map(() => '?').join(', ');
    db.all(`SELECT * FROM files WHERE id IN (${placeholders}) ORDER BY created_at DESC`, ids, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function getFolder(folderId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM folders WHERE id = ?', [folderId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

async function getFolderPath(folderId) {
  if (!folderId) return [];
  const pathSegments = [];
  let currentId = folderId;
  while (currentId) {
    const folder = await getFolder(currentId);
    if (!folder) break;
    pathSegments.unshift(folder);
    currentId = folder.parent_id;
  }
  return pathSegments;
}

function getFile(fileId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM files WHERE id = ?', [fileId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function rebuildLookupIndexes() {
  return new Promise((resolve, reject) => {
    tagIndex.clear();
    locationIndex.clear();
    db.all('SELECT id, tags, location FROM files', (err, rows) => {
      if (err) return reject(err);
      rows.forEach((row) => {
        const tags = typeof row.tags === 'string' ? JSON.parse(row.tags || '[]') : [];
        tags.forEach((tag) => {
          const bucket = tagIndex.get(tag) || [];
          bucket.push(row.id);
          tagIndex.set(tag, bucket);
        });

        const location = (row.location || '').trim().toLowerCase();
        if (location) {
          const bucket = locationIndex.get(location) || [];
          bucket.push(row.id);
          locationIndex.set(location, bucket);
        }
      });
      resolve({ tagIndex, locationIndex });
    });
  });
}

function addToRecent(file) {
  recentFilesCache.set(file.id, file);
}

app.use((req, res, next) => {
  if (req.session.decoyActive && !['/decoy', '/login', '/logout', '/health'].includes(req.path)) {
    return res.redirect('/decoy');
  }
  next();
});

function requireAuth(req, res, next) {
  if (req.session.user) {
    return next();
  }

  req.session.bypassAttempt = true;
  req.session.decoyActive = true;
  return res.redirect('/decoy');
}

app.get('/health', (req, res) => {
  res.json({ ok: true, auth: 'active', users: users.map((user) => user.username) });
});

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  return res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const match = verifyCredentials(username, password);

  if (match) {
    req.session.user = { username: match.username };
    req.session.failedLogins = 0;
    req.session.decoyActive = false;
    return res.redirect('/dashboard');
  }

  req.session.failedLogins = (req.session.failedLogins || 0) + 1;
  if (req.session.failedLogins >= 3) {
    req.session.decoyActive = true;
    return res.redirect('/decoy');
  }

  return res.render('login', { error: 'Wrong credentials. Try again.' });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/decoy', (req, res) => {
  res.render('decoy');
});

app.get('/dashboard', requireAuth, async (req, res) => {
  const requestedFolder = req.query.folder ? Number(req.query.folder) : null;
  const folderId = Number.isNaN(requestedFolder) ? null : requestedFolder;
  const selectedTag = (req.query.tag || '').trim().toLowerCase();
  const selectedLocation = (req.query.location || '').trim().toLowerCase();
  const searchTerm = (req.query.q || '').trim().toLowerCase();

  try {
    const currentFolder = folderId ? await getFolder(folderId) : null;
    const folderPath = await getFolderPath(folderId);
    const folders = await listFolders(folderId);
    let files = await listFiles(folderId);

    if (selectedTag) {
      const ids = tagIndex.get(selectedTag) || [];
      const selectedIds = new Set(ids);
      files = files.filter((file) => selectedIds.has(file.id));
    }

    if (selectedLocation) {
      const ids = locationIndex.get(selectedLocation) || [];
      const selectedIds = new Set(ids);
      files = files.filter((file) => selectedIds.has(file.id));
    }

    if (searchTerm) {
      const terms = searchTerm.split(/\s+/).filter(Boolean);
      files = files.filter((file) => {
        const fileTags = typeof file.tags === 'string' ? JSON.parse(file.tags || '[]') : [];
        const haystack = [file.original_name, file.location || '', fileTags.join(' ')].join(' ').toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }

    const availableTags = Array.from(tagIndex.keys()).sort();
    const availableLocations = Array.from(locationIndex.keys()).sort();
    const recentFiles = recentFilesCache.values().slice().reverse();

    res.render('home', {
      user: req.session.user,
      folders,
      files,
      currentFolder,
      folderPath,
      folderId,
      selectedTag,
      selectedLocation,
      searchTerm,
      availableTags,
      availableLocations,
      recentFiles,
      error: null
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('Unable to load dashboard.');
  }
});

app.post('/folders', requireAuth, (req, res) => {
  const name = (req.body.name || '').trim();
  const parentId = req.body.parentFolder ? Number(req.body.parentFolder) : null;
  if (!name) {
    return res.redirect('/dashboard');
  }

  db.run(
    'INSERT INTO folders (name, parent_id, created_by, created_at) VALUES (?, ?, ?, ?)',
    [name, Number.isNaN(parentId) ? null : parentId, req.session.user.username, new Date().toISOString()],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Unable to create folder.');
      }
      return res.redirect('/dashboard' + (parentId ? `?folder=${parentId}` : ''));
    }
  );
});

app.post('/upload', requireAuth, (req, res) => {
  const folderId = req.body.folderId ? Number(req.body.folderId) : null;
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).send(err.message);
    }

    if (!req.file) {
      return res.redirect('/dashboard' + (folderId ? `?folder=${folderId}` : ''));
    }

    const storedName = path.basename(req.file.path);
    const location = (req.body.location || '').trim();
    const tags = JSON.stringify(normalizeTags(req.body.tags));

    db.run(
      'INSERT INTO files (name, original_name, mime_type, size, folder_id, stored_name, uploaded_by, created_at, location, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.file.originalname, req.file.originalname, req.file.mimetype, req.file.size, Number.isNaN(folderId) ? null : folderId, storedName, req.session.user.username, new Date().toISOString(), location || null, tags],
      (dbErr) => {
        if (dbErr) {
          console.error(dbErr);
          return res.status(500).send('Unable to save file.');
        }
        rebuildLookupIndexes().then(() => {
          return res.redirect('/dashboard' + (folderId ? `?folder=${folderId}` : ''));
        }).catch((indexErr) => {
          console.error(indexErr);
          return res.redirect('/dashboard' + (folderId ? `?folder=${folderId}` : ''));
        });
      }
    );
  });
});

app.get('/files/:id', requireAuth, async (req, res) => {
  try {
    const file = await getFile(Number(req.params.id));
    if (!file) {
      return res.status(404).send('File not found.');
    }
    const filePath = path.join(uploadsDir, file.stored_name);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File missing from storage.');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypeMap = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.pdf': 'application/pdf'
    };

    res.set('Content-Type', contentTypeMap[ext] || 'application/octet-stream');
    res.sendFile(filePath);
  } catch (error) {
    console.error(error);
    res.status(500).send('Unable to load file.');
  }
});

app.get('/download/:id', requireAuth, async (req, res) => {
  try {
    const file = await getFile(Number(req.params.id));
    if (!file) {
      return res.status(404).send('File not found.');
    }
    addToRecent(file);
    const filePath = path.join(uploadsDir, file.stored_name);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File missing from storage.');
    }
    res.download(filePath, file.original_name);
  } catch (error) {
    console.error(error);
    res.status(500).send('Unable to download file.');
  }
});

initializeDatabase()
  .then(() => addColumnsIfNeeded())
  .then(() => rebuildLookupIndexes())
  .then(() => {
    app.listen(port, () => {
      console.log(`The shared workspace is running on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Database initialization failed', error);
    process.exit(1);
  });
