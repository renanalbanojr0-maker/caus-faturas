#!/bin/bash
echo "=== Configurando VPS Caus Faturas ==="

cd /var/www/caus-faturas

# Instala dependências
echo "[1/4] Instalando pacotes npm..."
npm install compression --save

# Gera certificado SSL autoassinado
echo "[2/4] Gerando certificado SSL..."
mkdir -p ssl
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout ssl/key.pem \
  -out ssl/cert.pem \
  -subj "/C=BR/ST=ES/L=Empresa/O=Caus/CN=187.124.93.190" 2>/dev/null
echo "Certificado gerado!"

# Libera porta 443 no firewall
echo "[3/4] Liberando portas..."
ufw allow 443
ufw allow 80

# Reinicia servidor
echo "[4/4] Reiniciando servidor..."
pm2 restart caus-faturas

echo ""
echo "=== Concluido! ==="
echo "Acesse: https://187.124.93.190"
