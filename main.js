const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');

/* ── AUTO-UPDATER ────────────────────────────────────────────── */
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = false;

// feedURL vem do package.json (GitHub Releases)

autoUpdater.on('update-available', (info) => {
  console.log('[Update] Nova versão disponível:', info.version);
  if(win) win.webContents.send('update-disponivel', info.version);
});

autoUpdater.on('download-progress', (progress) => {
  const pct = Math.round(progress.percent);
  console.log('[Update] Baixando:', pct+'%');
  if(win) win.webContents.send('update-progresso', pct);
});

autoUpdater.on('update-downloaded', () => {
  console.log('[Update] Atualização baixada — instalando agora...');
  if(win) win.webContents.send('update-pronto');
  setTimeout(() => autoUpdater.quitAndInstall(false, true), 2000);
});

autoUpdater.on('error', (err) => {
  console.log('[Update] Erro:', err.message);
});

autoUpdater.on('update-not-available', () => {
  console.log('[Update] Programa já está na versão mais recente.');
});

let win;
let winCalc = null;
let dados = {};
let db = null; // conexão MongoDB
let io = null; // Socket.io global para usar no IPC

const INPUTS_POR_PAGINA = 70;
const MONGO_URI = 'mongodb+srv://renanalbanojr0_db_user:C6HBx39A4MkRBTfl@cluster0.h4o2rnn.mongodb.net/?appName=Cluster0';
const DB_NAME   = 'faturas';
const COL_NAME  = 'dados';

/* ── CAMINHOS ────────────────────────────────────────────────── */
// Tudo em Documentos\Caus Faturas\ — acessível e organizado
const baseDir    = path.join(os.homedir(), 'Documents', 'Caus Faturas');
const saveFile   = path.join(baseDir, 'dados.json');
const backupDir  = path.join(baseDir, 'FaturasBackup');
const faturasDir = path.join(baseDir, 'FaturasPDF');
const precDir    = path.join(baseDir, 'PrecificacaoNFs');

// Garante que todas as pastas existem ao iniciar
[baseDir, backupDir, faturasDir, precDir].forEach(p => {
  if(!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

/* ── MONGODB ─────────────────────────────────────────────────── */
async function conectarMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME).collection(COL_NAME);
    console.log('✓ MongoDB conectado!');
  } catch(e) {
    console.warn('⚠ MongoDB offline — usando dados locais:', e.message);
    db = null;
  }
}

async function carregarDoMongo() {
  if(!db) return null;
  try {
    const doc = await db.findOne({ _id: 'principal' });
    if(doc) { delete doc._id; return doc; }
    return null;
  } catch(e) {
    console.warn('Erro ao carregar do MongoDB:', e.message);
    return null;
  }
}

async function salvarNoMongo(payload) {
  if(!db) return;
  try {
    await db.replaceOne({ _id: 'principal' }, { _id: 'principal', ...payload }, { upsert: true });
  } catch(e) {
    console.warn('Erro ao salvar no MongoDB:', e.message);
  }
}

/* ── BACKUP DIÁRIO ───────────────────────────────────────────── */
function timestampAgora() {
  const d = new Date();
  const data = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const hora = `${String(d.getHours()).padStart(2,'0')}h${String(d.getMinutes()).padStart(2,'0')}`;
  return `${data}_${hora}`;
}

function fazerBackup(motivo) {
  try {
    if (!fs.existsSync(saveFile)) return;
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const nomeArquivo  = `dados_${timestampAgora()}_${motivo}.json`;
    const arquivoBackup = path.join(backupDir, nomeArquivo);
    fs.copyFileSync(saveFile, arquivoBackup);
    console.log(`Backup criado: ${nomeArquivo}`);
    const arquivos = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('dados_') && f.endsWith('.json'))
      .sort();
    if (arquivos.length > 60) {
      arquivos.slice(0, arquivos.length - 60)
        .forEach(f => fs.unlinkSync(path.join(backupDir, f)));
    }
  } catch (err) {
    console.error('Erro ao fazer backup:', err);
  }
}

