const {google} = require('googleapis');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FOLDER_ID = '166tyuiYm4Qxd5DJJ_JOtHshAJQz6CEzy';
const CREDS = JSON.parse(fs.readFileSync('/var/www/caus-faturas/oauth-credentials.json'));
const TOKEN = JSON.parse(fs.readFileSync('/var/www/caus-faturas/token-drive.json'));
const {client_id, client_secret} = CREDS.installed;

const auth = new google.auth.OAuth2(client_id, client_secret, 'urn:ietf:wg:oauth:2.0:oob');
auth.setCredentials(TOKEN);
auth.on('tokens', tokens => {
  if(tokens.refresh_token){
    const t = {...TOKEN, ...tokens};
    fs.writeFileSync('/var/www/caus-faturas/token-drive.json', JSON.stringify(t));
  }
});

const drive = google.drive({ version: 'v3', auth });

/* ── CAMINHOS ── */
const DADOS_DIR   = '/var/www/caus-faturas/dados';
const DADOS_FILE  = path.join(DADOS_DIR, 'dados.json');
const FATURAS_DIR = path.join(DADOS_DIR, 'FaturasPDF');
const TMP_DIR     = '/tmp';

/* ── HELPERS ── */
async function enviarArquivo(caminho, nome, mimeType){
  const response = await drive.files.create({
    requestBody: { name: nome, parents: [FOLDER_ID] },
    media: { mimeType, body: fs.createReadStream(caminho) }
  });
  console.log(`[Backup] ✓ Enviado: ${nome} (${response.data.id})`);
  return response.data.id;
}

/* Verifica se já existe um arquivo com o nome dado na pasta do Drive */
async function arquivoExisteNoDrive(nome){
  try {
    const resp = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and name = '${nome}' and trashed = false`,
      fields: 'files(id, name)'
    });
    return (resp.data.files || []).length > 0;
  } catch(e){
    return false;
  }
}

/* Lista pastas dentro de FaturasPDF no formato DD-MM-AAAA */
function listarPastasFaturas(){
  if(!fs.existsSync(FATURAS_DIR)) return [];
  return fs.readdirSync(FATURAS_DIR).filter(nome => {
    const caminho = path.join(FATURAS_DIR, nome);
    return fs.statSync(caminho).isDirectory() && /^\d{2}-\d{2}-\d{4}$/.test(nome);
  });
}

/* Converte nome da pasta DD-MM-AAAA em Date */
function parsePastaData(nome){
  const [d, m, a] = nome.split('-').map(Number);
  return new Date(a, m - 1, d);
}

/* ══════════════════════════════════════════════════════════════
   BACKUP PRINCIPAL
   1) dados.json     → Drive (sem limpeza — fica pra sempre)
   2) PNGs em ZIP    → Drive, um zip por dia (sem limpeza — fica pra sempre)
   3) Limpa PNGs do VPS com mais de 30 dias (só o VPS, Drive guarda tudo)
   ══════════════════════════════════════════════════════════════ */
async function fazerBackup() {
  try {
    const agora = new Date();
    const dataISO = `${agora.getFullYear()}-${String(agora.getMonth()+1).padStart(2,'0')}-${String(agora.getDate()).padStart(2,'0')}`;
    const hora = `${String(agora.getHours()).padStart(2,'0')}h${String(agora.getMinutes()).padStart(2,'0')}`;

    // ═══════════════════════════════════════════════════
    // 1) BACKUP DO dados.json (Drive, sem limpeza)
    // ═══════════════════════════════════════════════════
    if(fs.existsSync(DADOS_FILE)){
      const nomeJson = `backup_${dataISO}_${hora}.json`;
      await enviarArquivo(DADOS_FILE, nomeJson, 'application/json');
    } else {
      console.log('[Backup] ⚠️ dados.json não encontrado');
    }

    // ═══════════════════════════════════════════════════
    // 2) BACKUP DAS PNGs EM ZIP (Drive, um por dia, sem limpeza)
    // ═══════════════════════════════════════════════════
    const pastasFaturas = listarPastasFaturas();
    console.log(`[Backup] ${pastasFaturas.length} pasta(s) de faturas encontradas.`);

    for(const pastaNome of pastasFaturas){
      const pastaCaminho = path.join(FATURAS_DIR, pastaNome);
      const arquivos = fs.readdirSync(pastaCaminho);
      if(arquivos.length === 0) continue;

      // Nome do zip: faturas_DD-MM-AAAA.zip (um por dia)
      const nomeZip = `faturas_${pastaNome}.zip`;

      // Se já existe no Drive, pula (cada dia é enviado uma só vez)
      // Isso permite backups durante o dia mas evita duplicar
      if(await arquivoExisteNoDrive(nomeZip)){
        console.log(`[Backup] ⏭  ${nomeZip} já existe no Drive, pulando.`);
        continue;
      }

      const zipPath = path.join(TMP_DIR, nomeZip);

      // Remove zip temporário anterior (se houver)
      if(fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

      console.log(`[Backup] 📦 Compactando ${pastaNome} (${arquivos.length} arquivos)...`);
      try {
        // Usa zip do Linux (instalado por padrão em Ubuntu/Debian)
        execSync(`cd "${FATURAS_DIR}" && zip -r -q "${zipPath}" "${pastaNome}"`);

        const tamanhoMB = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
        console.log(`[Backup] Zip gerado: ${tamanhoMB} MB`);

        await enviarArquivo(zipPath, nomeZip, 'application/zip');

        // Limpa zip temporário
        fs.unlinkSync(zipPath);
      } catch(e) {
        console.error(`[Backup] ❌ Erro no zip de ${pastaNome}:`, e.message);
        if(fs.existsSync(zipPath)){
          try { fs.unlinkSync(zipPath); } catch(_){}
        }
      }
    }

    // ═══════════════════════════════════════════════════
    // 3) LIMPA PNGs DO VPS COM MAIS DE 30 DIAS
    //    (não mexe no Drive — lá fica tudo)
    // ═══════════════════════════════════════════════════
    const trintaDiasAtras = new Date();
    trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
    trintaDiasAtras.setHours(0, 0, 0, 0);

    let pastasRemovidas = 0;
    for(const pastaNome of pastasFaturas){
      const dataPasta = parsePastaData(pastaNome);
      if(isNaN(dataPasta.getTime())) continue;

      if(dataPasta < trintaDiasAtras){
        const pastaCaminho = path.join(FATURAS_DIR, pastaNome);
        try {
          execSync(`rm -rf "${pastaCaminho}"`);
          console.log(`[Backup] 🗑  Pasta antiga removida do VPS: ${pastaNome}`);
          pastasRemovidas++;
        } catch(e) {
          console.error(`[Backup] Erro ao remover ${pastaNome}:`, e.message);
        }
      }
    }
    if(pastasRemovidas > 0){
      console.log(`[Backup] ${pastasRemovidas} pasta(s) antiga(s) removida(s) do VPS.`);
    } else {
      console.log(`[Backup] Nenhuma pasta antiga pra remover do VPS.`);
    }

    console.log('[Backup] ✅ Concluído com sucesso!');

  } catch(e) {
    console.error('[Backup] ❌ Erro geral:', e.message);
    console.error(e.stack);
  }
}

fazerBackup();
