/* ═══════════════════════════════════════════════════════════════
   CAUS Faturas — Módulo de Saúde do Sistema
   ═══════════════════════════════════════════════════════════════
   Roda no VPS (server-vps.js) e expõe status detalhado do sistema.

   Uso:
     const saude = require('./saude');
     saude.inicializar({ db, io, saveFile, backupDriveDir, backblazeDir });

     // Endpoint UptimeRobot (HTTP 200/500)
     app.get('/saude', saude.handlerSaude);

     // Endpoint dashboard (JSON detalhado)
     app.get('/saude/detalhe', saude.handlerDetalhe);
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let config = {
  db: null,           // coleção MongoDB
  io: null,           // servidor Socket.io
  saveFile: null,     // dados.json principal
  backupDir: null,    // FaturasBackup
  driveDir: null,     // onde o backup-drive.js deixa rastro (se houver)
  iniciadoEm: Date.now(),
};

function inicializar(opts) {
  Object.assign(config, opts);
  config.iniciadoEm = Date.now();
  console.log('[Saúde] Módulo inicializado.');
}

/* ── HELPERS ──────────────────────────────────────────────────── */

function formatarBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return (bytes / 1024 ** 3).toFixed(2) + ' GB';
}

function formatarUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function horasAtras(timestamp) {
  if (!timestamp) return null;
  return Math.floor((Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60));
}

/* ── CHECKS ──────────────────────────────────────────────────────
   Cada check retorna { status, detalhes }
   status: 'ok' | 'warn' | 'erro'
   ─────────────────────────────────────────────────────────────── */

/* 1. Servidor (processo Node) */
function checarServidor() {
  const memoria = process.memoryUsage();
  const uptimeProcesso = Date.now() - config.iniciadoEm;
  return {
    status: 'ok',
    detalhes: {
      uptime: formatarUptime(uptimeProcesso),
      uptimeMs: uptimeProcesso,
      nodeVersion: process.version,
      pid: process.pid,
      memoria: {
        rss: formatarBytes(memoria.rss),
        heapUsed: formatarBytes(memoria.heapUsed),
        heapTotal: formatarBytes(memoria.heapTotal),
      }
    }
  };
}

/* 2. MongoDB — ping com timeout curto */
async function checarMongoDB() {
  if (!config.db) {
    return { status: 'erro', detalhes: { erro: 'MongoDB não conectado' } };
  }
  try {
    const inicio = Date.now();
    // Ping via admin command com timeout
    const pingPromise = config.db.findOne({ _id: 'principal' }, { projection: { _id: 1 } });
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout 3s')), 3000)
    );
    await Promise.race([pingPromise, timeoutPromise]);
    const latencia = Date.now() - inicio;
    return {
      status: latencia > 1500 ? 'warn' : 'ok',
      detalhes: {
        latenciaMs: latencia,
        conectado: true,
      }
    };
  } catch (e) {
    return { status: 'erro', detalhes: { erro: e.message } };
  }
}

/* 3. Disco — espaço livre no VPS (usa `df` do Linux) */
function checarDisco() {
  try {
    const output = execSync('df -B1 /', { encoding: 'utf8', timeout: 3000 });
    const linhas = output.trim().split('\n');
    if (linhas.length < 2) throw new Error('resposta inesperada do df');
    // Linha 2: Filesystem 1B-blocks Used Available Use% Mounted
    const partes = linhas[1].split(/\s+/);
    const total = parseInt(partes[1], 10);
    const usado = parseInt(partes[2], 10);
    const livre = parseInt(partes[3], 10);
    const percentUsado = Math.round((usado / total) * 100);

    let status = 'ok';
    if (percentUsado >= 90) status = 'erro';
    else if (percentUsado >= 75) status = 'warn';

    return {
      status,
      detalhes: {
        total: formatarBytes(total),
        usado: formatarBytes(usado),
        livre: formatarBytes(livre),
        percentUsado,
      }
    };
  } catch (e) {
    return { status: 'warn', detalhes: { erro: e.message } };
  }
}