/* ── CARREGAR DADOS ──────────────────────────────────────────── */
function carregarDadosLocal() {
  if (fs.existsSync(saveFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(saveFile, { encoding: 'utf8' }));
      const arr = Array.isArray(raw) ? raw : (raw.dados || []);
      const corrompido = arr.length > 0 && arr.some(
        p => Array.isArray(p) && p.length > 0 && Math.abs(p.length - INPUTS_POR_PAGINA) > 10
      );
      if (!corrompido) return raw;
    } catch { }
  }
  if (fs.existsSync(backupDir)) {
    const backups = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('dados_') && f.endsWith('.json'))
      .sort().reverse();
    for (const bk of backups) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(backupDir, bk), 'utf8'));
        const arr = Array.isArray(raw) ? raw : (raw.dados || []);
        const corrompido = arr.length > 0 && arr.some(
          p => Array.isArray(p) && p.length > 0 && Math.abs(p.length - INPUTS_POR_PAGINA) > 10
        );
        if (!corrompido) { fs.writeFileSync(saveFile, JSON.stringify(raw)); return raw; }
      } catch { continue; }
    }
  }
  return {};
}

/* ── PROXY TINY API (para calculadora de NFs) ────────────────── */
function tinyRequest(tinyPath, body, callback) {
  const formBody = Object.entries(body)
    .map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v))
    .join('&');
  const opts = {
    hostname: 'api.tiny.com.br', port: 443,
    path: '/api2/' + tinyPath, method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formBody)
    }
  };
  const req = https.request(opts, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => callback(null, d));
  });
  req.on('error', err => callback(err, null));
  req.write(formBody); req.end();
}

/* ── DANFE: carrega biblioteca nfe-danfe-pdf ─────────────────── */
let gerarPDF = null;
(async () => {
  try {
    const lib = await import('nfe-danfe-pdf');
    gerarPDF = lib.gerarPDF || lib.default?.gerarPDF;
    console.log('✓ Biblioteca DANFE carregada');
  } catch(e) {
    console.warn('⚠ nfe-danfe-pdf não encontrado. Rode: npm install nfe-danfe-pdf');
  }
})();

function pdfkitToBuffer(doc) {
  const { PassThrough } = require('stream');
  return new Promise((resolve, reject) => {
    const pass = new PassThrough();
    const chunks = [];
    pass.on('data',  c => chunks.push(c));
    pass.on('end',   () => resolve(Buffer.concat(chunks)));
    pass.on('error', reject);
    doc.on('error',  e => { if (chunks.length > 0) resolve(Buffer.concat(chunks)); else reject(e); });
    doc.pipe(pass);
  });
}

