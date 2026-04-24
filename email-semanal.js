/* ═══════════════════════════════════════════════════════════════
   CAUS Faturas — Email Semanal (Dia 5 parte 2)
   ═══════════════════════════════════════════════════════════════
   Roda todo domingo às 8h (cron).
   Coleta dados de saúde do sistema e envia por email pro Renan.

   USO:
     node email-semanal.js                  # roda normal
     node email-semanal.js --teste          # envia mesmo se for outro dia

   PRÉ-REQUISITOS NO .env:
     EMAIL_USER=seu@gmail.com
     EMAIL_PASS=app_password_16_chars
     EMAIL_DESTINO=destinatario@gmail.com
   ═══════════════════════════════════════════════════════════════ */

require('dotenv').config({ path: '/var/www/caus-faturas/.env' });

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const nodemailer = require('nodemailer');
const saude = require('/var/www/caus-faturas/saude');
const { MongoClient } = require('mongodb');

/* ── CONFIG ─────────────────────────────────────────────────── */
const CONFIG = {
  emailUser:     process.env.EMAIL_USER,
  emailPass:     process.env.EMAIL_PASS,
  emailDestino:  process.env.EMAIL_DESTINO || process.env.EMAIL_USER,
  mongoUri:      process.env.MONGO_URI,
  saveFile:      '/var/www/caus-faturas/dados/dados.json',
  backupDir:     '/var/www/caus-faturas/dados/FaturasBackup',
  driveLogFile:  '/var/www/caus-faturas/backup.log',
  b2LogFile:     '/var/www/caus-faturas/backup-backblaze.log',
  fail2banJail:  'sshd',
};

