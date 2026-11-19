<?php
/* Modelo de configuração. O install.php gera o api/config.php sozinho;
   só use este modelo se precisar criar/editar o arquivo à mão (copie para
   api/config.php e preencha). */
return [
  'db' => [
    'driver' => 'mysql',
    'host' => 'localhost',
    'port' => 3306,
    'name' => 'CPANELUSER_organograma',   // nome do banco (com o prefixo da conta)
    'user' => 'CPANELUSER_orgadmin',      // usuário do banco
    'pass' => 'SENHA_DO_BANCO',
  ],
  'fuso' => 'America/Cuiaba',             // ou 'America/Sao_Paulo'
  // true = qualquer pessoa com o link vê o organograma (sem editar) sem login
  'acesso_publico_leitura' => false,
];
