<?php
/* ==========================================================================
   KL Rent a Car — Organograma 2026 — núcleo da API
   Conexão com o banco, sessão/login, validação dos dados e respostas JSON.
   Este arquivo é incluído pelos endpoints; não é acessado diretamente.
   ========================================================================== */

declare(strict_types=1);

const APP_ROOT = __DIR__ . '/..';
const PAPEIS = ['leitor' => 1, 'editor' => 2, 'admin' => 3];
const HISTORICO_MAX = 300;          // versões guardadas no histórico
const LOGIN_MAX_FALHAS = 8;         // tentativas erradas por IP...
const LOGIN_JANELA_MIN = 15;        // ...dentro desta janela (minutos)
const SESSAO_OCIOSA_HORAS = 12;     // desloga após esse tempo sem uso

ini_set('display_errors', '0');

/* ---------- Configuração ---------- */
function is_dev(): bool {
  return getenv('KL_DEV') === '1';
}

function config_path(): string {
  return __DIR__ . '/config.php';
}

/* Retorna null quando o sistema ainda não foi instalado. */
function config_or_null(): ?array {
  static $cfg = false;
  if ($cfg !== false) return $cfg;
  if (is_dev()) {
    $cfg = [
      'db' => ['driver' => 'sqlite', 'path' => APP_ROOT . '/dados/dev.sqlite'],
      'fuso' => 'America/Cuiaba',
      'acesso_publico_leitura' => false,
    ];
  } elseif (is_file(config_path())) {
    $cfg = require config_path();
  } else {
    $cfg = null;
  }
  return $cfg;
}

function config(): array {
  $cfg = config_or_null();
  if ($cfg === null) json_error(503, 'Sistema ainda não instalado. Acesse install.php para configurar.', ['instalar' => true]);
  return $cfg;
}

function agora(): string {
  return date('Y-m-d H:i:s');
}

/* ---------- Banco de dados ---------- */
function connect_db(array $c): PDO {
  if (($c['driver'] ?? 'mysql') === 'sqlite') {
    $pdo = new PDO('sqlite:' . $c['path']);
  } else {
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $c['host'], (int)($c['port'] ?? 3306), $c['name']);
    $pdo = new PDO($dsn, $c['user'], $c['pass'], [PDO::ATTR_EMULATE_PREPARES => false]);
  }
  $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
  return $pdo;
}

function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  try {
    $pdo = connect_db(config()['db']);
  } catch (PDOException $e) {
    error_log('[organograma] falha ao conectar no banco: ' . $e->getMessage());
    json_error(500, 'Não foi possível conectar ao banco de dados.');
  }
  return $pdo;
}

function schema_sql(string $driver): array {
  if ($driver === 'sqlite') {
    return [
      "CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT NOT NULL UNIQUE,
        nome TEXT NOT NULL,
        senha_hash TEXT NOT NULL,
        papel TEXT NOT NULL DEFAULT 'leitor',
        ativo INTEGER NOT NULL DEFAULT 1,
        criado_em TEXT NOT NULL,
        ultimo_login TEXT NULL)",
      "CREATE TABLE IF NOT EXISTS organograma (
        id INTEGER PRIMARY KEY,
        dados TEXT NOT NULL,
        versao INTEGER NOT NULL,
        atualizado_em TEXT NOT NULL,
        atualizado_por TEXT NULL)",
      "CREATE TABLE IF NOT EXISTS historico (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        versao INTEGER NOT NULL,
        dados TEXT NOT NULL,
        descricao TEXT NOT NULL,
        usuario TEXT NULL,
        criado_em TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS login_tentativas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        usuario TEXT NOT NULL,
        criado_em TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_tentativas_ip ON login_tentativas (ip, criado_em)",
    ];
  }
  $opts = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
  return [
    "CREATE TABLE IF NOT EXISTS usuarios (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      usuario VARCHAR(60) NOT NULL UNIQUE,
      nome VARCHAR(120) NOT NULL,
      senha_hash VARCHAR(255) NOT NULL,
      papel VARCHAR(10) NOT NULL DEFAULT 'leitor',
      ativo TINYINT(1) NOT NULL DEFAULT 1,
      criado_em DATETIME NOT NULL,
      ultimo_login DATETIME NULL) $opts",
    "CREATE TABLE IF NOT EXISTS organograma (
      id TINYINT UNSIGNED PRIMARY KEY,
      dados LONGTEXT NOT NULL,
      versao INT UNSIGNED NOT NULL,
      atualizado_em DATETIME NOT NULL,
      atualizado_por VARCHAR(120) NULL) $opts",
    "CREATE TABLE IF NOT EXISTS historico (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      versao INT UNSIGNED NOT NULL,
      dados LONGTEXT NOT NULL,
      descricao VARCHAR(255) NOT NULL,
      usuario VARCHAR(120) NULL,
      criado_em DATETIME NOT NULL,
      INDEX idx_historico_versao (versao)) $opts",
    "CREATE TABLE IF NOT EXISTS login_tentativas (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      ip VARCHAR(45) NOT NULL,
      usuario VARCHAR(60) NOT NULL,
      criado_em DATETIME NOT NULL,
      INDEX idx_tentativas_ip (ip, criado_em)) $opts",
  ];
}

