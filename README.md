# Organograma KL Rent a Car — 2026

Dashboard interativo do organograma da empresa, com login, banco de dados
MySQL e histórico de alterações. Feito para rodar em hospedagem comum com
PHP + MySQL (HostGator, cPanel).

- **Front-end**: `index.html`, `style.css`, `script.js`, `vendor/` (HTML/CSS/JS puro, sem build).
- **API**: pasta `api/` (PHP 7.4+ / 8.x, sem bibliotecas externas).
- **Banco**: MySQL/MariaDB, criado automaticamente pelo `install.php`.
- **Dados iniciais**: `dados/org-data.json` (carregado só na instalação).

---

## Publicar na HostGator — passo a passo

### 1. Criar o banco de dados (cPanel)

1. Entre no **cPanel** da HostGator → **Bancos de dados MySQL**.
2. Em **Criar novo banco de dados**, digite `organograma` → **Criar banco de dados**.
   O nome final fica com o prefixo da sua conta, ex.: `klrent_organograma`. Anote.
3. Em **Usuários MySQL → Adicionar novo usuário**, crie um usuário (ex.: `orgadmin`)
   com uma senha forte (use o gerador). Anote o nome completo (ex.: `klrent_orgadmin`) e a senha.
4. Em **Adicionar usuário ao banco de dados**, escolha o usuário e o banco →
   **Adicionar** → marque **TODOS OS PRIVILÉGIOS** → **Fazer alterações**.

### 2. Ativar o HTTPS

No cPanel → **SSL/TLS Status** (ou "AutoSSL"): confira se o domínio/subdomínio
está com cadeado verde. Se não estiver, clique em **Run AutoSSL**. O sistema
redireciona tudo para `https://` (as senhas nunca trafegam sem criptografia).

### 3. Enviar os arquivos

1. cPanel → **Gerenciador de arquivos** → abra `public_html`.
   - Para usar em `seudominio.com.br/organograma`, crie a pasta `organograma` e entre nela.
   - Para usar num subdomínio (ex.: `organograma.seudominio.com.br`), crie o subdomínio
     em **Domínios** e entre na pasta dele.
2. Clique em **Carregar** e envie o arquivo **`organograma-hostgator.zip`**.
3. Clique com o botão direito no zip → **Extract** (extrair) na pasta atual. Depois apague o zip.
4. Confira se os arquivos ocultos vieram: no Gerenciador, **Configurações → Mostrar arquivos
   ocultos** — devem existir `.htaccess` na raiz, em `api/` e em `dados/`.

### 4. Rodar o instalador

1. Abra no navegador: `https://seudominio.com.br/organograma/install.php`
2. Preencha nome do banco, usuário e senha do banco (do passo 1), o fuso horário,
   e crie o seu login de **administrador**.
3. Clique em **Instalar**. Ele cria as tabelas, carrega o organograma inicial e o seu usuário.
4. **Apague o arquivo `install.php`** pelo Gerenciador de arquivos (ele já se bloqueia
   sozinho depois de instalado, mas é melhor não deixar no servidor).

Pronto: abra `https://seudominio.com.br/organograma/` e entre com o login criado.

### 5. Criar os usuários da equipe

Dentro do sistema → **Usuários** → **+ Novo usuário**. Perfis:

| Perfil | Pode |
| --- | --- |
| **Leitor** | Ver, buscar, imprimir e exportar |
| **Editor** | Tudo do leitor + alterar o organograma e restaurar versões |
| **Administrador** | Tudo do editor + criar/editar/desativar usuários |

Cada pessoa pode trocar a própria senha em **Minha senha**.

---

## Como funciona

- **Salvamento automático no servidor**: cada alteração (adicionar pessoa, criar área,
  marcar gerente…) é gravada no banco na hora. O status aparece na barra de busca
  ("✓ Salvo às 14:32").
- **Várias pessoas ao mesmo tempo**: a tela confere a cada 30 segundos se alguém mudou
  algo e atualiza sozinha. Se duas pessoas salvarem no mesmo instante, a segunda recebe
  um aviso e a tela recarrega com a versão mais nova — ninguém sobrescreve o trabalho
  do outro sem perceber.
- **Histórico**: as últimas 300 alterações ficam guardadas com quem fez e quando.
  Qualquer versão pode ser **baixada** (JSON) ou **restaurada** — restaurar também vira
  uma versão nova, então dá para desfazer.
- **Importar/Exportar**: exporta o organograma atual em JSON; importar substitui o
  organograma para todos (pede confirmação e a versão anterior fica no histórico).
- **Imprimir por setor**: o botão 🖨 de cada caixa gera PNG em formato A4 (ou um .zip
  com várias folhas para setores grandes), igual antes.

### Segurança

- Senhas guardadas com hash (bcrypt), nunca em texto.
- Login bloqueado por 15 minutos após 8 tentativas erradas do mesmo IP.
- Sessão expira após 12 horas sem uso; cookies `HttpOnly` + `SameSite=Strict`;
  token CSRF em toda requisição que altera dados.
- O servidor valida tudo o que recebe (perfil do usuário e estrutura do organograma).
- `.htaccess` bloqueia acesso direto a `api/config.php`, `dados/`, e arquivos `.md/.sql/.bat`.
- Sempre fica pelo menos um administrador ativo (o sistema não deixa remover o último).

### Configuração (`api/config.php`)

Gerado pelo instalador. Para mudar algo depois, edite pelo Gerenciador de arquivos:

- `db` — dados de conexão do MySQL.
- `fuso` — fuso horário das datas do histórico (`America/Cuiaba`, `America/Sao_Paulo`…).
- `acesso_publico_leitura` — `true` deixa qualquer pessoa com o link **ver** o
  organograma sem login (editar continua exigindo login). Padrão: `false`.

### Backup

O histórico já protege contra alterações erradas. Para backup completo do banco:
cPanel → **phpMyAdmin** → selecione o banco → **Exportar** → **Executar**.
Ou, dentro do sistema, **Exportar dados** baixa o organograma atual em JSON.

### Esqueci a senha do admin

Outro administrador pode definir uma nova senha em **Usuários → Senha**. Se não houver
outro admin: phpMyAdmin → tabela `usuarios` → aba **SQL**, rode
`DELETE FROM usuarios;` e acesse o `install.php` de novo (envie o arquivo outra vez) —
ele recria o admin sem mexer no organograma nem no histórico.

---

## Testar no seu computador (opcional)

Com o PHP instalado, dê duplo clique em **`Iniciar Servidor.bat`**. Ele sobe um servidor
de teste em `http://localhost:8888` usando um banco SQLite local (`dados/dev.sqlite`) —
não mexe em nada da HostGator. Na primeira vez abre o instalador para criar um admin de teste.

## Estrutura

```
index.html, style.css, script.js   interface
vendor/                            html2canvas e JSZip (imagem/zip para impressão)
install.php                        instalador (apagar depois de usar)
.htaccess                          HTTPS, bloqueios e cabeçalhos de segurança
api/bootstrap.php                  conexão, sessão, validação, gravação com histórico
api/auth.php                       login, logout, trocar senha
api/org.php                        ler/salvar o organograma
api/historico.php                  listar, baixar e restaurar versões
api/usuarios.php                   gestão de usuários (admin)
api/config.exemplo.php             modelo da configuração
dados/org-data.json                organograma inicial usado na instalação
```

Tabelas no banco: `usuarios`, `organograma` (versão atual), `historico` (versões
anteriores) e `login_tentativas` (controle de força bruta).
