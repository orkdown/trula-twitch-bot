$Host.UI.RawUI.WindowTitle = "Trula Twitch Bot"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   TRULA TWITCH CHAT BOT DLYA STRIMA    " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js не найден в системе! Установите Node.js с https://nodejs.org/" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "Запуск бота..." -ForegroundColor Yellow
node index.js