/* ---------- Respostas JSON ---------- */
function json_out(int $status, array $data): void {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

function json_error(int $status, string $msg, array $extra = []): void {
  json_out($status, ['erro' => $msg] + $extra);
}

function metodo(): string {
  return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
}

function read_json_body(): array {
  $raw = file_get_contents('php://input');
  if ($raw === '' || $raw === false) return [];
  if (strlen($raw) > 5 * 1024 * 1024) json_error(413, 'Dados grandes demais.');
  $data = json_decode($raw, true);
  if (!is_array($data)) json_error(400, 'JSON inválido.');
  return $data;
}

/* ---------- Sessão e autenticação ---------- */
function is_https(): bool {
  return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
    || (($_SERVER['SERVER_PORT'] ?? '') === '443');
}

function start_session(): void {
  if (session_status() === PHP_SESSION_ACTIVE) return;
  session_name('klorg');
  session_set_cookie_params([
    'lifetime' => 0,
    'path' => '/',
    'secure' => is_https(),
    'httponly' => true,
    'samesite' => 'Strict',
  ]);
  session_start();
  $ultimo = $_SESSION['ultimo_uso'] ?? 0;
  if (isset($_SESSION['uid']) && time() - $ultimo > SESSAO_OCIOSA_HORAS * 3600) {
    $_SESSION = [];
  }
  $_SESSION['ultimo_uso'] = time();
  if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

function current_user(): ?array {
  static $user = false;
  if ($user !== false) return $user;
  start_session();
  $user = null;
  if (!empty($_SESSION['uid'])) {
    $st = db()->prepare('SELECT id, usuario, nome, papel FROM usuarios WHERE id = ? AND ativo = 1');
    $st->execute([$_SESSION['uid']]);
    $user = $st->fetch() ?: null;
    if ($user) $user['id'] = (int)$user['id'];
    else unset($_SESSION['uid']);
  }
  return $user;
}

function require_login(): array {
  $user = current_user();
  if (!$user) json_error(401, 'Faça login para continuar.');
  return $user;
}

function require_papel(string $minimo): array {
  $user = require_login();
  if ((PAPEIS[$user['papel']] ?? 0) < PAPEIS[$minimo]) json_error(403, 'Seu usuário não tem permissão para esta ação.');
  return $user;
}

/* Toda requisição que altera algo precisa do token CSRF da sessão. */
function require_csrf(): void {
  start_session();
  $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
  if (!is_string($token) || !hash_equals($_SESSION['csrf'], $token)) {
    json_error(419, 'Sessão expirada ou inválida. Recarregue a página.');
  }
}

function client_ip(): string {
  return substr((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 45);
}

/* ---------- Validação do organograma ---------- */
function clean_str($value, int $max): string {
  if (!is_string($value) && !is_numeric($value)) return '';
  $s = preg_replace('/[\x00-\x1F\x7F]/u', ' ', (string)$value) ?? '';
  $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');
  return function_exists('mb_substr') ? mb_substr($s, 0, $max, 'UTF-8') : substr($s, 0, $max);
}

function sanitize_node($node, int $depth, array &$ids, int &$count): array {
  if (!is_array($node)) throw new InvalidArgumentException('Estrutura de área inválida.');
  if ($depth > 30) throw new InvalidArgumentException('O organograma tem níveis demais.');
  if (++$count > 5000) throw new InvalidArgumentException('O organograma tem áreas demais.');

  $id = clean_str($node['id'] ?? '', 80);
  if ($id === '' || isset($ids[$id])) throw new InvalidArgumentException("Identificador de área inválido ou repetido: \"$id\".");
  $ids[$id] = true;

  $cargo = clean_str($node['cargo'] ?? '', 150);
  if ($cargo === '') throw new InvalidArgumentException('Existe uma área sem nome.');

  $colabs = [];
  foreach ((array)($node['colaboradores'] ?? []) as $c) {
    if (is_string($c)) $c = ['nome' => $c];
    if (!is_array($c)) continue;
    $nome = clean_str($c['nome'] ?? '', 150);
    if ($nome === '') continue;
    $colabs[] = ['nome' => $nome, 'gerente' => !empty($c['gerente'])];
  }

  $filhos = [];
  foreach ((array)($node['filhos'] ?? []) as $f) {
    $filhos[] = sanitize_node($f, $depth + 1, $ids, $count);
  }

  return ['id' => $id, 'cargo' => $cargo, 'colaboradores' => $colabs, 'filhos' => $filhos];
}

function sanitize_org($data): array {
  if (!is_array($data) || !isset($data['raiz'])) throw new InvalidArgumentException('Estrutura não reconhecida (esperado objeto com "raiz").');
  $ids = [];
  $count = 0;
  return [
    'empresa' => clean_str($data['empresa'] ?? 'KL Rent a Car', 120) ?: 'KL Rent a Car',
    'atualizado_em' => clean_str($data['atualizado_em'] ?? date('Y'), 40),
    'raiz' => sanitize_node($data['raiz'], 0, $ids, $count),
  ];
}

/* ---------- Leitura/gravação do organograma ---------- */
function load_org(): array {
  $row = db()->query('SELECT dados, versao, atualizado_em, atualizado_por FROM organograma WHERE id = 1')->fetch();
  if (!$row) json_error(500, 'Organograma não encontrado no banco. Rode o install.php novamente.');
  return [
    'dados' => json_decode($row['dados'], true),
    'versao' => (int)$row['versao'],
    'atualizado_em' => $row['atualizado_em'],
    'atualizado_por' => $row['atualizado_por'],
  ];
}

/* Grava uma nova versão. Usa controle otimista: só grava se ninguém tiver
   salvo outra versão desde $versaoBase — senão responde 409 com os dados
   atuais, para o navegador recarregar em vez de sobrescrever o colega. */
function save_org(array $dados, int $versaoBase, string $descricao, string $autor): array {
  $pdo = db();
  $json = json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  $quando = agora();
  $descricao = clean_str($descricao, 255) ?: 'Alteração no organograma';

  $pdo->beginTransaction();
  try {
    $st = $pdo->prepare('UPDATE organograma SET dados = ?, versao = versao + 1, atualizado_em = ?, atualizado_por = ? WHERE id = 1 AND versao = ?');
    $st->execute([$json, $quando, $autor, $versaoBase]);
    if ($st->rowCount() !== 1) {
      $pdo->rollBack();
      json_error(409, 'Outra pessoa alterou o organograma ao mesmo tempo.', load_org());
    }
    $nova = $versaoBase + 1;
    $pdo->prepare('INSERT INTO historico (versao, dados, descricao, usuario, criado_em) VALUES (?, ?, ?, ?, ?)')
        ->execute([$nova, $json, $descricao, $autor, $quando]);

    $limite = $pdo->query('SELECT id FROM historico ORDER BY id DESC LIMIT 1 OFFSET ' . (HISTORICO_MAX - 1))->fetchColumn();
    if ($limite) $pdo->prepare('DELETE FROM historico WHERE id < ?')->execute([$limite]);

    $pdo->commit();
  } catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    throw $e;
  }
  return ['versao' => $nova, 'atualizado_em' => $quando, 'atualizado_por' => $autor];
}

/* ---------- Inicialização comum ---------- */
set_exception_handler(function (Throwable $e) {
  error_log('[organograma] ' . $e);
  json_error(500, 'Erro interno no servidor.');
});

$__cfg = config_or_null();
date_default_timezone_set($__cfg['fuso'] ?? 'America/Sao_Paulo');