/* ── HELPERS ────────────────────────────────────────────────── */
function fmtBytes(b) {
  if (!b || b < 1024) return (b || 0) + ' B';
  if (b < 1024**2) return (b/1024).toFixed(1) + ' KB';
  if (b < 1024**3) return (b/1024**2).toFixed(1) + ' MB';
  return (b/1024**3).toFixed(2) + ' GB';
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function tentarComando(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/* ── COLETOR DE DADOS ───────────────────────────────────────── */
async function coletarDados() {
  const dados = {
    geradoEm: new Date(),
    sistema: {},
    backups: {},
    seguranca: {},
    faturas: {},
    alertas: [],
  };

  // ── SISTEMA ──
  saude.inicializar({
    db: null,
    io: { sockets: { sockets: new Map() } },
    saveFile: CONFIG.saveFile,
    backupDir: CONFIG.backupDir,
  });

  try {
    const client = new MongoClient(CONFIG.mongoUri);
    await client.connect();
    const col = client.db('faturas').collection('dados');
    saude.inicializar({
      db: col,
      io: { sockets: { sockets: new Map() } },
      saveFile: CONFIG.saveFile,
      backupDir: CONFIG.backupDir,
    });

    const resultadoSaude = await saude.checarTudo();
    dados.sistema = {
      statusGeral: resultadoSaude.statusGeral,
      checks: resultadoSaude.checks,
    };

    if (resultadoSaude.statusGeral !== 'ok') {
      Object.entries(resultadoSaude.checks).forEach(([nome, c]) => {
        if (c.status !== 'ok') {
          dados.alertas.push({
            categoria: 'Sistema',
            severidade: c.status,
            descricao: `Check "${nome}" reportou ${c.status}: ${JSON.stringify(c.detalhes)}`,
          });
        }
      });
    }

    // ── FATURAS ──
    const doc = await col.findOne({ _id: 'principal' });
    if (doc) {
      dados.faturas = {
        emAberto: Array.isArray(doc.dados) ? doc.dados.length : 0,
        conferidas: Array.isArray(doc.conferidas) ? doc.conferidas.length : 0,
        viasCliente: Array.isArray(doc.viasCliente) ? doc.viasCliente.length : 0,
      };
    }

    await client.close();
  } catch (e) {
    dados.alertas.push({
      categoria: 'MongoDB',
      severidade: 'erro',
      descricao: 'Falha ao conectar: ' + e.message,
    });
  }

  // ── BACKUPS ──
  function analisarLog(arquivo, nomeBackup) {
    if (!fs.existsSync(arquivo)) {
      return { rodouRecente: false, ultimoRun: null, sucesso: false, erro: 'log não encontrado' };
    }
    const stat = fs.statSync(arquivo);
    const idadeHoras = Math.floor((Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60));
    const conteudo = fs.readFileSync(arquivo, 'utf8');
    const ultimas = conteudo.split('\n').slice(-30).join('\n');

    const sucesso = ultimas.includes('Concluído com sucesso') || ultimas.includes('Backup Backblaze concluído');
    const teveErro = ultimas.includes('Erro geral') || /❌/.test(ultimas);

    return {
      rodouRecente: idadeHoras < 36,
      ultimoRun: stat.mtime,
      idadeHoras,
      sucesso: sucesso && !teveErro,
    };
  }

  dados.backups.googleDrive = analisarLog(CONFIG.driveLogFile, 'Google Drive');
  dados.backups.backblaze   = analisarLog(CONFIG.b2LogFile, 'Backblaze B2');

  if (!dados.backups.googleDrive.sucesso) {
    dados.alertas.push({
      categoria: 'Backup',
      severidade: 'warn',
      descricao: 'Backup Google Drive não concluiu com sucesso recentemente',
    });
  }
  if (!dados.backups.backblaze.sucesso) {
    dados.alertas.push({
      categoria: 'Backup',
      severidade: 'warn',
      descricao: 'Backup Backblaze B2 não concluiu com sucesso recentemente',
    });
  }

  // ── SEGURANÇA (Fail2ban) ──
  const f2bStatus = tentarComando('fail2ban-client status sshd');
  if (f2bStatus) {
    const matchTotalFailed = f2bStatus.match(/Total failed:\s+(\d+)/);
    const matchCurrentlyBanned = f2bStatus.match(/Currently banned:\s+(\d+)/);
    const matchTotalBanned = f2bStatus.match(/Total banned:\s+(\d+)/);

    dados.seguranca.fail2ban = {
      totalTentativasFalhas: matchTotalFailed ? parseInt(matchTotalFailed[1]) : 0,
      atualmenteBanidos: matchCurrentlyBanned ? parseInt(matchCurrentlyBanned[1]) : 0,
      totalJaBanidos: matchTotalBanned ? parseInt(matchTotalBanned[1]) : 0,
    };
  }

  // ── UPTIME DO VPS ──
  dados.sistema.uptimeVPS = tentarComando('uptime -p') || 'desconhecido';

  return dados;
}

/* ── TEMPLATE HTML ──────────────────────────────────────────── */
function gerarHTML(d) {
  const cores = {
    ok:    { bg: '#d4f4dd', fg: '#1f7a3a', label: 'OK' },
    warn:  { bg: '#fff3cd', fg: '#856404', label: 'ATENÇÃO' },
    erro:  { bg: '#f8d7da', fg: '#721c24', label: 'ERRO' },
  };
  const corStatus = cores[d.sistema.statusGeral] || cores.warn;

  function checkRow(nome, check) {
    const cor = cores[check.status] || cores.warn;
    return `
      <tr>
        <td style="padding:8px 12px; border-bottom:1px solid #eee;"><strong>${escapeHtml(nome)}</strong></td>
        <td style="padding:8px 12px; border-bottom:1px solid #eee; text-align:right;">
          <span style="background:${cor.bg};color:${cor.fg};padding:3px 10px;border-radius:4px;font-size:12px;font-weight:bold;">
            ${cor.label}
          </span>
        </td>
      </tr>
    `;
  }

  function backupRow(nome, b) {
    const ok = b.sucesso && b.rodouRecente;
    const cor = ok ? cores.ok : cores.warn;
    const detalhe = b.ultimoRun
      ? `Último run: ${new Date(b.ultimoRun).toLocaleString('pt-BR')} (${b.idadeHoras}h atrás)`
      : (b.erro || 'sem informação');

    return `
      <tr>
        <td style="padding:10px 12px; border-bottom:1px solid #eee;">
          <strong>${escapeHtml(nome)}</strong><br>
          <span style="color:#666;font-size:12px;">${escapeHtml(detalhe)}</span>
        </td>
        <td style="padding:10px 12px; border-bottom:1px solid #eee; text-align:right; vertical-align:top;">
          <span style="background:${cor.bg};color:${cor.fg};padding:3px 10px;border-radius:4px;font-size:12px;font-weight:bold;">
            ${cor.label}
          </span>
        </td>
      </tr>
    `;
  }

  const alertasHTML = d.alertas.length === 0
    ? `<p style="color:#1f7a3a; padding:12px; background:#d4f4dd; border-radius:6px;">Nenhum alerta nesta semana. Sistema operando normalmente.</p>`
    : `<ul style="padding-left:20px;">${d.alertas.map(a => `
        <li style="margin-bottom:8px;">
          <strong style="color:${cores[a.severidade]?.fg || '#333'}">[${a.categoria}]</strong>
          ${escapeHtml(a.descricao)}
        </li>
      `).join('')}</ul>`;

  const semanaInicio = new Date(d.geradoEm); semanaInicio.setDate(semanaInicio.getDate() - 7);

  return `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width:680px; margin:0 auto; padding:20px; color:#222; background:#f5f5f7;">

  <div style="background:white; border-radius:12px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.08);">

    <!-- Cabeçalho -->
    <div style="background:linear-gradient(135deg, #1a1d22 0%, #2a3038 100%); color:white; padding:24px;">
      <h1 style="margin:0; font-size:22px; letter-spacing:-0.3px;">CAUS Faturas — Resumo Semanal</h1>
      <p style="margin:6px 0 0 0; font-size:13px; opacity:0.7;">
        ${semanaInicio.toLocaleDateString('pt-BR')} — ${d.geradoEm.toLocaleDateString('pt-BR')}
      </p>
    </div>

    <!-- Status geral -->
    <div style="padding:24px; border-bottom:1px solid #eee;">
      <div style="background:${corStatus.bg}; color:${corStatus.fg}; padding:16px 20px; border-radius:8px;">
        <strong style="font-size:11px; letter-spacing:1.5px; text-transform:uppercase;">Status Geral</strong><br>
        <span style="font-size:20px; font-weight:bold; display:block; margin-top:4px;">${corStatus.label}</span>
      </div>
    </div>

    <!-- Faturas -->
    <div style="padding:24px; border-bottom:1px solid #eee;">
      <h2 style="margin:0 0 14px 0; font-size:16px; color:#333;">Faturas</h2>
      <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px;">
        <div style="background:#f8f9fa; padding:14px; border-radius:8px; text-align:center;">
          <div style="font-size:24px; font-weight:bold; color:#1a73e8;">${d.faturas.emAberto || 0}</div>
          <div style="font-size:11px; color:#666; text-transform:uppercase; letter-spacing:0.5px;">Em aberto</div>
        </div>
        <div style="background:#f8f9fa; padding:14px; border-radius:8px; text-align:center;">
          <div style="font-size:24px; font-weight:bold; color:#1f7a3a;">${d.faturas.conferidas || 0}</div>
          <div style="font-size:11px; color:#666; text-transform:uppercase; letter-spacing:0.5px;">Conferidas</div>
        </div>
        <div style="background:#f8f9fa; padding:14px; border-radius:8px; text-align:center;">
          <div style="font-size:24px; font-weight:bold; color:#856404;">${d.faturas.viasCliente || 0}</div>
          <div style="font-size:11px; color:#666; text-transform:uppercase; letter-spacing:0.5px;">Vias cliente</div>
        </div>
      </div>
    </div>

    <!-- Saúde dos componentes -->
    <div style="padding:24px; border-bottom:1px solid #eee;">
      <h2 style="margin:0 0 14px 0; font-size:16px; color:#333;">Saúde dos Componentes</h2>
      <table style="width:100%; border-collapse:collapse;">
        ${Object.entries(d.sistema.checks || {}).map(([nome, check]) => checkRow(nome, check)).join('')}
      </table>
    </div>

    <!-- Backups -->
    <div style="padding:24px; border-bottom:1px solid #eee;">
      <h2 style="margin:0 0 14px 0; font-size:16px; color:#333;">Backups</h2>
      <table style="width:100%; border-collapse:collapse;">
        ${backupRow('Google Drive (3h)', d.backups.googleDrive)}
        ${backupRow('Backblaze B2 (4h)', d.backups.backblaze)}
      </table>
    </div>

    <!-- Segurança -->
    ${d.seguranca.fail2ban ? `
    <div style="padding:24px; border-bottom:1px solid #eee;">
      <h2 style="margin:0 0 14px 0; font-size:16px; color:#333;">Segurança (Fail2ban)</h2>
      <table style="width:100%; border-collapse:collapse;">
        <tr>
          <td style="padding:8px 12px; border-bottom:1px solid #eee;">Tentativas de invasão detectadas</td>
          <td style="padding:8px 12px; border-bottom:1px solid #eee; text-align:right; font-weight:bold;">${d.seguranca.fail2ban.totalTentativasFalhas}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px; border-bottom:1px solid #eee;">IPs banidos no momento</td>
          <td style="padding:8px 12px; border-bottom:1px solid #eee; text-align:right; font-weight:bold;">${d.seguranca.fail2ban.atualmenteBanidos}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;">Total de IPs já banidos</td>
          <td style="padding:8px 12px; text-align:right; font-weight:bold;">${d.seguranca.fail2ban.totalJaBanidos}</td>
        </tr>
      </table>
    </div>
    ` : ''}

    <!-- Alertas -->
    <div style="padding:24px; border-bottom:1px solid #eee;">
      <h2 style="margin:0 0 14px 0; font-size:16px; color:#333;">Alertas da Semana</h2>
      ${alertasHTML}
    </div>

    <!-- Rodapé -->
    <div style="padding:18px 24px; background:#fafafa; font-size:12px; color:#888;">
      <strong>VPS uptime:</strong> ${escapeHtml(d.sistema.uptimeVPS)}<br>
      <strong>Email gerado em:</strong> ${d.geradoEm.toLocaleString('pt-BR')}<br>
      <a href="https://appcaus.com.br/admin/saude" style="color:#1a73e8;">Ver dashboard ao vivo →</a>
    </div>
  </div>

  <p style="text-align:center; color:#999; font-size:11px; margin-top:20px;">
    CAUS Faturas — Resumo automático semanal
  </p>

</body></html>
  `;
}

/* ── ENVIO ──────────────────────────────────────────────────── */
async function enviarEmail(htmlBody, dados) {
  if (!CONFIG.emailUser || !CONFIG.emailPass) {
    throw new Error('EMAIL_USER ou EMAIL_PASS não configurados no .env');
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: CONFIG.emailUser,
      pass: CONFIG.emailPass,
    },
  });

  const corStatus = dados.sistema.statusGeral === 'ok' ? '✓' :
                    dados.sistema.statusGeral === 'warn' ? '⚠' : '✗';
  const dataStr = dados.geradoEm.toLocaleDateString('pt-BR');

  const info = await transporter.sendMail({
    from: `"CAUS Faturas" <${CONFIG.emailUser}>`,
    to: CONFIG.emailDestino,
    subject: `${corStatus} CAUS — Resumo semanal ${dataStr}`,
    html: htmlBody,
  });

  console.log(`[Email] Enviado: ${info.messageId}`);
  return info;
}

/* ── EXECUÇÃO ───────────────────────────────────────────────── */
async function main() {
  const isTeste = process.argv.includes('--teste');
  const hoje = new Date();
  const ehDomingo = hoje.getDay() === 0;

  if (!ehDomingo && !isTeste) {
    console.log('[Email] Hoje não é domingo. Use --teste pra forçar envio.');
    return;
  }

  console.log('[Email] Coletando dados...');
  const dados = await coletarDados();

  console.log(`[Email] Status: ${dados.sistema.statusGeral} | Alertas: ${dados.alertas.length}`);

  const html = gerarHTML(dados);
  await enviarEmail(html, dados);

  console.log('[Email] ✅ Enviado com sucesso!');
}

main().catch(e => {
  console.error('[Email] ❌ Erro:', e.message);
  process.exit(1);
});
