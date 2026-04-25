require('dotenv').config();
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const express    = require('express');
const http       = require('http');
const compression = require('compression');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const saude     = require('./saude');

const MONGO_URI = process.env.MONGO_URI;
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
let colUsuarios = null;  // coleção dos usuários do sistema
let colAuditoria = null; // coleção do log de auditoria
async function conectarMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('faturas').collection('dados');
    colUsuarios = client.db('faturas').collection('usuarios');
    colAuditoria = client.db('faturas').collection('auditoria');
    console.log('[MongoDB] Conectado!');
    // Cria índice único no campo "usuario" pra evitar duplicatas
    await colUsuarios.createIndex({ usuario: 1 }, { unique: true });
    // Índices na auditoria pra consulta rápida
    await colAuditoria.createIndex({ timestamp: -1 });
    await colAuditoria.createIndex({ usuario: 1, timestamp: -1 });
    await colAuditoria.createIndex({ acao: 1, timestamp: -1 });
    // Cria admin master inicial se ainda não existe (renan/3003)
    await criarAdminInicial();
  } catch(e) {
    console.error('[MongoDB] Erro:', e.message);
  }
}

/* Cria o admin master "renan/3003" na primeira inicialização */
async function criarAdminInicial() {
  if(!colUsuarios) return;
  try {
    const existente = await colUsuarios.findOne({ usuario: 'renan' });
    if(existente) {
      console.log('[Auth] Admin "renan" já existe');
      return;
    }
    const senhaHash = await bcrypt.hash('3003', 10);
    await colUsuarios.insertOne({
      usuario: 'renan',
      senhaHash,
      role: 'admin',
      criadoEm: new Date(),
      criadoPor: 'sistema',
    });
    console.log('[Auth] Admin "renan/3003" criado com sucesso');
  } catch(e) {
    console.error('[Auth] Erro ao criar admin inicial:', e.message);
  }
}

/* Mapa de tokens de sessão ativos (em memória).
   Estrutura: { "token": { usuario, role, criadoEm } }
   Tokens não expiram (logout manual). Limpos no restart do servidor.
   Pra sessões persistentes entre restarts, salvar no Mongo no futuro. */
const sessoes = {};

/* Gera um token aleatório de 32 bytes */
function gerarTokenSessao() {
  return crypto.randomBytes(32).toString('hex');
}

/* Valida um token e retorna a sessão (ou null se inválido) */
function validarToken(token) {
  if(!token) return null;
  return sessoes[token] || null;
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

// Endpoint de saúde simples (pra UptimeRobot e curl)
// HTTP 200 se tudo ok/warn; HTTP 500 se algum check crítico falhou
expressApp.get('/saude', saude.handlerSaude);

// Endpoint detalhado (JSON completo pro dashboard)
expressApp.get('/saude/detalhe', saude.handlerDetalhe);

// Dashboard HTML de saúde
expressApp.get('/admin/saude', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-saude.html'));
});

// Dashboard HTML de auditoria
expressApp.get('/admin/auditoria', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-auditoria.html'));
});

