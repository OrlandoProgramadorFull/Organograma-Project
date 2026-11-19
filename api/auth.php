<?php
/* Login, logout, sessão atual e troca da própria senha.
   GET                       → { usuario|null, csrf, publico }
   POST {acao:"login", usuario, senha}
   POST {acao:"logout"}
   POST {acao:"senha", senha_atual, senha_nova} */

require __DIR__ . '/bootstrap.php';

if (metodo() === 'GET') {
  $user = current_user();
  json_out(200, [
    'usuario' => $user,
    'csrf' => $_SESSION['csrf'],
    'publico' => !empty(config()['acesso_publico_leitura']),
  ]);
}

if (metodo() !== 'POST') json_error(405, 'Método não permitido.');

$body = read_json_body();
$acao = $body['acao'] ?? '';
require_csrf();

if ($acao === 'login') {
  $usuario = strtolower(clean_str($body['usuario'] ?? '', 60));
  $senha = (string)($body['senha'] ?? '');
  $ip = client_ip();
  $pdo = db();

  $desde = date('Y-m-d H:i:s', time() - LOGIN_JANELA_MIN * 60);
  $pdo->prepare('DELETE FROM login_tentativas WHERE criado_em < ?')->execute([$desde]);
  $st = $pdo->prepare('SELECT COUNT(*) FROM login_tentativas WHERE ip = ?');
  $st->execute([$ip]);
  if ((int)$st->fetchColumn() >= LOGIN_MAX_FALHAS) {
    json_error(429, 'Muitas tentativas erradas. Aguarde ' . LOGIN_JANELA_MIN . ' minutos e tente de novo.');
  }

  $st = $pdo->prepare('SELECT id, senha_hash FROM usuarios WHERE usuario = ? AND ativo = 1');
  $st->execute([$usuario]);
  $row = $st->fetch();

  if (!$row || !password_verify($senha, $row['senha_hash'])) {
    $pdo->prepare('INSERT INTO login_tentativas (ip, usuario, criado_em) VALUES (?, ?, ?)')->execute([$ip, $usuario, agora()]);
    usleep(400000);
    json_error(401, 'Usuário ou senha incorretos.');
  }

  if (password_needs_rehash($row['senha_hash'], PASSWORD_DEFAULT)) {
    $pdo->prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?')->execute([password_hash($senha, PASSWORD_DEFAULT), $row['id']]);
  }
  $pdo->prepare('DELETE FROM login_tentativas WHERE ip = ?')->execute([$ip]);
  $pdo->prepare('UPDATE usuarios SET ultimo_login = ? WHERE id = ?')->execute([agora(), $row['id']]);

  session_regenerate_id(true);
  $_SESSION['uid'] = (int)$row['id'];
  $_SESSION['csrf'] = bin2hex(random_bytes(32));
  json_out(200, ['usuario' => current_user(), 'csrf' => $_SESSION['csrf']]);
}

if ($acao === 'logout') {
  $_SESSION = [];
  session_regenerate_id(true);
  $_SESSION['csrf'] = bin2hex(random_bytes(32));
  json_out(200, ['ok' => true, 'csrf' => $_SESSION['csrf']]);
}

if ($acao === 'senha') {
  $user = require_login();
  $atual = (string)($body['senha_atual'] ?? '');
  $nova = (string)($body['senha_nova'] ?? '');
  if (strlen($nova) < 8) json_error(422, 'A nova senha precisa ter pelo menos 8 caracteres.');

  $st = db()->prepare('SELECT senha_hash FROM usuarios WHERE id = ?');
  $st->execute([$user['id']]);
  if (!password_verify($atual, (string)$st->fetchColumn())) json_error(422, 'A senha atual está incorreta.');

  db()->prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?')->execute([password_hash($nova, PASSWORD_DEFAULT), $user['id']]);
  json_out(200, ['ok' => true]);
}

json_error(400, 'Ação desconhecida.');
