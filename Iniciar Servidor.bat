@echo off
title Organograma KL - teste local
cd /d "%~dp0"
rem Servidor de TESTE no seu computador (usa SQLite em dados\dev.sqlite,
rem nao mexe no banco da HostGator). Precisa do PHP instalado.
set KL_DEV=1
for %%i in (php.exe) do set "PHPDIR=%%~dp$PATH:i"
if "%PHPDIR%"=="" (
  echo PHP nao encontrado. Instale o PHP para testar localmente.
  pause
  exit /b 1
)
if not exist "dados\dev.sqlite" (
  echo Primeira vez: o navegador vai abrir o instalador para criar o usuario admin de teste.
  start "" "http://localhost:8888/install.php"
) else (
  start "" "http://localhost:8888/"
)
echo Servidor de teste rodando em http://localhost:8888  -  feche esta janela para parar.
php -d extension_dir="%PHPDIR%ext" -d extension=pdo_sqlite -d extension=mbstring -d extension=openssl -S localhost:8888
pause