// Retorna dados atuais para backup nos PCs
expressApp.get('/dados-atual', (req, res) => {
  try {
    const dados = (typeof dadosCache !== 'undefined' && dadosCache) || carregarDados() || { dados: [], finalizadas: [] };
    res.json(dados);
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// Proxy Tiny ERP + DANFE
expressApp.post('/tiny-api', async (req, res) => {
  const { action, token: tokenReq, params } = req.body || {};
  const token = process.env.TINY_TOKEN || tokenReq;
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
      listar_nf:         'notas.fiscais.pesquisa.php',
      detalhe_nf:        'nota.fiscal.obter.php',
      pesquisar_produto: 'produtos.pesquisa.php',
      obter_produto:     'produto.obter.php',
      alterar_produto:   'produto.alterar.php',
      cliente_pesquisa:         'contatos.pesquisa.php',
      cliente_incluir:          'contato.incluir.php',
      pedido_incluir:           'pedido.incluir.php',
      gerar_nota_fiscal_pedido: 'gerar.nota.fiscal.pedido.php',
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

// Proxy Mercado Livre API (pública, sem auth, mas bloqueia navegador por CORS)
// Aqui no servidor funciona normal. Usado pelo cadastro automático de produtos.
expressApp.post('/ml-api', async (req, res) => {
  const { action, params } = req.body || {};
  try {
    const https = require('https');
    let path = '';
    if(action === 'search_by_gtin'){
      const gtin = (params?.gtin || '').trim();
      const limit = params?.limit || 5;
      if(!gtin) return res.json({ erro: 'GTIN não informado' });
      path = `/sites/MLB/search?q=${encodeURIComponent(gtin)}&limit=${limit}`;
    } else if(action === 'search'){
      const q = (params?.q || '').trim();
      const limit = params?.limit || 5;
      if(!q) return res.json({ erro: 'Query não informada' });
      path = `/sites/MLB/search?q=${encodeURIComponent(q)}&limit=${limit}`;
    } else {
      return res.json({ erro: 'Ação inválida: ' + action });
    }
    const options = {
      hostname: 'api.mercadolibre.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'CAUS Cadastro Automatico/1.0',
        'Accept': 'application/json'
      }
    };
    const proxyReq = https.request(options, proxyRes => {
      let data = '';
      proxyRes.on('data', d => data += d);
      proxyRes.on('end', () => {
        try { res.json(JSON.parse(data)); } catch(e) { res.json({ erro: data.substring(0,500) }); }
      });
    });
    proxyReq.on('error', e => res.json({ erro: e.message }));
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

/* ════════════════════════════════════════════════════════════════
   AUTENTICAÇÃO E GESTÃO DE USUÁRIOS
   ════════════════════════════════════════════════════════════════ */

/* POST /auth/login
   Body: { usuario, senha }
   Retorno OK: { ok: true, token, usuario, role }
   Retorno erro: { ok: false, erro } */
expressApp.post('/auth/login', async (req, res) => {
  try {
    if(!colUsuarios) return res.json({ ok: false, erro: 'Banco indisponível' });
    const { usuario, senha } = req.body || {};
    if(!usuario || !senha) return res.json({ ok: false, erro: 'Usuário e senha obrigatórios' });

    const user = await colUsuarios.findOne({ usuario: String(usuario).trim().toLowerCase() });
    if(!user) return res.json({ ok: false, erro: 'Usuário ou senha inválidos' });

    const ok = await bcrypt.compare(String(senha), user.senhaHash);
    if(!ok) return res.json({ ok: false, erro: 'Usuário ou senha inválidos' });

    // Cria sessão
    const token = gerarTokenSessao();
    sessoes[token] = {
      usuario: user.usuario,
      role: user.role,
      criadoEm: new Date(),
    };
    // Registra auditoria
    registrarAuditoria(user.usuario, 'login', { role: user.role });
    res.json({
      ok: true,
      token,
      usuario: user.usuario,
      role: user.role,
    });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
});

/* POST /auth/logout
   Body: { token }
   Invalida a sessão. */
expressApp.post('/auth/logout', (req, res) => {
  const { token } = req.body || {};
  if(token && sessoes[token]) {
    const usuario = sessoes[token].usuario;
    delete sessoes[token];
    registrarAuditoria(usuario, 'logout', {});
  }
  res.json({ ok: true });
});

/* POST /auth/validar-token
   Body: { token }
   Retorna sessão se válida, ou erro. Útil pra reabertura do app. */
expressApp.post('/auth/validar-token', (req, res) => {
  const { token } = req.body || {};
  const sessao = validarToken(token);
  if(!sessao) return res.json({ ok: false, erro: 'Token inválido' });
  res.json({ ok: true, usuario: sessao.usuario, role: sessao.role });
});

/* POST /auth/listar-usuarios
   Body: { token }
   Lista todos usuários (apenas admin). */
expressApp.post('/auth/listar-usuarios', async (req, res) => {
  try {
    const { token } = req.body || {};
    const sessao = validarToken(token);
    if(!sessao || sessao.role !== 'admin') return res.json({ ok: false, erro: 'Sem permissão' });
    if(!colUsuarios) return res.json({ ok: false, erro: 'Banco indisponível' });

    const lista = await colUsuarios.find({}, { projection: { senhaHash: 0 } }).toArray();
    res.json({ ok: true, usuarios: lista });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
});

/* POST /auth/criar-usuario
   Body: { token, usuario, senha, role }
   Cria novo usuário (apenas admin). role: 'admin' ou 'comum' */
expressApp.post('/auth/criar-usuario', async (req, res) => {
  try {
    const { token, usuario, senha, role } = req.body || {};
    const sessao = validarToken(token);
    if(!sessao || sessao.role !== 'admin') return res.json({ ok: false, erro: 'Sem permissão' });
    if(!colUsuarios) return res.json({ ok: false, erro: 'Banco indisponível' });
    if(!usuario || !senha) return res.json({ ok: false, erro: 'Usuário e senha obrigatórios' });
    if(senha.length < 4) return res.json({ ok: false, erro: 'Senha precisa ter no mínimo 4 caracteres' });

    const usuarioLimpo = String(usuario).trim().toLowerCase();
    const roleLimpa = (role === 'admin') ? 'admin' : 'comum';

    // Verifica se já existe
    const existente = await colUsuarios.findOne({ usuario: usuarioLimpo });
    if(existente) return res.json({ ok: false, erro: 'Usuário já existe' });

    const senhaHash = await bcrypt.hash(String(senha), 10);
    await colUsuarios.insertOne({
      usuario: usuarioLimpo,
      senhaHash,
      role: roleLimpa,
      criadoEm: new Date(),
      criadoPor: sessao.usuario,
    });
    registrarAuditoria(sessao.usuario, 'criar-usuario', { criou: usuarioLimpo, role: roleLimpa });
    res.json({ ok: true, usuario: usuarioLimpo, role: roleLimpa });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
});

/* POST /auth/excluir-usuario
   Body: { token, usuario }
   Exclui usuário (apenas admin). NÃO permite excluir o próprio admin logado. */
expressApp.post('/auth/excluir-usuario', async (req, res) => {
  try {
    const { token, usuario } = req.body || {};
    const sessao = validarToken(token);
    if(!sessao || sessao.role !== 'admin') return res.json({ ok: false, erro: 'Sem permissão' });
    if(!colUsuarios) return res.json({ ok: false, erro: 'Banco indisponível' });
    if(!usuario) return res.json({ ok: false, erro: 'Usuário obrigatório' });

    const usuarioLimpo = String(usuario).trim().toLowerCase();

    // Não permite excluir o próprio admin logado (proteção)
    if(usuarioLimpo === sessao.usuario) return res.json({ ok: false, erro: 'Você não pode excluir sua própria conta' });

    // Não permite excluir o renan (admin master) — só pode trocar senha
    if(usuarioLimpo === 'renan') return res.json({ ok: false, erro: 'Não é possível excluir o admin master' });

    const result = await colUsuarios.deleteOne({ usuario: usuarioLimpo });
    if(result.deletedCount === 0) return res.json({ ok: false, erro: 'Usuário não encontrado' });

    // Invalida sessões ativas desse usuário
    for(const t in sessoes) {
      if(sessoes[t].usuario === usuarioLimpo) delete sessoes[t];
    }

    registrarAuditoria(sessao.usuario, 'excluir-usuario', { excluiu: usuarioLimpo });
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
});

/* POST /auth/trocar-senha
   Body: { token, senhaAtual, senhaNova }
   Permite o usuário logado trocar a própria senha. */
expressApp.post('/auth/trocar-senha', async (req, res) => {
  try {
    const { token, senhaAtual, senhaNova } = req.body || {};
    const sessao = validarToken(token);
    if(!sessao) return res.json({ ok: false, erro: 'Não autenticado' });
    if(!colUsuarios) return res.json({ ok: false, erro: 'Banco indisponível' });
    if(!senhaAtual || !senhaNova) return res.json({ ok: false, erro: 'Senha atual e nova obrigatórias' });
    if(senhaNova.length < 4) return res.json({ ok: false, erro: 'Senha nova precisa ter no mínimo 4 caracteres' });

    const user = await colUsuarios.findOne({ usuario: sessao.usuario });
    if(!user) return res.json({ ok: false, erro: 'Usuário não encontrado' });

    const ok = await bcrypt.compare(String(senhaAtual), user.senhaHash);
    if(!ok) return res.json({ ok: false, erro: 'Senha atual incorreta' });

    const senhaHash = await bcrypt.hash(String(senhaNova), 10);
    await colUsuarios.updateOne({ usuario: sessao.usuario }, { $set: { senhaHash } });
    registrarAuditoria(sessao.usuario, 'trocar-senha', {});
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   AUDITORIA — registro permanente de quem fez o quê e quando
   ════════════════════════════════════════════════════════════════ */

/* Função interna: registra um evento na coleção de auditoria.
   Chamada de dentro dos próprios endpoints (login, criar-usuario, etc).
   NUNCA bloqueia: se falhar, só loga no console. */
async function registrarAuditoria(usuario, acao, detalhes = {}) {
  if(!colAuditoria) return;
  try {
    await colAuditoria.insertOne({
      timestamp: new Date(),
      usuario: usuario || 'desconhecido',
      acao: acao,
      detalhes: detalhes,
    });
  } catch(e) {
    console.error('[Auditoria] Erro ao registrar:', e.message);
  }
}

/* POST /auditoria/registrar
   Body: { token, acao, detalhes }
   Registra um evento de auditoria vindo do frontend. Token obrigatório.
   Ações válidas estão nos comentários do frontend (criar-fatura, editar-fatura, etc). */
expressApp.post('/auditoria/registrar', async (req, res) => {
  try {
    const { token, acao, detalhes } = req.body || {};
    const sessao = validarToken(token);
    // Mesmo sem token (sessão fallback site/dev), registra como "desconhecido"
    const usuario = sessao?.usuario || (req.body?.usuarioFallback) || 'desconhecido';
    if(!acao) return res.json({ ok: false, erro: 'Ação obrigatória' });

    await registrarAuditoria(usuario, String(acao).slice(0, 64), detalhes || {});
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
});

/* POST /auditoria/listar
   Body: { token, filtros: { usuario?, acao?, dataInicio?, dataFim? }, limite?, skip? }
   Lista eventos. APENAS admin. */
expressApp.post('/auditoria/listar', async (req, res) => {
  try {
    const { token, filtros = {}, limite = 200, skip = 0 } = req.body || {};
    const sessao = validarToken(token);
    if(!sessao || sessao.role !== 'admin') return res.json({ ok: false, erro: 'Sem permissão' });
    if(!colAuditoria) return res.json({ ok: false, erro: 'Banco indisponível' });

    const query = {};
    if(filtros.usuario) query.usuario = String(filtros.usuario).trim().toLowerCase();
    if(filtros.acao) query.acao = String(filtros.acao).trim();
    if(filtros.dataInicio || filtros.dataFim) {
      query.timestamp = {};
      if(filtros.dataInicio) query.timestamp.$gte = new Date(filtros.dataInicio);
      if(filtros.dataFim) query.timestamp.$lte = new Date(filtros.dataFim);
    }

    const limiteSeguro = Math.min(parseInt(limite) || 200, 1000);
    const skipSeguro = Math.max(parseInt(skip) || 0, 0);

    const [eventos, total] = await Promise.all([
      colAuditoria.find(query).sort({ timestamp: -1 }).skip(skipSeguro).limit(limiteSeguro).toArray(),
      colAuditoria.countDocuments(query),
    ]);

    res.json({ ok: true, eventos, total, limite: limiteSeguro, skip: skipSeguro });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
});

/* POST /auditoria/contagem-acoes
   Body: { token, dias? }
   Retorna contagem de eventos por ação (pra cards no dashboard). Apenas admin. */
expressApp.post('/auditoria/contagem-acoes', async (req, res) => {
  try {
    const { token, dias = 30 } = req.body || {};
    const sessao = validarToken(token);
    if(!sessao || sessao.role !== 'admin') return res.json({ ok: false, erro: 'Sem permissão' });
    if(!colAuditoria) return res.json({ ok: false, erro: 'Banco indisponível' });

    const desde = new Date();
    desde.setDate(desde.getDate() - parseInt(dias || 30));

    const contagem = await colAuditoria.aggregate([
      { $match: { timestamp: { $gte: desde } } },
      { $group: { _id: '$acao', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray();

    const total = contagem.reduce((acc, c) => acc + c.count, 0);
    res.json({ ok: true, contagem, total, dias });
  } catch(e) {
    res.json({ ok: false, erro: e.message });
  }
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

  socket.on('reset-all', async (payload) => {
    const vazio = { dados: [], finalizadas: [] };
    dadosCache = vazio; // limpa cache em memória
    fs.writeFileSync(saveFile, JSON.stringify(vazio), 'utf8');
    if(db) await db.replaceOne({ _id: 'principal' }, { _id: 'principal', ...vazio }, { upsert: true });
    io.emit('load-data', vazio); // propaga para todos
    io.emit('reset-all'); // força limpeza local em todos os clientes
    // Log de auditoria — quem zerou? Pega do payload (frontend envia { usuario })
    const usuarioReset = (payload && payload.usuario) || 'desconhecido';
    registrarAuditoria(usuarioReset, 'zerar-tudo', {});
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

  // Inicializa módulo de saúde (depois do Mongo pra passar a referência)
  saude.inicializar({
    db,
    io,
    saveFile,
    backupDir,
  });
});

const porta = PORT;
server.listen(porta, '0.0.0.0', () => {
  const proto = 'http';
  console.log(`[Servidor] Rodando em ${proto}://0.0.0.0:${porta}`);
});
