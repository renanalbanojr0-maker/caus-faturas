#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════
   CAUS Faturas — Verificar Tudo (Dia 6)
   ═══════════════════════════════════════════════════════════════
   Compara dados em TODAS as camadas (VPS, MongoDB, local, backups)
   e detecta divergências.

   USO:
     node verificar-tudo.js [--verbose]

   Pode rodar:
   - No PC local (compara local vs VPS vs Mongo)
   - No VPS (compara VPS vs Mongo vs Drive logs)

   SAÍDA:
   - ✓ verde = tudo bate
   - ⚠ amarelo = divergência pequena (dentro do esperado)
   - ✗ vermelho = divergência séria (investigar!)
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
  VPS_URL: 'http://187.124.93.190:3000',
  MONGO_URI: 'mongodb+srv://renanalbanojr0_db_user:C6HBx39A4MkRBTfl@cluster0.h4o2rnn.mongodb.net/?appName=Cluster0',
  DB_NAME: 'faturas',
  COL_NAME: 'dados',
  TIMEOUT_MS: 15000,
  LOCAL_DIR: path.join(os.homedir(), 'Documents', 'Caus Faturas'),
};

const VERBOSE = process.argv.includes('--verbose');

// ── CORES TERMINAL ────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
};

function log(msg, cor = '')       { console.log(cor + msg + c.reset); }
function ok(msg)                  { log('  ✓ ' + msg, c.green); }
function warn(msg)                { log('  ⚠ ' + msg, c.yellow); }
function err(msg)                 { log('  ✗ ' + msg, c.red); }
function info(msg)                { log('  · ' + msg, c.dim); }
function header(msg)              { log('\n' + c.bold + c.cyan + msg + c.reset); }