function sendJSON(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/* ── CRIAR JANELA PRINCIPAL ──────────────────────────────────── */
async function createWindow() {
  // Conecta MongoDB e carrega dados
  await conectarMongo();
  const mongoData = await carregarDoMongo();
  dados = mongoData || carregarDadosLocal();
  fazerBackup('abertura');

  const expressApp = express();
  const server = http.createServer(expressApp);
  io = new Server(server);

  const publicPath = path.join(app.getAppPath(), 'public');

  expressApp.use(express.static(publicPath));
  expressApp.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

  // Rotas do histórico de precificação (MongoDB)
  expressApp.get('/historico-prec', async (req, res) => {
    try {
      if(!db) return res.json({ historico: [] });
      const doc = await db.findOne({ _id: 'historico_precificacao' });
      res.json({ historico: doc?.historico || [] });
    } catch(e) {
      console.error('[Histórico] Erro ao carregar:', e.message);
      res.json({ historico: [] });
    }
  });

  expressApp.post('/historico-prec', express.json({ limit: '5mb' }), async (req, res) => {
    try {
      if(!db) return res.json({ ok: false, erro: 'MongoDB não conectado' });
      const { historico } = req.body || {};
      await db.replaceOne(
        { _id: 'historico_precificacao' },
        { _id: 'historico_precificacao', historico: historico || [] },
        { upsert: true }
      );
      res.json({ ok: true });
    } catch(e) {
      console.error('[Histórico] Erro ao salvar:', e.message);
      res.json({ ok: false, erro: e.message });
    }
  });

  // Rota para salvar PDF das NFs de precificação
  expressApp.post('/salvar-pdf-nf', express.json({ limit: '20mb' }), (req, res) => {
    try {
      const { nome, pdf, isLocal } = req.body || {};
      if(!nome || !pdf) return res.json({ ok: false, erro: 'Dados incompletos' });
      const buffer = Buffer.from(pdf, 'base64');

      // Sempre salva na pasta PrecificacaoNFs do projeto
      fs.writeFileSync(path.join(precDir, nome), buffer);
      console.log(`[PDF NF] Salvo em PrecificacaoNFs: ${nome}`);

      // Se for acesso local (Electron), salva também nos Downloads
      let caminhoDownload = null;
      if(isLocal){
        const downloads = path.join(os.homedir(), 'Downloads');
        caminhoDownload = path.join(downloads, nome);
        fs.writeFileSync(caminhoDownload, buffer);
        console.log(`[PDF NF] Salvo nos Downloads: ${nome}`);
      }

      res.json({ ok: true, caminho: caminhoDownload || pasta });
    } catch(err) {
      console.error('[PDF NF] Erro:', err.message);
      res.json({ ok: false, erro: err.message });
    }
  });

  /* ── Rotas da Calculadora de NFs ── */
  const tinyRoutes = {
    listar_nf:  'notas.fiscais.pesquisa.php',
    detalhe_nf: 'nota.fiscal.obter.php',
  };

  expressApp.post('/tiny-api', express.json({ limit: '10mb' }), async (req, res) => {
    const { action, token, params } = req.body || {};
    if (!token && action !== 'danfe_from_xml') {
      return sendJSON(res, 400, { erro: 'Token obrigatório' });
    }

    // Gerar DANFE a partir de XML enviado pelo browser
    if (action === 'danfe_from_xml') {
      if (!gerarPDF) return sendJSON(res, 503, { erro: 'Rode: npm install nfe-danfe-pdf' });
      const xml = (params?.xml || '').trim();
      if (!xml) return sendJSON(res, 400, { erro: 'XML não enviado' });
      console.log(`[DANFE] gerando PDF (${xml.length} chars)...`);
      try {
        let xmlFinal = xml;
        if (xml.includes('<NFe') && !xml.includes('<nfeProc')) {
          xmlFinal = `<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">${xml}</nfeProc>`;
        }
        const doc = await gerarPDF(xmlFinal, { cancelada: false });
        const buf = await pdfkitToBuffer(doc);
        console.log(`[DANFE] OK — ${buf.length} bytes`);
        return sendJSON(res, 200, { pdf: buf.toString('base64') });
      } catch(e) {
        console.error('[DANFE] Erro:', e.message);
        return sendJSON(res, 500, { erro: 'Erro ao gerar DANFE: ' + e.message });
      }
    }

    // Rotas normais do Tiny
    const routePath = tinyRoutes[action];
    if (!routePath) return sendJSON(res, 400, { erro: 'Ação desconhecida: ' + action });
    const tinyParams = { token, formato: 'json', ...(params || {}) };
    console.log(`[Tiny] ${action} → /api2/${routePath}`);
    tinyRequest(routePath, tinyParams, (err, rawData) => {
      if (err) return sendJSON(res, 500, { erro: err.message });
      try {
        const parsed = JSON.parse(rawData);
        console.log(`  status: ${parsed?.retorno?.status}`);
        sendJSON(res, 200, parsed);
      } catch(e) {
        sendJSON(res, 500, { erro: 'Resposta inválida: ' + rawData.substring(0, 200) });
      }
    });
  });

  /* ── Socket.io ── */
  io.on('connection', (socket) => {
    socket.emit('load-data', dados);
    socket.on('update-data', (payload) => {
      dados = payload;
      // Salva local
      try { fs.writeFileSync(saveFile, JSON.stringify(dados), { encoding: 'utf8' }); }
      catch (err) { console.error('Erro ao salvar dados local:', err); }
      // Salva no MongoDB
      salvarNoMongo(dados);
      io.emit('load-data', dados);
    });
    socket.on('reset-all', () => {
      fazerBackup('antes-do-reset');
      dados = {};
      try { fs.writeFileSync(saveFile, JSON.stringify(dados), { encoding: 'utf8' }); }
      catch (err) { console.error('Erro ao zerar dados:', err); }
      salvarNoMongo(dados);
      io.emit('reset-all');
    });

    // Recebe PDF da calculadora e salva na pasta PrecificacaoNFs
    socket.on('salvar-pdf-nf', ({ nome, pdf }) => {
      try {
        const pasta = path.join(process.cwd(), 'PrecificacaoNFs');
        if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
        const arquivo = path.join(pasta, nome);
        const buffer = Buffer.from(pdf, 'base64');
        fs.writeFileSync(arquivo, buffer);
        console.log(`[PDF NF] Salvo: ${nome}`);
        socket.emit('pdf-nf-salvo', { ok: true });
      } catch(err) {
        console.error('[PDF NF] Erro ao salvar:', err.message);
        socket.emit('pdf-nf-salvo', { ok: false, erro: err.message });
      }
    });

    // Recebe imagem da fatura e salva na pasta FaturasPDF/DD-MM-YYYY
    socket.on('salvar-imagem', ({ numero, imgBase64 }) => {
      try {
        const hoje = new Date();
        const dataStr = `${String(hoje.getDate()).padStart(2,'0')}-${String(hoje.getMonth()+1).padStart(2,'0')}-${hoje.getFullYear()}`;
        const pasta = path.join(faturasDir, dataStr);
        if (!fs.existsSync(pasta)) fs.mkdirSync(pasta, { recursive: true });
        const arquivo = path.join(pasta, `FAT ${numero}.jpg`);
        const buffer = Buffer.from(imgBase64, 'base64');
        fs.writeFileSync(arquivo, buffer);
        console.log(`[Imagem] Salva: FaturasPDF/${dataStr}/FAT ${numero}.jpg`);
        socket.emit('imagem-salva', { numero, ok: true });
      } catch(err) {
        console.error('[Imagem] Erro ao salvar:', err.message);
        socket.emit('imagem-salva', { numero, ok: false, erro: err.message });
      }
    });
  });

  server.listen(3000, '0.0.0.0', () => {
    win = new BrowserWindow({
      width: 1400, height: 900,
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    win.loadURL('http://localhost:3000');

    // Verifica atualização 5 segundos após abrir
    setTimeout(() => {
      console.log('[Update] Verificando em: http://localhost:3000/updates');
      autoUpdater.checkForUpdates()
        .then(r => console.log('[Update] Resultado:', JSON.stringify(r?.updateInfo)))
        .catch(e => console.log('[Update] Erro:', e.message));
    }, 5000);
  });

  /* ── IPC: verificar atualização manualmente ── */
  ipcMain.on('verificar-update-manual', async (event) => {
    try {
      console.log('[Update] Verificação manual iniciada...');
      const result = await autoUpdater.checkForUpdates();
      if(result && result.updateInfo){
        const v = result.updateInfo.version;
        event.reply('update-resultado', `Versão disponível: ${v}
Baixando automaticamente...`);
      } else {
        event.reply('update-resultado', 'Programa já está na versão mais recente!');
      }
    } catch(e) {
      console.error('[Update] Erro:', e.message);
      event.reply('update-resultado', 'Erro ao verificar: ' + e.message);
    }
  });

  /* ── IPC: salvar PDF da calculadora de NFs ── */
  ipcMain.handle('salvar-pdf-nf-calc', async (event, { nome, pdf }) => {
    try {
      // 1. Salva nos Downloads do PC local
      const downloads = path.join(os.homedir(), 'Downloads');
      const arquivoLocal = path.join(downloads, nome);
      const buffer = Buffer.from(pdf, 'base64');
      fs.writeFileSync(arquivoLocal, buffer);
      console.log(`[PDF NF] Salvo nos Downloads: ${nome}`);

      // 2. Salva na pasta PrecificacaoNFs do projeto (PC1)
      const pastaProj = path.join(process.cwd(), 'PrecificacaoNFs');
      if (!fs.existsSync(pastaProj)) fs.mkdirSync(pastaProj, { recursive: true });
      const arquivoProj = path.join(pastaProj, nome);
      fs.writeFileSync(arquivoProj, buffer);
      console.log(`[PDF NF] Cópia salva em PrecificacaoNFs: ${nome}`);

      // 3. Se houver outros PCs conectados via socket, envia para eles também
      io.emit('pdf-nf-recebido', { nome, pdf });

      return { ok: true, caminho: arquivoLocal };
    } catch(err) {
      console.error('[PDF NF] Erro:', err.message);
      return { ok: false, erro: err.message };
    }
  });

  /* ── IPC: abrir janela calculadora ── */
  ipcMain.on('abrir-calculadora', () => {
    if (winCalc && !winCalc.isDestroyed()) {
      winCalc.focus();
      return;
    }
    winCalc = new BrowserWindow({
      width: 1300, height: 850,
      title: 'Calculadora de NFs',
      webPreferences: { nodeIntegration: false, contextIsolation: true, devTools: true }
    });
    winCalc.loadURL('http://localhost:3000/calculadora-nf.html');
    winCalc.on('closed', () => { winCalc = null; });
  });

  /* salvar-pdf removido — agora usa imagem via socket */
}

app.whenReady().then(() => createWindow().catch(console.error));

app.on('before-quit', () => fazerBackup('fechamento'));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
