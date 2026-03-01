const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const BIN_ID = process.env.JSONBIN_ID || '69a2940f43b1c97be9a5bb40';
const MASTER_KEY = process.env.JSONBIN_KEY || '$2a$10$mmTSmzLSMhC.Iu/LuCseZO63vwObqPGDJcdxFV1Ou1r1GjKmsdya6';
const BIN_URL = `https://api.jsonbin.io/v3/b/${BIN_ID}`;

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30000;

async function readDB() {
    const now = Date.now();
    if (cache && (now - cacheTime) < CACHE_TTL) return cache;
    const r = await fetch(BIN_URL + '/latest', { headers: { 'X-Master-Key': MASTER_KEY } });
    const d = await r.json();
    cache = d.record || {};
    if (!cache.users) cache.users = [];
    if (!cache.tracks) cache.tracks = [];
    if (!cache.lastId) cache.lastId = 0;
    cacheTime = now;
    return cache;
}

async function writeDB(db) {
    cache = db;
    cacheTime = Date.now();
    await fetch(BIN_URL, {
        method: 'PUT',
        headers: { 'X-Master-Key': MASTER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(db)
    });
}

app.post('/api/dir/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ success: false, error: 'Заполни все поля' });
        if (password.length < 3) return res.status(400).json({ success: false, error: 'Пароль минимум 3 символа' });
        const db = await readDB();
        if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
            return res.json({ success: false, error: 'Имя занято' });
        db.lastId++;
        const user = { id: db.lastId.toString(), username, password, favorites: [], createdAt: Date.now() };
        db.users.push(user);
        await writeDB(db);
        res.json({ success: true, id: user.id, username: user.username, favorites: [] });
    } catch(e) { res.status(500).json({ success: false, error: 'Ошибка сервера' }); }
});

app.post('/api/dir/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const db = await readDB();
        const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
        if (!user) return res.status(401).json({ success: false, error: 'Неверное имя или пароль' });
        res.json({ success: true, id: user.id, username: user.username, favorites: user.favorites || [] });
    } catch(e) { res.status(500).json({ success: false, error: 'Ошибка сервера' }); }
});

app.post('/api/dir/tracks', async (req, res) => {
    try {
        const { userId, title, artist, url } = req.body;
        if (!userId || !title || !artist || !url) return res.status(400).json({ success: false, error: 'Заполни все поля' });
        const db = await readDB();
        const user = db.users.find(u => u.id === userId);
        if (!user) return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        db.lastId++;
        const track = { id: db.lastId.toString(), userId, addedBy: user.username, title: title.trim(), artist: capitalize(artist), url: convertUrl(url), addedAt: Date.now() };
        db.tracks.unshift(track);
        if (db.tracks.length > 500) db.tracks = db.tracks.slice(0, 500);
        await writeDB(db);
        res.json({ success: true, track });
    } catch(e) { res.status(500).json({ success: false, error: 'Ошибка сервера' }); }
});

app.get('/api/dir/tracks', async (req, res) => {
    try {
        const { search, artist } = req.query;
        const db = await readDB();
        let list = [...db.tracks];
        if (artist) list = list.filter(t => t.artist.toLowerCase() === decodeURIComponent(artist).toLowerCase());
        if (search) { const q = search.toLowerCase(); list = list.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)); }
        res.json(list);
    } catch(e) { res.json([]); }
});

app.delete('/api/dir/tracks/:id', async (req, res) => {
    try {
        const { userId } = req.body;
        const db = await readDB();
        const track = db.tracks.find(t => t.id === req.params.id);
        if (!track) return res.status(404).json({ success: false });
        if (track.userId !== userId) return res.status(403).json({ success: false, error: 'Нет доступа' });
        db.tracks = db.tracks.filter(t => t.id !== req.params.id);
        await writeDB(db);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, error: 'Ошибка сервера' }); }
});

app.post('/api/dir/favorites', async (req, res) => {
    try {
        const { userId, trackId } = req.body;
        const db = await readDB();
        const user = db.users.find(u => u.id === userId);
        if (!user) return res.status(404).json({ success: false });
        if (!user.favorites) user.favorites = [];
        const idx = user.favorites.indexOf(trackId);
        if (idx === -1) user.favorites.push(trackId);
        else user.favorites.splice(idx, 1);
        await writeDB(db);
        res.json({ success: true, favorites: user.favorites, liked: idx === -1 });
    } catch(e) { res.status(500).json({ success: false, error: 'Ошибка сервера' }); }
});

app.get('/api/dir/artists', async (req, res) => {
    try {
        const db = await readDB();
        const artists = {};
        db.tracks.forEach(t => { if (!artists[t.artist]) artists[t.artist] = 0; artists[t.artist]++; });
        res.json(Object.entries(artists).map(([name, count]) => ({ name, count })).sort((a,b) => b.count - a.count));
    } catch(e) { res.json([]); }
});

// ===== DOWNLOAD PROXY =====
app.get('/api/dir/download', async (req, res) => {
    try {
        const url = decodeURIComponent(req.query.url || '');
        const name = decodeURIComponent(req.query.name || 'track.mp3');
        if (!url) return res.status(400).send('No URL');
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) return res.status(502).send('Fetch failed: ' + r.status);
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const buf = await r.arrayBuffer();
        res.send(Buffer.from(buf));
    } catch(e) { res.status(500).send('Error: ' + e.message); }
});

function convertUrl(url) {
    url = url.trim();
    const gd = url.match(/drive\.google\.com\/file\/d\/([^\/\?]+)/);
    if (gd) return `https://drive.google.com/uc?export=download&id=${gd[1]}`;
    return url;
}

function capitalize(str) {
    return str.replace(/\b([а-яёa-z])/gi, c => c.toUpperCase()).trim();
}

app.listen(PORT, () => console.log(`Dir running on port ${PORT}`));
