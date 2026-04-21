const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const express    = require('express');
const http       = require('http');
const compression = require('compression');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

const MONGO_URI = 'mongodb+srv://renanalbanojr0_db_user:C6HBx39A4MkRBTfl@cluster0.h4o2rnn.mongodb.net/?appName=Cluster0';
const PORT = 3000;

/* ── CAMINHOS ── */
const baseDir    = path.join('/var/www/caus-faturas/dados');
const saveFile   = path.join(baseDir, 'dados.json');
const backupDir  = path.join(baseDir, 'FaturasBackup');
const faturasDir = path.join(baseDir, 'FaturasPDF');
const precDir    = path.join(baseDir, 'PrecificacaoNFs');

[baseDir, backupDir, faturasDir, precDir].forEach(p => {
  if(!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

/* ── EXPRESS ── */
const expressApp = express();

server = http.createServer(expressApp);

// Redireciona HTTP para HTTPS se estiver usando HTTPS


const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 10000,
  pingInterval: 5000,
  transports: ['websocket', 'polling'] // websocket primeiro — mais rápido
});

expressApp.use(compression()); // gzip em todas as respostas
expressApp.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '30m', // cache de 30 minutos
  etag: true,
  lastModified: true
}));
expressApp.use(express.json({ limit: '50mb' }));

/* ── MONGODB ── */
let db = null;
async function conectarMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('faturas').collection('dados');
    console.log('[MongoDB] Conectado!');
  } catch(e) {
    console.error('[MongoDB] Erro:', e.message);
  }
}

/* ── BACKUP ── */
function fazerBackup(tipo) {
  try {
    if(!fs.existsSync(saveFile)) return;
    const ts  = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const dest = path.join(backupDir, `dados_${ts}_${tipo}.json`);
    fs.copyFileSync(saveFile, dest);
    const lista = fs.readdirSync(backupDir).filter(f=>f.endsWith('.json')).sort();
    if(lista.length > 60) lista.slice(0, lista.length-60).forEach(f=>fs.unlinkSync(path.join(backupDir,f)));
  } catch(e) { console.error('[Backup] Erro:', e.message); }
}

/* ── CARREGA DADOS ── */
function carregarDados() {
  try {
    if(fs.existsSync(saveFile)){
      return JSON.parse(fs.readFileSync(saveFile, 'utf8'));
    }
  } catch(e) { console.error('[Dados] Erro ao carregar:', e.message); }
  return null;
}

/* ── DANFE ── */
let gerarPDF = null;
(async () => {
  try {
    const lib = await import('nfe-danfe-pdf');
    gerarPDF = lib.gerarPDF || lib.default?.gerarPDF;
    console.log('✓ Biblioteca DANFE carregada');
  } catch(e) {
    console.warn('⚠ nfe-danfe-pdf não instalado. Rode: npm install nfe-danfe-pdf');
  }
})();

function pdfkitToBuffer(doc) {
  const { PassThrough } = require('stream');
  return new Promise((resolve, reject) => {
    const pass = new PassThrough();
    const chunks = [];
    pass.on('data', c => chunks.push(c));
    pass.on('end', () => resolve(Buffer.concat(chunks)));
    pass.on('error', reject);
    doc.on('error', e => { if(chunks.length > 0) resolve(Buffer.concat(chunks)); else reject(e); });
    doc.pipe(pass);
  });
}

/* ── ROTAS ── */
expressApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Headers de segurança globais
expressApp.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// Ping para identificação na rede
expressApp.get('/ping', (req, res) => {
  res.json({ servidor: 'caus-faturas', ok: true, version: '1.0' });
});