// ── HELPERS ───────────────────────────────────────────────────
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: CONFIG.TIMEOUT_MS }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON inválido de ${url}: ${body.substring(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function contarFaturas(dados) {
  const emAberto = Array.isArray(dados?.dados) ? dados.dados.length : 0;
  const finalizadas = Array.isArray(dados?.finalizadas) ? dados.finalizadas.length : 0;
  return { emAberto, finalizadas, total: emAberto + finalizadas };
}

function hashRapido(obj) {
  // Hash simples pra comparar conjuntos sem importar bibliotecas
  const str = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024**2) return (b/1024).toFixed(1) + ' KB';
  return (b/1024**2).toFixed(1) + ' MB';
}

// ── LEITURAS ──────────────────────────────────────────────────

async function lerVPS() {
  try {
    const dados = await fetchJSON(`${CONFIG.VPS_URL}/dados-atual`);
    return { ok: true, dados };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

async function lerSaude() {
  try {
    const s = await fetchJSON(`${CONFIG.VPS_URL}/saude/detalhe`);
    return { ok: true, saude: s };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

async function lerMongo() {
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(CONFIG.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const col = client.db(CONFIG.DB_NAME).collection(CONFIG.COL_NAME);
    const doc = await col.findOne({ _id: 'principal' });
    await client.close();
    if (!doc) return { ok: false, erro: 'documento principal não encontrado' };
    delete doc._id;
    return { ok: true, dados: doc };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

function lerLocal() {
  try {
    const saveFile = path.join(CONFIG.LOCAL_DIR, 'dados.json');
    const backupFile = path.join(CONFIG.LOCAL_DIR, 'dados.backup.json');

    const resultado = {};

    if (fs.existsSync(saveFile)) {
      try {
        resultado.principal = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
        resultado.tamanhoPrincipal = fs.statSync(saveFile).size;
      } catch (e) {
        resultado.erroPrincipal = e.message;
      }
    }

    if (fs.existsSync(backupFile)) {
      try {
        resultado.backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
        resultado.tamanhoBackup = fs.statSync(backupFile).size;
      } catch (e) {
        resultado.erroBackup = e.message;
      }
    }

    return { ok: true, ...resultado };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

function contarSnapshots() {
  const snapDir = path.join(CONFIG.LOCAL_DIR, 'snapshots');
  if (!fs.existsSync(snapDir)) return { ok: false, quantidade: 0 };
  try {
    const arquivos = fs.readdirSync(snapDir)
      .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'));
    const maisNovo = arquivos.sort().reverse()[0] || null;
    return { ok: true, quantidade: arquivos.length, maisRecente: maisNovo };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// ── COMPARAÇÕES ───────────────────────────────────────────────

function compararContagens(label, a, b, tolerancia = 0) {
  const diffAberto = Math.abs(a.emAberto - b.emAberto);
  const diffFinal  = Math.abs(a.finalizadas - b.finalizadas);

  if (diffAberto === 0 && diffFinal === 0) {
    ok(`${label}: iguais (${a.emAberto} em aberto + ${a.finalizadas} finalizadas)`);
    return 'ok';
  }

  const detalhe = `aberto: ${a.emAberto} vs ${b.emAberto} (diff ${diffAberto}), finalizadas: ${a.finalizadas} vs ${b.finalizadas} (diff ${diffFinal})`;

  if (diffAberto <= tolerancia && diffFinal <= tolerancia) {
    warn(`${label}: pequena diferença — ${detalhe}`);
    return 'warn';
  }

  err(`${label}: DIVERGÊNCIA — ${detalhe}`);
  return 'erro';
}

// ── EXECUÇÃO ──────────────────────────────────────────────────

async function main() {
  console.log(c.bold + c.cyan);
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   CAUS FATURAS — VERIFICAR TUDO                      ║');
  console.log('║   ' + new Date().toLocaleString('pt-BR').padEnd(51) + '║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(c.reset);

  let erros = 0;
  let warns = 0;

  // ── 1. VPS ────────────────────────────────────────────────
  header('[1] VPS (/dados-atual)');
  const vps = await lerVPS();
  if (!vps.ok) { err('Falha: ' + vps.erro); erros++; }
  else {
    const cnt = contarFaturas(vps.dados);
    ok(`Em aberto: ${cnt.emAberto} | Finalizadas: ${cnt.finalizadas} | Total: ${cnt.total}`);
    if (VERBOSE) info(`Hash: ${hashRapido(vps.dados)}`);
  }

  // ── 2. MongoDB ────────────────────────────────────────────
  header('[2] MongoDB Atlas');
  const mongo = await lerMongo();
  if (!mongo.ok) { err('Falha: ' + mongo.erro); erros++; }
  else {
    const cnt = contarFaturas(mongo.dados);
    ok(`Em aberto: ${cnt.emAberto} | Finalizadas: ${cnt.finalizadas} | Total: ${cnt.total}`);
    if (VERBOSE) info(`Hash: ${hashRapido(mongo.dados)}`);
  }

  // ── 3. Local (se estiver rodando no PC) ───────────────────
  header('[3] Arquivos locais (Documents\\Caus Faturas)');
  const local = lerLocal();
  if (!local.ok) { warn('Falha: ' + local.erro); warns++; }
  else if (!local.principal && !local.backup) {
    warn('Nenhum arquivo local encontrado (normal se estiver rodando no VPS).');
    warns++;
  } else {
    if (local.principal) {
      const cnt = contarFaturas(local.principal);
      ok(`dados.json: ${cnt.emAberto} + ${cnt.finalizadas} (${fmtBytes(local.tamanhoPrincipal)})`);
    }
    if (local.backup) {
      const cnt = contarFaturas(local.backup);
      ok(`dados.backup.json: ${cnt.emAberto} + ${cnt.finalizadas} (${fmtBytes(local.tamanhoBackup)})`);
      if (local.principal) {
        const h1 = hashRapido(local.principal);
        const h2 = hashRapido(local.backup);
        if (h1 === h2) ok('principal e backup são idênticos');
        else { warn('principal e backup DIFEREM — possível save em andamento'); warns++; }
      }
    }
    if (local.erroPrincipal) { err('dados.json corrompido: ' + local.erroPrincipal); erros++; }
    if (local.erroBackup) { err('dados.backup.json corrompido: ' + local.erroBackup); erros++; }
  }

  // ── 4. Snapshots ──────────────────────────────────────────
  header('[4] Snapshots locais');
  const snaps = contarSnapshots();
  if (!snaps.ok) {
    if (snaps.quantidade === 0) { warn('Pasta snapshots/ não existe (Dia 1 ainda não aplicado?)'); warns++; }
    else err('Erro: ' + snaps.erro);
  } else {
    ok(`${snaps.quantidade} snapshots disponíveis`);
    if (snaps.maisRecente) info(`Mais recente: ${snaps.maisRecente}`);
    if (snaps.quantidade < 12 && snaps.quantidade > 0) {
      warn('Poucos snapshots (esperado pelo menos 12 = 1h de uso)');
      warns++;
    }
  }

  // ── 5. Endpoint /saude ────────────────────────────────────
  header('[5] Endpoint /saude/detalhe');
  const saude = await lerSaude();
  if (!saude.ok) { warn('Falha: ' + saude.erro + ' (Dia 5 ainda não aplicado?)'); warns++; }
  else {
    const st = saude.saude.statusGeral;
    if (st === 'ok')       ok('Status geral: OK');
    else if (st === 'warn'){ warn('Status geral: WARN'); warns++; }
    else                   { err('Status geral: ERRO'); erros++; }

    // Mostra detalhes dos checks com problema
    for (const [nome, check] of Object.entries(saude.saude.checks || {})) {
      if (check.status !== 'ok') {
        const prefix = check.status === 'warn' ? '⚠' : '✗';
        log(`    ${prefix} ${nome}: ${JSON.stringify(check.detalhes)}`,
            check.status === 'warn' ? c.yellow : c.red);
        if (check.status === 'warn') warns++;
        else erros++;
      }
    }
  }

  // ── 6. Comparações cruzadas ───────────────────────────────
  header('[6] Comparações cruzadas');

  if (vps.ok && mongo.ok) {
    const res = compararContagens('VPS vs MongoDB',
      contarFaturas(vps.dados), contarFaturas(mongo.dados));
    if (res === 'erro') erros++;
    if (res === 'warn') warns++;

    const h1 = hashRapido(vps.dados);
    const h2 = hashRapido(mongo.dados);
    if (h1 === h2) ok('VPS e MongoDB: conteúdo idêntico (hash match)');
    else warn('VPS e MongoDB: contagens batem mas conteúdo difere (hashes diferentes) — pode ser ordem de campos');
  }

  if (vps.ok && local.ok && local.principal) {
    const res = compararContagens('VPS vs Local',
      contarFaturas(vps.dados), contarFaturas(local.principal), 2);
    if (res === 'erro') erros++;
    if (res === 'warn') warns++;
  }

  // ── RESUMO FINAL ──────────────────────────────────────────
  console.log('\n' + c.bold);
  console.log('═══════════════════════════════════════════════════════');
  if (erros === 0 && warns === 0) {
    log('✓ TUDO CERTO — sistema saudável e consistente', c.green + c.bold);
  } else if (erros === 0) {
    log(`⚠ ${warns} aviso(s), nenhum erro crítico`, c.yellow + c.bold);
  } else {
    log(`✗ ${erros} erro(s) e ${warns} aviso(s) — INVESTIGAR`, c.red + c.bold);
  }
  console.log('═══════════════════════════════════════════════════════');
  console.log(c.reset);

  process.exit(erros > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(c.red + '\n✗ ERRO FATAL: ' + e.message + c.reset);
  if (VERBOSE) console.error(e.stack);
  process.exit(2);
});
