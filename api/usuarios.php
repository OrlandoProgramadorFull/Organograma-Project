<?php
/* Gestão de usuários (somente admin).
   GET                                        → lista
   POST {usuario, nome, senha, papel}         → cria
   PUT  {id, nome?, papel?, ativo?, senha?}   → altera
   DELETE ?id=N                               → exclui */

require __DIR__ . '/bootstrap.php';

$admin = require_papel('admin');
$pdo = db();

function valida_papel($papel): string {
  if (!is_string($papel) || !isset(PAPEIS[$papel])) json_error(422, 'Perfil inválido.');
  return $papel;
}

function valida_senha($senha): string {
  $senha = (string)$senha;
  if (strlen($senha) < 8) json_error(422, 'A senha precisa ter pelo menos 8 caracteres.');
  return $senha;
}

/* Impede que o sistema fique sem nenhum admin ativo. */
function garante_outro_admin(PDO $pdo, int $id): void {
  $st = $pdo->prepare("SELECT COUNT(*) FROM usuarios WHERE papel = 'admin' AND ativo = 1 AND id <> ?");
  $st->execute([$id]);
  if ((int)$st->fetchColumn() === 0) json_error(422, 'É preciso manter pelo menos um administrador ativo.');
}

function busca_usuario(PDO $pdo, int $id): array {
  $st = $pdo->prepare('SELECT id, usuario, nome, papel, ativo FROM usuarios WHERE id = ?');
  $st->execute([$id]);
  $row = $st->fetch();
  if (!$row) json_error(404, 'Usuário não encontrado.');
  return $row;
}

if (metodo() === 'GET') {
  $rows = $pdo->query('SELECT id, usuario, nome, papel, ativo, criado_em, ultimo_login FROM usuarios ORDER BY nome')->fetchAll();
  foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['ativo'] = (bool)$r['ativo']; }
  json_out(200, ['usuarios' => $rows, 'eu' => $admin['id']]);
}

require_csrf();

if (metodo() === 'POST') {
  $b = read_json_body();
  $usuario = strtolower(clean_str($b['usuario'] ?? '', 60));
  $nome = clean_str($b['nome'] ?? '', 120);
  if (!preg_match('/^[a-z0-9._-]{3,60}$/', $usuario)) json_error(422, 'Usuário deve ter 3+ caracteres: letras sem acento, números, ponto, hífen ou _.');
  if ($nome === '') json_error(422, 'Informe o nome.');
  $papel = valida_papel($b['papel'] ?? 'leitor');
  $senha = valida_senha($b['senha'] ?? '');

  $st = $pdo->prepare('SELECT COUNT(*) FROM usuarios WHERE usuario = ?');
  $st->execute([$usuario]);
  if ((int)$st->fetchColumn() > 0) json_error(422, 'Já existe um usuário com esse login.');

  $pdo->prepare('INSERT INTO usuarios (usuario, nome, senha_hash, papel, ativo, criado_em) VALUES (?, ?, ?, ?, 1, ?)')
      ->execute([$usuario, $nome, password_hash($senha, PASSWORD_DEFAULT), $papel, agora()]);
  json_out(201, ['ok' => true]);
}

if (metodo() === 'PUT') {
  $b = read_json_body();
  $id = (int)($b['id'] ?? 0);
  $alvo = busca_usuario($pdo, $id);
  $sets = [];
  $vals = [];

  if (array_key_exists('nome', $b)) {
    $nome = clean_str($b['nome'], 120);
    if ($nome === '') json_error(422, 'Informe o nome.');
    $sets[] = 'nome = ?'; $vals[] = $nome;
  }
  if (array_key_exists('papel', $b)) {
    $papel = valida_papel($b['papel']);
    if ($alvo['papel'] === 'admin' && $papel !== 'admin') garante_outro_admin($pdo, $id);
    $sets[] = 'papel = ?'; $vals[] = $papel;
  }
  if (array_key_exists('ativo', $b)) {
    $ativo = !empty($b['ativo']);
    if (!$ativo && $id === $admin['id']) json_error(422, 'Você não pode desativar o seu próprio usuário.');
    if (!$ativo && $alvo['papel'] === 'admin') garante_outro_admin($pdo, $id);
    $sets[] = 'ativo = ?'; $vals[] = $ativo ? 1 : 0;
  }
  if (array_key_exists('senha', $b)) {
    $sets[] = 'senha_hash = ?'; $vals[] = password_hash(valida_senha($b['senha']), PASSWORD_DEFAULT);
  }
  if (!$sets) json_error(422, 'Nada para alterar.');

  $vals[] = $id;
  $pdo->prepare('UPDATE usuarios SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($vals);
  json_out(200, ['ok' => true]);
}

if (metodo() === 'DELETE') {
  $id = (int)($_GET['id'] ?? 0);
  $alvo = busca_usuario($pdo, $id);
  if ($id === $admin['id']) json_error(422, 'Você não pode excluir o seu próprio usuário.');
  if ($alvo['papel'] === 'admin') garante_outro_admin($pdo, $id);
  $pdo->prepare('DELETE FROM usuarios WHERE id = ?')->execute([$id]);
  json_out(200, ['ok' => true]);
}

json_error(405, 'Método não permitido.');
