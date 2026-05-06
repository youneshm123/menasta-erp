require('./db'); // Initialize DB first

const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/shifts',    require('./routes/shifts'));
app.use('/api/pumps',     require('./routes/pumps'));
app.use('/api/credits',   require('./routes/credits'));
app.use('/api/products',  require('./routes/products'));
app.use('/api/dashboard', require('./routes/dashboard'));

app.get('/',    (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n⛽ YEX WEB démarré');
  console.log(`   http://localhost:${PORT}  — YEX WEB\n`);
});
