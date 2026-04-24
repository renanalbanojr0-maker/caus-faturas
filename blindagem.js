/* ═══════════════════════════════════════════════════════════════
   CAUS Faturas — Módulo de Blindagem (Dia 1)
   ═══════════════════════════════════════════════════════════════
   Protege a digitação em tempo real contra:
   - Queda de energia / PC travando
   - Corrupção de arquivo durante escrita
   - Apagar fatura por engano (snapshots)
   - Necessidade de auditoria (journal)

   Uso no main.js:
     const blindagem = require('./blindagem');
     blindagem.inicializar({
       saveFile:      path.join(baseDir, 'dados.json'),
       backupFile:    path.join(baseDir, 'dados.backup.json'),
       emergenciaFile: path.join(appData, 'dados.emergencia.json'),
       snapshotsDir:  path.join(baseDir, 'snapshots'),
       journalFile:   path.join(baseDir, 'journal.log')
     });

     await blindagem.tripleWrite(dados);
     const dados = blindagem.carregarDadosSeguro();
     blindagem.escreverJournal('update-data', { origem: 'PC1' });
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

/* ── CONFIGURAÇÃO ─────────────────────────────────────────────── */
let config = {
  saveFile:       null,   // Documents/Caus Faturas/dados.json
  backupFile:     null,   // Documents/Caus Faturas/dados.backup.json
  emergenciaFile: null,   // AppData/Roaming/CausFaturas/dados.emergencia.json
  snapshotsDir:   null,   // Documents/Caus Faturas/snapshots
  journalFile:    null,   // Documents/Caus Faturas/journal.log
  maxSnapshots:   576,    // 48h × 12 snapshots/hora (um a cada 5 min)
  maxJournalMB:   50,     // Rotaciona journal quando passar de 50MB
};

/* ── INICIALIZAÇÃO ────────────────────────────────────────────── */
function inicializar(opts) {
  Object.assign(config, opts);
  // Garante que todas as pastas existem
  [
    path.dirname(config.saveFile),
    path.dirname(config.backupFile),
    path.dirname(config.emergenciaFile),
    config.snapshotsDir,
    path.dirname(config.journalFile),
  ].forEach(p => {
    if (p && !fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });
  console.log('[Blindagem] Inicializada.');
  console.log('  • Principal:  ' + config.saveFile);
  console.log('  • Backup:     ' + config.backupFile);
  console.log('  • Emergência: ' + config.emergenciaFile);
  console.log('  • Snapshots:  ' + config.snapshotsDir);
  console.log('  • Journal:    ' + config.journalFile);
}

/* ── ESCRITA ATÔMICA ──────────────────────────────────────────────
   Escreve em .tmp, faz fsync (força gravação no disco),
   depois renomeia. Se der crash no meio, o arquivo original
   fica intacto. Impossível corromper.
   ─────────────────────────────────────────────────────────────── */
function salvarAtomico(arquivo, conteudo) {
  const tmp = arquivo + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, conteudo);
    fs.fsyncSync(fd); // força gravação física no disco
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, arquivo); // rename é atômico no SO
}

/* ── TRIPLE WRITE ─────────────────────────────────────────────────
   Grava em 3 locais simultaneamente. Se 2 corromperem,
   o 3º salva o dia. Paraleliza pra ser rápido.
   ─────────────────────────────────────────────────────────────── */
async function tripleWrite(dados) {
  const conteudo = JSON.stringify(dados);
  const locais = [
    config.saveFile,
    config.backupFile,
    config.emergenciaFile,
  ].filter(Boolean);

  const resultados = await Promise.allSettled(
    locais.map(arq => new Promise((resolve, reject) => {
      try {
        salvarAtomico(arq, conteudo);
        resolve(arq);
      } catch (e) { reject(e); }
    }))
  );

  const sucessos = resultados.filter(r => r.status === 'fulfilled').length;
  const falhas = resultados
    .map((r, i) => ({ r, arq: locais[i] }))
    .filter(x => x.r.status === 'rejected');

  falhas.forEach(f => {
    console.error(`[Blindagem] Falha ao salvar ${f.arq}:`, f.r.reason.message);
  });

  if (sucessos === 0) {
    throw new Error('Triple write falhou em TODAS as 3 localizações!');
  }

  return { sucessos, falhas: falhas.length, total: locais.length };
}

/* ── CARREGAR COM FALLBACK ────────────────────────────────────────
   Tenta ler da 1ª localização. Se falhar ou vier corrompida,
   tenta a 2ª, depois a 3ª. Retorna null se nenhuma funcionar.
   ─────────────────────────────────────────────────────────────── */
function carregarDadosSeguro() {
  const locais = [
    { arq: config.saveFile,       nome: 'principal' },
    { arq: config.backupFile,     nome: 'backup' },
    { arq: config.emergenciaFile, nome: 'emergência' },
  ].filter(l => l.arq);

  for (const { arq, nome } of locais) {
    if (!fs.existsSync(arq)) continue;
    try {
      const raw = fs.readFileSync(arq, 'utf8');
      const dados = JSON.parse(raw);
      console.log(`[Blindagem] Dados carregados da cópia ${nome} (${arq})`);
      return dados;
    } catch (e) {
      console.warn(`[Blindagem] Cópia ${nome} ilegível: ${e.message}`);
      continue;
    }
  }

  console.warn('[Blindagem] Nenhuma cópia válida encontrada — iniciando vazio.');
  return null;
}