/* 4. Arquivo de dados — dados.json existe e é legível */
function checarArquivoDados() {
  if (!config.saveFile) {
    return { status: 'warn', detalhes: { erro: 'saveFile não configurado' } };
  }
  try {
    if (!fs.existsSync(config.saveFile)) {
      return { status: 'erro', detalhes: { erro: 'dados.json não encontrado' } };
    }
    const stat = fs.statSync(config.saveFile);
    const raw = fs.readFileSync(config.saveFile, 'utf8');
    const dados = JSON.parse(raw);
    const qtdFaturas     = Array.isArray(dados?.dados) ? dados.dados.length : 0;
    const qtdConferidas  = Array.isArray(dados?.conferidas) ? dados.conferidas.length : 0;
    const qtdViasCliente = Array.isArray(dados?.viasCliente) ? dados.viasCliente.length : 0;
    const horasDesdeMod  = Math.floor((Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60));

    return {
      status: 'ok',
      detalhes: {
        tamanho: formatarBytes(stat.size),
        ultimaModificacao: stat.mtime.toISOString(),
        horasDesdeModificacao: horasDesdeMod,
        qtdFaturas,
        qtdConferidas,
        qtdViasCliente,
      }
    };
  } catch (e) {
    return { status: 'erro', detalhes: { erro: 'dados.json ilegível: ' + e.message } };
  }
}

/* 5. Backups locais (FaturasBackup) — último arquivo e idade */
function checarBackupsLocais() {
  if (!config.backupDir || !fs.existsSync(config.backupDir)) {
    return { status: 'warn', detalhes: { erro: 'pasta de backup não encontrada' } };
  }
  try {
    const arquivos = fs.readdirSync(config.backupDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(config.backupDir, f));
        return { nome: f, modificadoEm: stat.mtime, tamanho: stat.size };
      })
      .sort((a, b) => b.modificadoEm - a.modificadoEm);

    if (arquivos.length === 0) {
      return { status: 'warn', detalhes: { erro: 'nenhum backup encontrado' } };
    }

    const maisRecente = arquivos[0];
    const horas = horasAtras(maisRecente.modificadoEm);

    let status = 'ok';
    if (horas > 24) status = 'warn';
    if (horas > 72) status = 'erro';

    return {
      status,
      detalhes: {
        quantidade: arquivos.length,
        maisRecente: maisRecente.nome,
        horasDesdeUltimo: horas,
      }
    };
  } catch (e) {
    return { status: 'warn', detalhes: { erro: e.message } };
  }
}

/* 6. Backup Google Drive — verifica log do último run */
async function checarBackupGoogleDrive() {
  // Caminho do log definido no cron do VPS
  const logFile = '/var/www/caus-faturas/backup.log';
  try {
    if (!fs.existsSync(logFile)) {
      return { status: 'warn', detalhes: { erro: 'log de backup não encontrado (verifique cron)' } };
    }
    const stat = fs.statSync(logFile);
    const horas = horasAtras(stat.mtime);

    // Lê últimas linhas pra detectar erro/sucesso
    const raw = fs.readFileSync(logFile, 'utf8');
    const ultimasLinhas = raw.split('\n').slice(-20).join('\n');
    const rodouOk = ultimasLinhas.includes('Concluído com sucesso');
    const teveErro = ultimasLinhas.includes('Erro geral') || ultimasLinhas.includes('❌');

    let status = 'ok';
    if (horas > 36) status = 'warn';   // backup é diário às 3am → +36h já tá atrasado
    if (horas > 60) status = 'erro';
    if (teveErro && !rodouOk) status = 'erro';

    return {
      status,
      detalhes: {
        ultimoRun: stat.mtime.toISOString(),
        horasDesdeUltimo: horas,
        sucesso: rodouOk && !teveErro,
      }
    };
  } catch (e) {
    return { status: 'warn', detalhes: { erro: e.message } };
  }
}

