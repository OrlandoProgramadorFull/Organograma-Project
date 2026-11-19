<?php
/* Histórico de versões do organograma.
   GET               → lista das últimas versões (sem os dados)
   GET ?id=N         → uma versão completa (para baixar/conferir)
   POST {id, versao_base} → restaura aquela versão como uma nova versão (editor/admin) */

require __DIR__ . '/bootstrap.php';

if (metodo() === 'GET') {
  require_login();
  if (isset($_GET['id'])) {
    $st = db()->prepare('SELECT id, versao, dados, descricao, usuario, criado_em FROM historico WHERE id = ?');
    $st->execute([(int)$_GET['id']]);
    $row = $st->fetch();
    if (!$row) json_error(404, 'Versão não encontrada.');
    $row['dados'] = json_decode($row['dados'], true);
    json_out(200, $row);
  }
  $rows = db()->query('SELECT id, versao, descricao, usuario, criado_em FROM historico ORDER BY id DESC LIMIT 200')->fetchAll();
  foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['versao'] = (int)$r['versao']; }
  json_out(200, ['versoes' => $rows]);
}

if (metodo() === 'POST') {
  $user = require_papel('editor');
  require_csrf();
  $body = read_json_body();
  $st = db()->prepare('SELECT versao, dados, criado_em FROM historico WHERE id = ?');
  $st->execute([(int)($body['id'] ?? 0)]);
  $row = $st->fetch();
  if (!$row) json_error(404, 'Versão não encontrada.');

  $dados = json_decode($row['dados'], true);
  $quando = date('d/m/Y H:i', strtotime($row['criado_em']));
  $res = save_org($dados, (int)($body['versao_base'] ?? -1), "Restaurou a versão {$row['versao']} ({$quando})", $user['nome']);
  json_out(200, $res + ['dados' => $dados]);
}

json_error(405, 'Método não permitido.');