/* ── SNAPSHOTS ────────────────────────────────────────────────────
   A cada 5 minutos, copia o arquivo principal pra pasta
   snapshots/ com timestamp. Mantém últimos N.
   Permite reverter qualquer erro nas últimas 48h.
   ─────────────────────────────────────────────────────────────── */
function timestampAgora() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}_` +
         `${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}-${String(d.getSeconds()).padStart(2,'0')}`;
}

function tirarSnapshot() {
  try {
    if (!fs.existsSync(config.saveFile)) return;
    if (!fs.existsSync(config.snapshotsDir)) {
      fs.mkdirSync(config.snapshotsDir, { recursive: true });
    }
    const nome = `snapshot_${timestampAgora()}.json`;
    const destino = path.join(config.snapshotsDir, nome);
    fs.copyFileSync(config.saveFile, destino);
    limparSnapshotsAntigos();
  } catch (e) {
    console.error('[Blindagem] Erro ao tirar snapshot:', e.message);
  }
}

function limparSnapshotsAntigos() {
  try {
    const arquivos = fs.readdirSync(config.snapshotsDir)
      .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort(); // ordem cronológica (timestamp no nome)
    if (arquivos.length > config.maxSnapshots) {
      const remover = arquivos.slice(0, arquivos.length - config.maxSnapshots);
      remover.forEach(f => {
        try { fs.unlinkSync(path.join(config.snapshotsDir, f)); }
        catch(_) {}
      });
    }
  } catch (e) {
    console.error('[Blindagem] Erro ao limpar snapshots:', e.message);
  }
}

/* Retorna lista de snapshots disponíveis, do mais novo pro mais velho */
function listarSnapshots() {
  try {
    if (!fs.existsSync(config.snapshotsDir)) return [];
    return fs.readdirSync(config.snapshotsDir)
      .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort().reverse()
      .map(f => {
        const caminho = path.join(config.snapshotsDir, f);
        const stat = fs.statSync(caminho);
        return {
          arquivo: f,
          caminho,
          tamanho: stat.size,
          criadoEm: stat.mtime,
        };
      });
  } catch (e) {
    return [];
  }
}

/* Restaura um snapshot específico (sobrescreve os 3 arquivos principais) */
async function restaurarSnapshot(arquivoSnapshot) {
  const caminho = path.isAbsolute(arquivoSnapshot)
    ? arquivoSnapshot
    : path.join(config.snapshotsDir, arquivoSnapshot);
  if (!fs.existsSync(caminho)) {
    throw new Error('Snapshot não encontrado: ' + arquivoSnapshot);
  }
  const raw = fs.readFileSync(caminho, 'utf8');
  const dados = JSON.parse(raw); // valida JSON antes de sobrescrever
  await tripleWrite(dados);
  escreverJournal('restaurar-snapshot', { snapshot: path.basename(caminho) });
  return dados;
}

/* ── JOURNAL ──────────────────────────────────────────────────────
   Log append-only de cada ação relevante. Permite reconstruir
   o histórico mesmo se os snapshots falharem.
   Rotaciona quando passa de N MB.
   ─────────────────────────────────────────────────────────────── */
function escreverJournal(acao, detalhes = {}) {
  try {
    const linha = JSON.stringify({
      timestamp: new Date().toISOString(),
      acao,
      ...detalhes
    }) + '\n';
    fs.appendFileSync(config.journalFile, linha, 'utf8');
    // Rotaciona se ficou grande demais
    try {
      const stat = fs.statSync(config.journalFile);
      if (stat.size > config.maxJournalMB * 1024 * 1024) {
        rotacionarJournal();
      }
    } catch(_) {}
  } catch (e) {
    console.error('[Blindagem] Erro ao escrever journal:', e.message);
  }
}

function rotacionarJournal() {
  try {
    const ts = timestampAgora();
    const arquivado = config.journalFile + '.' + ts;
    fs.renameSync(config.journalFile, arquivado);
    console.log('[Blindagem] Journal rotacionado: ' + arquivado);
    // Mantém só os 3 journals arquivados mais recentes
    const dir = path.dirname(config.journalFile);
    const base = path.basename(config.journalFile);
    const antigos = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.') && f !== base)
      .sort();
    if (antigos.length > 3) {
      antigos.slice(0, antigos.length - 3).forEach(f => {
        try { fs.unlinkSync(path.join(dir, f)); } catch(_) {}
      });
    }
  } catch (e) {
    console.error('[Blindagem] Erro ao rotacionar journal:', e.message);
  }
}

/* ── AGENDADORES (setInterval) ────────────────────────────────── */
let timerSnapshot = null;

function iniciarSnapshotAutomatico(intervaloMinutos = 5) {
  if (timerSnapshot) clearInterval(timerSnapshot);
  // Tira um snapshot imediatamente ao iniciar
  tirarSnapshot();
  timerSnapshot = setInterval(tirarSnapshot, intervaloMinutos * 60 * 1000);
  console.log(`[Blindagem] Snapshot automático iniciado (a cada ${intervaloMinutos} min).`);
}

function pararSnapshotAutomatico() {
  if (timerSnapshot) {
    clearInterval(timerSnapshot);
    timerSnapshot = null;
  }
}

/* ── EXPORTAÇÕES ──────────────────────────────────────────────── */
module.exports = {
  inicializar,
  tripleWrite,
  carregarDadosSeguro,
  salvarAtomico,
  tirarSnapshot,
  listarSnapshots,
  restaurarSnapshot,
  escreverJournal,
  iniciarSnapshotAutomatico,
  pararSnapshotAutomatico,
};