/* 6b. Backup Backblaze B2 — verifica log do último run */
async function checarBackupBackblaze() {
  // Caminho do log definido no cron do VPS (cron 0 4 * * *)
  const logFile = '/var/www/caus-faturas/backup-backblaze.log';
  try {
    if (!fs.existsSync(logFile)) {
      return { status: 'warn', detalhes: { erro: 'log de backup Backblaze não encontrado (verifique cron)' } };
    }
    const stat = fs.statSync(logFile);
    const horas = horasAtras(stat.mtime);

    // Lê últimas linhas pra detectar erro/sucesso
    const raw = fs.readFileSync(logFile, 'utf8');
    const ultimasLinhas = raw.split('\n').slice(-30).join('\n');
    const rodouOk = ultimasLinhas.includes('Concluído com sucesso') || ultimasLinhas.includes('✓ Backup');
    const teveErro = ultimasLinhas.includes('Erro geral') || ultimasLinhas.includes('❌') || ultimasLinhas.includes('Error');

    // Tenta extrair quantidade de arquivos do log (último run)
    let qtdArquivos = null;
    let tamanhoTotal = null;
    const matchQtd = ultimasLinhas.match(/(\d+)\s+arquivo[s]?\s+(?:enviado|sincronizad)/i);
    if (matchQtd) qtdArquivos = parseInt(matchQtd[1], 10);
    const matchTam = ultimasLinhas.match(/total[:\s]+([\d.,]+\s*[KMG]?B)/i);
    if (matchTam) tamanhoTotal = matchTam[1];

    let status = 'ok';
    if (horas > 36) status = 'warn';   // backup é diário às 4am → +36h já tá atrasado
    if (horas > 60) status = 'erro';
    if (teveErro && !rodouOk) status = 'erro';

    return {
      status,
      detalhes: {
        ultimoRun: stat.mtime.toISOString(),
        horasDesdeUltimo: horas,
        sucesso: rodouOk && !teveErro,
        ...(qtdArquivos != null && { qtdArquivos }),
        ...(tamanhoTotal && { tamanhoTotal }),
      }
    };
  } catch (e) {
    return { status: 'warn', detalhes: { erro: e.message } };
  }
}

/* 7. Socket.io — quantos clientes conectados */
function checarSocketClients() {
  if (!config.io) {
    return { status: 'warn', detalhes: { erro: 'io não configurado' } };
  }
  try {
    const clientes = config.io.sockets.sockets.size || 0;
    return {
      status: 'ok',
      detalhes: { conectados: clientes }
    };
  } catch (e) {
    return { status: 'warn', detalhes: { erro: e.message } };
  }
}

/* ── AGREGADOR ────────────────────────────────────────────────── */

async function checarTudo() {
  const checks = {
    servidor:        checarServidor(),
    mongodb:         await checarMongoDB(),
    disco:           checarDisco(),
    dadosArquivo:    checarArquivoDados(),
    backupsLocais:   checarBackupsLocais(),
    backupGoogle:    await checarBackupGoogleDrive(),
    backupBackblaze: await checarBackupBackblaze(),
    socketClients:   checarSocketClients(),
  };

  // Status geral: pior entre os checks
  const prioridade = { ok: 0, warn: 1, erro: 2 };
  let statusGeral = 'ok';
  for (const c of Object.values(checks)) {
    if (prioridade[c.status] > prioridade[statusGeral]) {
      statusGeral = c.status;
    }
  }

  return {
    statusGeral,
    verificadoEm: new Date().toISOString(),
    checks,
  };
}

/* ── HANDLERS HTTP ────────────────────────────────────────────── */

/* GET /saude
   Resposta simples pra UptimeRobot:
   - HTTP 200 se tudo ok ou warn (sistema funcional)
   - HTTP 500 se qualquer check crítico deu erro
   Body: { ok, status, erros? } */
async function handlerSaude(req, res) {
  try {
    const resultado = await checarTudo();
    const criticos = Object.entries(resultado.checks)
      .filter(([_, c]) => c.status === 'erro')
      .map(([nome]) => nome);

    const httpStatus = resultado.statusGeral === 'erro' ? 500 : 200;
    res.status(httpStatus).json({
      ok: resultado.statusGeral !== 'erro',
      status: resultado.statusGeral,
      verificadoEm: resultado.verificadoEm,
      ...(criticos.length > 0 && { checksComErro: criticos }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, status: 'erro', erro: e.message });
  }
}

/* GET /saude/detalhe — JSON completo pro dashboard */
async function handlerDetalhe(req, res) {
  try {
    const resultado = await checarTudo();
    res.status(200).json(resultado);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
}

module.exports = {
  inicializar,
  handlerSaude,
  handlerDetalhe,
  checarTudo,
};
