#!/usr/bin/env bash
set -e

echo "=== Trula Twitch Bot Deployment ==="

# Check Node.js
if command -v node >/dev/null 2>&1; then
    echo "Node.js detected: $(node -v)"
else
    echo "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

# Install dependencies
npm install --omit=dev

# Check .env
if [ ! -f .env ]; then
    echo "Creating .env from example..."
    cp .env.example .env
    echo "⚠️ Пожалуйста, проверьте и настройте токен в .env!"
fi

# Manage process with PM2 or Docker
if command -v pm2 >/dev/null 2>&1; then
    echo "Restarting via PM2..."
    pm2 start ecosystem.config.cjs || pm2 restart ecosystem.config.cjs
    pm2 save
    echo "✅ Бот запущен через PM2!"
elif command -v docker >/dev/null 2>&1 && command -v docker compose >/dev/null 2>&1; then
    echo "Starting via Docker Compose..."
    docker compose up -d --build
    echo "✅ Бот запущен через Docker Compose!"
else
    echo "Installing PM2 globally..."
    npm install -g pm2
    pm2 start ecosystem.config.cjs
    pm2 save
    pm2 startup || true
    echo "✅ PM2 установлен и бот запущен!"
fi

echo "=== Развертывание завершено! ==="