// Proxy Tiny ERP + DANFE
expressApp.post('/tiny-api', async (req, res) => {
  const { action, token, params } = req.body || {};
  try {
    // Gera DANFE a partir de XML
    if(action === 'danfe_from_xml') {
      if(!gerarPDF) return res.json({ erro: 'nfe-danfe-pdf não instalado no servidor' });
      const xml = (params?.xml || '').trim();
      if(!xml) return res.json({ erro: 'XML não enviado' });
      let xmlFinal = xml;
      if(xml.includes('<NFe') && !xml.includes('<nfeProc')) {
        xmlFinal = `<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">${xml}</nfeProc>`;
      }
      const doc = await gerarPDF(xmlFinal, { cancelada: false });
      const buf = await pdfkitToBuffer(doc);
      return res.json({ pdf: buf.toString('base64') });
    }

    // Proxy para API Tiny
    const endpoints = {
      listar_nf:  'notas.fiscais.pesquisa.php',
      detalhe_nf: 'nota.fiscal.obter.php',
    };
    const ep = endpoints[action];
    if(!ep) return res.json({ erro: 'Ação inválida: ' + action });

    const https = require('https');
    const qs = require('querystring');
    const body = qs.stringify({ token, formato: 'JSON', ...params });
    const options = {
      hostname: 'api.tiny.com.br',
      path: `/api2/${ep}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const proxyReq = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', d => data += d);
      proxyRes.on('end', () => {
        try { res.json(JSON.parse(data)); } catch(e) { res.json({ erro: data }); }
      });
    });
    proxyReq.on('error', e => res.json({ erro: e.message }));
    proxyReq.write(body);
    proxyReq.end();
  } catch(e) { res.json({ erro: e.message }); }
});

// Histórico de precificação
expressApp.get('/historico-prec', async (req, res) => {
  try {
    if(!db) return res.json({ historico: [] });
    const doc = await db.findOne({ _id: 'historico_precificacao' });
    res.json({ historico: doc?.historico || [] });
  } catch(e) { res.json({ historico: [] }); }
});

expressApp.post('/historico-prec', async (req, res) => {
  try {
    if(!db) return res.json({ ok: false });
    const { historico } = req.body || {};
    await db.replaceOne({ _id: 'historico_precificacao' }, { _id: 'historico_precificacao', historico: historico || [] }, { upsert: true });
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

// Salvar PDF de NFs
expressApp.post('/salvar-pdf-nf', express.json({ limit: '20mb' }), (req, res) => {
  try {
    const { nome, pdf } = req.body || {};
    if(!nome || !pdf) return res.json({ ok: false, erro: 'Dados incompletos' });
    const buffer = Buffer.from(pdf, 'base64');
    fs.writeFileSync(path.join(precDir, nome), buffer);
    console.log(`[PDF NF] Salvo: ${nome}`);
    res.json({ ok: true, caminho: precDir });
  } catch(e) { res.json({ ok: false, erro: e.message }); }
});

/* ── SOCKET.IO ── */
// Cache em memória — resposta instantânea sem ler disco
let dadosCache = null;

io.on('connection', socket => {
  console.log('[Socket] Cliente conectado:', socket.id);

  // Envia dados do cache (instantâneo) ou do disco
  const dados = dadosCache || carregarDados();
  if(dados) socket.emit('load-data', dados);

  socket.on('update-data', async payload => {
    try {
      dadosCache = payload; // atualiza cache imediatamente
      // Propaga para todos instantaneamente
      socket.broadcast.emit('load-data', payload);
      // Salva em disco e MongoDB em segundo plano
      setImmediate(async () => {
        try {
          fs.writeFileSync(saveFile, JSON.stringify(payload), 'utf8');
          fazerBackup('auto');
          if(db) await db.replaceOne({ _id: 'principal' }, { _id: 'principal', ...payload }, { upsert: true });
        } catch(e) { console.error('[Save] Erro:', e.message); }
      });
    } catch(e) { console.error('[Update] Erro:', e.message); }
  });

  socket.on('reset-all', async () => {
    const vazio = { dados: [], finalizadas: [] };
    dadosCache = vazio; // limpa cache em memória
    fs.writeFileSync(saveFile, JSON.stringify(vazio), 'utf8');
    if(db) await db.replaceOne({ _id: 'principal' }, { _id: 'principal', ...vazio }, { upsert: true });
    io.emit('load-data', vazio); // propaga para todos
    io.emit('reset-all'); // força limpeza local em todos os clientes
  });

  socket.on('salvar-imagem', ({ numero, imgBase64 }) => {
    try {
      const hoje = new Date();
      const dataStr = `${String(hoje.getDate()).padStart(2,'0')}-${String(hoje.getMonth()+1).padStart(2,'0')}-${hoje.getFullYear()}`;
      const pasta = path.join(faturasDir, dataStr);
      if(!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
      fs.writeFileSync(path.join(pasta, `FAT ${numero}.jpg`), Buffer.from(imgBase64, 'base64'));
      console.log(`[Imagem] Salva: FAT ${numero}.jpg`);
      socket.emit('imagem-salva', { numero, ok: true });
      // Propaga para todos os outros clientes salvarem cópia
      socket.broadcast.emit('salvar-imagem-copia', { numero, imgBase64, dataStr });
    } catch(e) {
      socket.emit('imagem-salva', { numero, ok: false, erro: e.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Cliente desconectado:', socket.id);
  });
});

/* ── INICIA ── */
conectarMongo().then(() => {
  // Carrega do MongoDB na inicialização
  if(db) {
    db.findOne({ _id: 'principal' }).then(doc => {
      if(doc) {
        const { _id, ...payload } = doc;
        fs.writeFileSync(saveFile, JSON.stringify(payload), 'utf8');
        console.log('[Dados] Carregados do MongoDB');
      }
    }).catch(e => console.error('[Dados] Erro MongoDB:', e.message));
  }
});

const porta = PORT;
server.listen(porta, '0.0.0.0', () => {
  const proto = 'http';
  console.log(`[Servidor] Rodando em ${proto}://0.0.0.0:${porta}`);
});
