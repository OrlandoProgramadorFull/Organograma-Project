<?php
/* Organograma atual.
   GET               → { dados, versao, atualizado_em, atualizado_por }
   GET ?meta=1       → só { versao, atualizado_em, atualizado_por } (checagem leve de atualização)
   PUT {dados, versao_base, descricao} → grava nova versão (editor/admin) */

require __DIR__ . '/bootstrap.php';

if (metodo() === 'GET') {
  if (empty(config()['acesso_publico_leitura'])) require_login();
  $org = load_org();
  if (!empty($_GET['meta'])) unset($org['dados']);
  json_out(200, $org);
}

if (metodo() === 'PUT') {
  $user = require_papel('editor');
  require_csrf();
  $body = read_json_body();
  try {
    $dados = sanitize_org($body['dados'] ?? null);
  } catch (InvalidArgumentException $e) {
    json_error(422, $e->getMessage());
  }
  $res = save_org($dados, (int)($body['versao_base'] ?? -1), (string)($body['descricao'] ?? ''), $user['nome']);
  json_out(200, $res);
}

json_error(405, 'Método não permitido.');
