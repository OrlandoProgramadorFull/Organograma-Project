<?php
/* ==========================================================================
   KL Rent a Car — Organograma 2026 — instalador
   Roda uma única vez: grava a configuração do banco (api/config.php), cria
   as tabelas, carrega o organograma inicial (dados/org-data.json) e cria o
   primeiro administrador. Depois de instalado ele se bloqueia sozinho; por
   segurança, apague este arquivo do servidor ao terminar.
   ========================================================================== */

declare(strict_types=1);
require __DIR__ . '/api/bootstrap.php';
restore_exception_handler();
start_session();

$FUSOS = [
  'America/Cuiaba' => 'Mato Grosso / Mato Grosso do Sul (UTC−4)',
  'America/Sao_Paulo' => 'Horário de Brasília (UTC−3)',
  'America/Manaus' => 'Amazonas / Rondônia / Roraima (UTC−4)',
  'America/Rio_Branco' => 'Acre (UTC−5)',
];

$cfg = config_or_null();
$precisaBanco = $cfg === null;
$erro = '';
$sucesso = false;
$jaInstalado = false;

/* Já instalado = existe configuração e pelo menos um usuário no banco. */
if ($cfg !== null) {
  try {
    $n = connect_db($cfg['db'])->query('SELECT COUNT(*) FROM usuarios')->fetchColumn();
    $jaInstalado = (int)$n > 0;
  } catch (PDOException $e) {
    // tabelas ainda não existem: segue com a instalação
  }
}

$v = fn(string $k, string $padrao = '') => htmlspecialchars((string)($_POST[$k] ?? $padrao), ENT_QUOTES, 'UTF-8');

if (!$jaInstalado && metodo() === 'POST') {
  try {
    if (!hash_equals($_SESSION['csrf'], (string)($_POST['csrf'] ?? ''))) throw new RuntimeException('Formulário expirado. Recarregue a página e tente de novo.');

    $nome = clean_str($_POST['admin_nome'] ?? '', 120);
    $usuario = strtolower(clean_str($_POST['admin_usuario'] ?? '', 60));
    $senha = (string)($_POST['admin_senha'] ?? '');
    if ($nome === '') throw new RuntimeException('Informe o nome do administrador.');
    if (!preg_match('/^[a-z0-9._-]{3,60}$/', $usuario)) throw new RuntimeException('Usuário deve ter 3+ caracteres: letras sem acento, números, ponto, hífen ou _.');
    if (strlen($senha) < 8) throw new RuntimeException('A senha precisa ter pelo menos 8 caracteres.');
    if ($senha !== (string)($_POST['admin_senha2'] ?? '')) throw new RuntimeException('As senhas não conferem.');

    if ($precisaBanco) {
      $fuso = (string)($_POST['fuso'] ?? 'America/Sao_Paulo');
      if (!isset($FUSOS[$fuso])) $fuso = 'America/Sao_Paulo';
      $cfg = [
        'db' => [
          'driver' => 'mysql',
          'host' => clean_str($_POST['db_host'] ?? 'localhost', 120) ?: 'localhost',
          'port' => 3306,
          'name' => clean_str($_POST['db_name'] ?? '', 64),
          'user' => clean_str($_POST['db_user'] ?? '', 64),
          'pass' => (string)($_POST['db_pass'] ?? ''),
        ],
        'fuso' => $fuso,
        'acesso_publico_leitura' => false,
      ];
      if ($cfg['db']['name'] === '' || $cfg['db']['user'] === '') throw new RuntimeException('Informe o nome do banco e o usuário do banco.');
      date_default_timezone_set($fuso);
    }

    try {
      $pdo = connect_db($cfg['db']);
    } catch (PDOException $e) {
      throw new RuntimeException('Não consegui conectar no banco de dados. Confira nome do banco, usuário e senha (e se o usuário foi adicionado ao banco com TODOS OS PRIVILÉGIOS no cPanel). Detalhe: ' . $e->getMessage());
    }

    if ($precisaBanco) {
      $conteudo = "<?php\n/* Configuração gerada pelo install.php em " . date('d/m/Y H:i') . ".\n   Guarde em segredo: contém a senha do banco de dados. */\nreturn " . var_export($cfg, true) . ";\n";
      if (@file_put_contents(config_path(), $conteudo, LOCK_EX) === false) {
        throw new RuntimeException('Não consegui gravar api/config.php. Crie esse arquivo manualmente a partir de api/config.exemplo.php e rode o instalador de novo.');
      }
      @chmod(config_path(), 0640);
    }

    foreach (schema_sql($cfg['db']['driver'] ?? 'mysql') as $sql) $pdo->exec($sql);

    $pdo->beginTransaction();
    if (!$pdo->query('SELECT COUNT(*) FROM organograma')->fetchColumn()) {
      $seed = json_decode((string)@file_get_contents(APP_ROOT . '/dados/org-data.json'), true);
      $dados = sanitize_org($seed);
      $json = json_encode($dados, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
      $pdo->prepare('INSERT INTO organograma (id, dados, versao, atualizado_em, atualizado_por) VALUES (1, ?, 1, ?, ?)')->execute([$json, agora(), $nome]);
      $pdo->prepare('INSERT INTO historico (versao, dados, descricao, usuario, criado_em) VALUES (1, ?, ?, ?, ?)')->execute([$json, 'Instalação inicial (org-data.json)', $nome, agora()]);
    }
    $pdo->prepare("INSERT INTO usuarios (usuario, nome, senha_hash, papel, ativo, criado_em) VALUES (?, ?, ?, 'admin', 1, ?)")
        ->execute([$usuario, $nome, password_hash($senha, PASSWORD_DEFAULT), agora()]);
    $pdo->commit();
    $sucesso = true;
  } catch (Throwable $e) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    $erro = $e instanceof RuntimeException || $e instanceof InvalidArgumentException ? $e->getMessage() : 'Erro inesperado: ' . $e->getMessage();
  }
}
?><!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Instalação — Organograma KL</title>
<style>
  :root{ --ink:#0B1420; --navy:#0A2A4D; --blue:#14539A; --blue-bright:#2E86E0; --muted:#5B6B80; --danger:#C23B3B; --ok:#1E7A46; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:'Segoe UI', Calibri, Arial, sans-serif; background:linear-gradient(135deg, var(--navy), var(--blue)); color:#101826; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px; }
  .card{ background:#fff; border-radius:12px; padding:28px; width:min(560px, 100%); border-top:5px solid var(--blue-bright); box-shadow:0 14px 50px rgba(0,0,0,.35); }
  h1{ margin:0 0 4px; font-size:1.4rem; color:var(--navy); letter-spacing:.03em; text-transform:uppercase; }
  .sub{ margin:0 0 20px; color:var(--muted); font-size:.9rem; }
  fieldset{ border:1.5px solid #DCE7F3; border-radius:8px; padding:14px 16px 4px; margin:0 0 16px; }
  legend{ font-weight:700; color:var(--blue); font-size:.8rem; text-transform:uppercase; letter-spacing:.06em; padding:0 6px; }
  label{ display:block; font-size:.75rem; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; margin-bottom:5px; }
  input, select{ width:100%; padding:9px 12px; border-radius:6px; border:1.5px solid #CBDCEF; font-size:.95rem; margin-bottom:12px; font-family:inherit; }
  input:focus, select:focus{ outline:none; border-color:var(--blue-bright); box-shadow:0 0 0 3px rgba(46,134,224,.18); }
  .hint{ font-size:.78rem; color:var(--muted); margin:-6px 0 12px; line-height:1.4; }
  .row{ display:flex; gap:12px; } .row > div{ flex:1; }
  button, .btn{ display:inline-block; background:var(--blue-bright); color:#fff; border:0; border-radius:6px; padding:11px 18px; font-weight:700; font-size:.95rem; cursor:pointer; text-decoration:none; width:100%; text-align:center; }
  button:hover, .btn:hover{ background:#4A97E8; }
  .msg{ padding:12px 14px; border-radius:8px; margin-bottom:16px; font-size:.9rem; line-height:1.45; }
  .msg.erro{ background:#FBE6E4; color:var(--danger); }
  .msg.ok{ background:#E3F4EA; color:var(--ok); }
  code{ background:#EEF3F9; padding:1px 5px; border-radius:4px; }
  @media (max-width:520px){ .row{ flex-direction:column; gap:0; } .card{ padding:22px 18px; } }
</style>
</head>
<body>
<main class="card">
  <h1>Organograma KL</h1>
  <p class="sub">Instalação do sistema no servidor</p>

<?php if ($sucesso): ?>
  <div class="msg ok"><strong>Tudo pronto!</strong> Banco de dados criado, organograma inicial carregado e usuário administrador criado.</div>
  <p class="sub">Por segurança, <strong>apague o arquivo <code>install.php</code></strong> do servidor (pelo Gerenciador de Arquivos do cPanel).</p>
  <a class="btn" href="./">Abrir o organograma</a>

<?php elseif ($jaInstalado): ?>
  <div class="msg ok">O sistema já está instalado.</div>
  <p class="sub">Este instalador fica bloqueado depois da primeira instalação. Por segurança, <strong>apague o arquivo <code>install.php</code></strong> do servidor.</p>
  <a class="btn" href="./">Abrir o organograma</a>

<?php else: ?>
  <?php if ($erro): ?><div class="msg erro"><?= htmlspecialchars($erro, ENT_QUOTES, 'UTF-8') ?></div><?php endif; ?>
  <form method="post" autocomplete="off">
    <input type="hidden" name="csrf" value="<?= htmlspecialchars($_SESSION['csrf'], ENT_QUOTES, 'UTF-8') ?>">

    <?php if ($precisaBanco): ?>
    <fieldset>
      <legend>Banco de dados MySQL</legend>
      <p class="hint">Crie o banco e o usuário no cPanel em <strong>Bancos de dados MySQL</strong> e adicione o usuário ao banco com <strong>todos os privilégios</strong>. Na HostGator os nomes vêm com o prefixo da sua conta, ex.: <code>klrent_organograma</code>.</p>
      <label for="db_name">Nome do banco</label>
      <input id="db_name" name="db_name" required value="<?= $v('db_name') ?>" placeholder="ex.: klrent_organograma">
      <div class="row">
        <div><label for="db_user">Usuário do banco</label>
          <input id="db_user" name="db_user" required value="<?= $v('db_user') ?>" placeholder="ex.: klrent_orgadmin"></div>
        <div><label for="db_pass">Senha do banco</label>
          <input id="db_pass" name="db_pass" type="password" value="<?= $v('db_pass') ?>"></div>
      </div>
      <div class="row">
        <div><label for="db_host">Servidor</label>
          <input id="db_host" name="db_host" value="<?= $v('db_host', 'localhost') ?>"></div>
        <div><label for="fuso">Fuso horário</label>
          <select id="fuso" name="fuso">
            <?php foreach ($FUSOS as $id => $rotulo): ?>
              <option value="<?= $id ?>" <?= ($_POST['fuso'] ?? 'America/Cuiaba') === $id ? 'selected' : '' ?>><?= htmlspecialchars($rotulo) ?></option>
            <?php endforeach; ?>
          </select></div>
      </div>
    </fieldset>
    <?php endif; ?>

    <fieldset>
      <legend>Primeiro administrador</legend>
      <label for="admin_nome">Seu nome</label>
      <input id="admin_nome" name="admin_nome" required value="<?= $v('admin_nome') ?>" placeholder="ex.: Maria Silva">
      <label for="admin_usuario">Login</label>
      <input id="admin_usuario" name="admin_usuario" required value="<?= $v('admin_usuario') ?>" placeholder="ex.: livio" autocapitalize="none">
      <div class="row">
        <div><label for="admin_senha">Senha</label>
          <input id="admin_senha" name="admin_senha" type="password" required minlength="8"></div>
        <div><label for="admin_senha2">Repita a senha</label>
          <input id="admin_senha2" name="admin_senha2" type="password" required minlength="8"></div>
      </div>
      <p class="hint">Mínimo de 8 caracteres. Depois você cria os demais usuários dentro do sistema.</p>
    </fieldset>

    <button type="submit">Instalar</button>
  </form>
<?php endif; ?>
</main>
</body>
</html>
