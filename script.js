/* ==========================================================================
   KL Rent a Car — Organograma 2026 — lógica do dashboard
   Os dados vêm da API PHP (pasta api/) e ficam salvos no banco MySQL.
   ========================================================================== */

/* ---------- Estado ---------- */
let orgData = null;
let expandedIds = new Set();
let searchMatches = new Set();
let panX = 0, panY = 0, zoom = 1;
const ZOOM_MIN = 0.3, ZOOM_MAX = 2, ZOOM_STEP = 0.1;

/* ---------- Utilidades ---------- */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeForSearch(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function slugify(str) {
  return normalizeForSearch(str).trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const TITLE_STOPWORDS = new Set(['sr', 'sra', 'dr', 'dra', 'de', 'da', 'do', 'das', 'dos', 'e']);

function getInitials(str, maxWords) {
  const clean = String(str).replace(/\([^)]*\)/g, ' ');
  const words = clean.split(/[^\p{L}]+/u).filter(Boolean).filter(w => !TITLE_STOPWORDS.has(w.toLowerCase()));
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, maxWords || 2).map(w => w[0]).join('').toUpperCase();
}

function hashIndex(str, mod) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % mod;
}

/* Colaboradores são armazenados como { nome, gerente }. Dados antigos (ou
   importados de fora) podem trazer apenas strings — normalizamos ao carregar. */
function normalizeColaborador(entry) {
  if (typeof entry === 'string') return { nome: entry, gerente: false };
  return { nome: entry.nome || '', gerente: !!entry.gerente };
}

function normalizeTree(node) {
  node.colaboradores = (node.colaboradores || []).map(normalizeColaborador);
  (node.filhos || []).forEach(normalizeTree);
  return node;
}

function traverseAll(node, parent, cb) {
  cb(node, parent);
  node.filhos.forEach(child => traverseAll(child, node, cb));
}

function findNode(id, node = orgData.raiz) {
  if (node.id === id) return node;
  for (const child of node.filhos) {
    const found = findNode(id, child);
    if (found) return found;
  }
  return null;
}

function findNodeAndParent(id, node = orgData.raiz, parent = null) {
  if (node.id === id) return { node, parent };
  for (const child of node.filhos) {
    const found = findNodeAndParent(id, child, node);
    if (found) return found;
  }
  return null;
}

function collectAllIds(node = orgData.raiz, set = new Set()) {
  set.add(node.id);
  node.filhos.forEach(child => collectAllIds(child, set));
  return set;
}

function generateNodeId(cargo) {
  const base = slugify(cargo) || 'area';
  const existing = collectAllIds();
  let id = base;
  let counter = 1;
  while (existing.has(id)) {
    id = `${base}-${counter++}`;
  }
  return id;
}

function countDescendants(node) {
  let count = 0;
  node.filhos.forEach(child => { count += 1 + countDescendants(child); });
  return count;
}

/* Datas do servidor chegam como "AAAA-MM-DD HH:MM:SS" (horário local). */
function formatDateTime(str) {
  if (!str) return '';
  const [d, t = ''] = String(str).split(' ');
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y} ${t.slice(0, 5)}`.trim();
}

/* ---------- Servidor (API PHP + MySQL) ---------- */
const API_BASE = 'api/';
const POLL_INTERVAL_MS = 30000;
const PAPEL_NIVEL = { leitor: 1, editor: 2, admin: 3 };
const PAPEL_ROTULO = { leitor: 'Leitor', editor: 'Editor', admin: 'Administrador' };

let session = { usuario: null, csrf: '', publico: false };
let orgVersion = 0;
let dataGeneration = 0;   // muda sempre que os dados são recarregados do servidor
let pendingSaves = 0;
let saveChain = Promise.resolve();
let pollTimer = null;

class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = session.csrf || '';
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, 'Sem conexão com o servidor.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* resposta sem JSON */ }
  if (!res.ok) {
    if ((res.status === 401 || res.status === 419) && session.usuario) handleSessionExpired();
    throw new ApiError(res.status, (data && data.erro) || `Erro ${res.status} no servidor.`, data);
  }
  return data || {};
}

function hasRole(min) {
  return !!session.usuario && PAPEL_NIVEL[session.usuario.papel] >= PAPEL_NIVEL[min];
}

function canEdit() {
  return hasRole('editor');
}

function lastUpdateText(payload) {
  return payload.atualizado_por ? `Última alteração: ${payload.atualizado_por}, ${formatDateTime(payload.atualizado_em)}` : '';
}

function setSaveStatus(state, text) {
  const el = document.getElementById('save-status');
  el.className = 'save-status' + (state ? ` is-${state}` : '');
  el.textContent = text || '';
}

/* Substitui os dados locais pelos do servidor, preservando o que estava
   expandido e a busca atual. */
function applyServerData(payload) {
  const data = payload.dados;
  normalizeTree(data.raiz);
  const firstLoad = !orgData;
  orgData = data;
  orgVersion = payload.versao;
  dataGeneration++;
  if (firstLoad) {
    expandedIds = new Set([orgData.raiz.id]);
  } else {
    const ids = collectAllIds();
    expandedIds = new Set([...expandedIds].filter(id => ids.has(id)));
  }
  applySearch(document.getElementById('search-input').value);
  render();
}

async function reloadFromServer() {
  const payload = await api('org.php');
  applyServerData(payload);
  setSaveStatus('', lastUpdateText(payload));
}

/* Cada alteração envia o organograma inteiro ao servidor, em fila (uma de
   cada vez). Se outra pessoa salvou nesse meio-tempo, o servidor recusa
   (409) e devolve a versão dele — recarregamos em vez de sobrescrever. */
function saveState(descricao) {
  const snapshot = deepClone(orgData);
  const generation = dataGeneration;
  pendingSaves++;
  setSaveStatus('saving', 'Salvando…');
  saveChain = saveChain.then(async () => {
    try {
      if (generation !== dataGeneration) return; // dados recarregados: esta alteração foi descartada
      const res = await api('org.php', { method: 'PUT', body: { dados: snapshot, versao_base: orgVersion, descricao } });
      orgVersion = res.versao;
      setSaveStatus('saved', `✓ Salvo às ${formatDateTime(res.atualizado_em).slice(-5)}`);
    } catch (err) {
      setSaveStatus('error', 'Alteração não salva');
      if (err.status === 409 && err.data.dados) {
        applyServerData(err.data);
        showToast(`${err.data.atualizado_por || 'Outra pessoa'} alterou o organograma ao mesmo tempo. Os dados foram atualizados — refaça sua última alteração.`, 7000);
      } else {
        showToast(`Não foi possível salvar: ${err.message}`, 6000);
        if (err.status !== 401 && err.status !== 419) await reloadFromServer().catch(() => {});
      }
    } finally {
      pendingSaves--;
    }
  });
  return saveChain;
}

/* Confere periodicamente se alguém alterou o organograma em outro computador. */
async function checkForUpdates() {
  if (!orgData || document.hidden || pendingSaves > 0) return;
  if (!modalOverlay().classList.contains('hidden')) return;
  if (!session.usuario && !session.publico) return;
  try {
    const meta = await api('org.php?meta=1');
    if (meta.versao !== orgVersion && pendingSaves === 0) {
      await reloadFromServer();
      showToast(`Organograma atualizado por ${meta.atualizado_por || 'outro usuário'}.`, 4000);
    }
  } catch (e) { /* tenta de novo no próximo ciclo */ }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(checkForUpdates, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdates(); });
}

/* ---------- Login / sessão ---------- */
function applyRoleUI() {
  document.body.classList.toggle('is-logged', !!session.usuario);
  document.body.classList.toggle('can-edit', canEdit());
  document.body.classList.toggle('is-admin', hasRole('admin'));
  document.getElementById('user-chip').innerHTML = session.usuario
    ? `<strong>${escapeHtml(session.usuario.nome)}</strong> · ${PAPEL_ROTULO[session.usuario.papel] || ''}`
    : '';
}

function setLoginMessage(html, kind) {
  const el = document.getElementById('login-message');
  if (!html) { el.className = 'login-message hidden'; return; }
  el.innerHTML = html;
  el.className = 'login-message' + (kind === 'info' ? ' is-info' : '');
}

function showLogin(messageHtml, kind) {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('login-fields').classList.remove('hidden');
  document.getElementById('login-cancel').classList.toggle('hidden', !session.publico);
  setLoginMessage(messageHtml, kind);
  setTimeout(() => document.getElementById('login-user').focus(), 0);
}

function hideLogin() {
  document.getElementById('login-screen').classList.add('hidden');
  setLoginMessage('');
}

function showFatal(err) {
  showLogin(err.data && err.data.instalar
    ? 'O sistema ainda não foi instalado neste servidor. <a href="install.php">Clique aqui para instalar</a>.'
    : `Não foi possível carregar o organograma: ${escapeHtml(err.message)} <a href="">Tentar de novo</a>`);
  document.getElementById('login-fields').classList.add('hidden');
}

async function refreshSession() {
  session = await api('auth.php');
}

function handleSessionExpired() {
  session.usuario = null;
  applyRoleUI();
  closeModal();
  refreshSession().catch(() => {}).finally(() => showLogin('Sua sessão expirou. Entre novamente.', 'info'));
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const userInput = document.getElementById('login-user');
  const passInput = document.getElementById('login-pass');
  const btn = document.getElementById('login-submit');
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const res = await api('auth.php', { method: 'POST', body: { acao: 'login', usuario: userInput.value, senha: passInput.value } });
    session.usuario = res.usuario;
    session.csrf = res.csrf;
    passInput.value = '';
    await startApp();
  } catch (err) {
    setLoginMessage(escapeHtml(err.message));
    if (err.status === 419) await refreshSession().catch(() => {});
    passInput.select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
}

async function logout() {
  await saveChain;
  try {
    const res = await api('auth.php', { method: 'POST', body: { acao: 'logout' } });
    session.csrf = res.csrf;
  } catch (e) { /* sai mesmo assim */ }
  session.usuario = null;
  applyRoleUI();
  if (session.publico) {
    render();
    showToast('Você saiu do sistema.');
  } else {
    showLogin('Você saiu do sistema.', 'info');
  }
}

async function startApp() {
  hideLogin();
  applyRoleUI();
  await reloadFromServer();
  document.body.classList.remove('is-loading');
  startPolling();
}

/* ---------- Estatísticas ---------- */
function computeStats() {
  let totalColab = 0, totalVagas = 0, totalAreas = 0;
  traverseAll(orgData.raiz, null, (node) => {
    totalAreas++;
    totalColab += node.colaboradores.length;
    if (node.colaboradores.length === 0) totalVagas++;
  });
  return { totalColab, totalVagas, totalAreas };
}

function renderSummary() {
  const { totalColab, totalVagas, totalAreas } = computeStats();
  document.getElementById('stat-colab').textContent = totalColab;
  document.getElementById('stat-vagas').textContent = totalVagas;
  document.getElementById('stat-areas').textContent = totalAreas;
}

/* ---------- Busca ---------- */
function applySearch(query) {
  searchMatches.clear();
  const q = normalizeForSearch(query.trim());
  if (!q) return [];
  const matches = [];
  traverseAll(orgData.raiz, null, (node) => {
    const cargoMatch = normalizeForSearch(node.cargo).includes(q);
    const colabMatch = node.colaboradores.some(c => normalizeForSearch(c.nome).includes(q));
    if (cargoMatch || colabMatch) {
      matches.push(node.id);
      searchMatches.add(node.id);
    }
  });
  if (matches.length) {
    matches.forEach(id => {
      let current = findNodeAndParent(id);
      while (current && current.parent) {
        expandedIds.add(current.parent.id);
        current = findNodeAndParent(current.parent.id);
      }
    });
  }
  return matches;
}

/* ---------- Renderização da árvore ---------- */
function renderNode(node, depth) {
  depth = depth || 0;
  const tier = Math.min(depth, 3);
  const hasChildren = node.filhos && node.filhos.length > 0;
  const expanded = expandedIds.has(node.id);
  const isVaga = node.colaboradores.length === 0;
  const isRoot = node.id === orgData.raiz.id;
  const isMatch = searchMatches.has(node.id);

  const colabHtml = isVaga
    ? `<div class="vaga-label"><span class="vaga-dot"></span>Vaga em aberto</div>`
    : `<ul class="colab-list">${node.colaboradores.map((c, i) => `
        <li class="colab-item">
          <span class="avatar" style="background:var(--avatar-${hashIndex(c.nome, 5) + 1})">${escapeHtml(getInitials(c.nome))}</span>
          <span class="colab-name">${escapeHtml(c.nome)}</span>
          ${c.gerente ? `<span class="role-badge">Gerente</span>` : ''}
          <span class="colab-actions" data-requires="editor">
            <button class="icon-btn ${c.gerente ? 'is-active' : ''}" data-action="toggle-gerente" data-node="${node.id}" data-idx="${i}" title="${c.gerente ? 'Remover cargo de gerente' : 'Marcar como gerente'}">${c.gerente ? '&#9733;' : '&#9734;'}</button>
            <button class="icon-btn" data-action="edit-colab" data-node="${node.id}" data-idx="${i}" title="Editar nome">&#9998;</button>
            <button class="icon-btn danger" data-action="remove-colab" data-node="${node.id}" data-idx="${i}" title="Remover colaborador">&#10005;</button>
          </span>
        </li>`).join('')}</ul>`;

  const toggleBtn = hasChildren
    ? `<button class="toggle-btn" data-action="toggle" data-node="${node.id}" title="${expanded ? 'Recolher' : 'Expandir'}">${expanded ? '&minus;' : '+'}</button>`
    : '';

  const nodeBoxHtml = `
    <div class="node-wrap">
      <div class="node-box tier-${tier} ${isVaga ? 'is-vaga' : ''} ${isMatch ? 'is-match' : ''}" data-node-id="${node.id}">
        <div class="node-header">
          <span class="cargo-badge" style="background:var(--tier-${tier})">${escapeHtml(getInitials(node.cargo))}</span>
          <div class="node-title-wrap">
            <span class="node-title">${escapeHtml(node.cargo)}</span>
            ${toggleBtn}
          </div>
        </div>
        ${colabHtml}
        <div class="node-toolbar">
          <button class="mini-btn" data-action="add-colab" data-node="${node.id}" data-requires="editor" title="Adicionar colaborador">+ Pessoa</button>
          <button class="mini-btn" data-action="add-child" data-node="${node.id}" data-requires="editor" title="Adicionar sub-área">+ Área</button>
          <button class="mini-btn" data-action="print-sector" data-node="${node.id}" title="Gerar imagem deste setor para imprimir">&#128424; Imprimir</button>
          ${!isRoot ? `<button class="mini-btn danger" data-action="delete-node" data-node="${node.id}" data-requires="editor" title="Excluir esta área">Excluir área</button>` : ''}
        </div>
      </div>
    </div>`;

  let childrenHtml = '';
  if (hasChildren && expanded) {
    childrenHtml = `<ul class="children">${node.filhos.map(c => renderNode(c, depth + 1)).join('')}</ul>`;
  }

  return `<li class="tree-node ${hasChildren ? 'has-children' : ''}">${nodeBoxHtml}${childrenHtml}</li>`;
}

/* ---------- Imagem do setor (para impressão) ----------
   Gera um PNG do organograma daquele setor no mesmo estilo visual do
   dashboard (caixas + linhas de conexão), só que sem os elementos
   interativos: sem avatares, sem selo de iniciais, sem botões. O usuário
   imprime/compartilha essa imagem como quiser (não fica preso a uma
   página — o arquivo é do tamanho que o setor precisar). */
function computeSubtreeStats(node) {
  let colab = 0, vagas = 0;
  traverseAll(node, null, (n) => {
    colab += n.colaboradores.length;
    if (n.colaboradores.length === 0) vagas++;
  });
  return { colab, vagas };
}

function renderImageNode(node, depth) {
  depth = depth || 0;
  const tier = Math.min(depth, 3);
  const isVaga = node.colaboradores.length === 0;
  const colabHtml = isVaga
    ? `<div class="vaga-label"><span class="vaga-dot"></span>Vaga em aberto</div>`
    : `<ul class="colab-list">${node.colaboradores.map(c => `
        <li class="colab-item">
          <span class="colab-name">${escapeHtml(c.nome)}</span>
          ${c.gerente ? `<span class="role-badge">Gerente</span>` : ''}
        </li>`).join('')}</ul>`;

  const hasChildren = node.filhos && node.filhos.length > 0;
  const boxHtml = `
    <div class="node-wrap">
      <div class="node-box tier-${tier} ${isVaga ? 'is-vaga' : ''}">
        <div class="node-header">
          <div class="node-title-wrap"><span class="node-title">${escapeHtml(node.cargo)}</span></div>
        </div>
        ${colabHtml}
      </div>
    </div>`;

  let childrenHtml = '';
  if (hasChildren) {
    childrenHtml = `<ul class="children">${node.filhos.map(c => renderImageNode(c, depth + 1)).join('')}</ul>`;
  }
  return `<li class="tree-node ${hasChildren ? 'has-children' : ''}">${boxHtml}${childrenHtml}</li>`;
}

async function exportSectorImage(nodeId) {
  const node = findNode(nodeId);
  if (!node) return;
  showToast('Gerando imagem...');

  const stats = computeSubtreeStats(node);
  const dateStr = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  const contentHtml = `
    <div class="img-header">
      <div class="img-kicker">KL RENT A CAR · ORGANOGRAMA</div>
      <div class="img-title">${escapeHtml(node.cargo)}</div>
      <div class="img-meta">${stats.colab} colaborador(es) · ${stats.vagas} vaga(s) em aberto · ${dateStr}</div>
    </div>
    <ul class="tree">${renderImageNode(node, 0)}</ul>`;

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute; left:-99999px; top:0; display:inline-block; background:#ffffff; padding:36px;';
  container.innerHTML = contentHtml;
  document.body.appendChild(container);
  await new Promise(r => requestAnimationFrame(r));

  try {
    const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff' });
    await deliverSectorCanvas(canvas, node);
  } catch (err) {
    console.error('Falha ao gerar imagem do setor', err);
    showToast('Não foi possível gerar a imagem.');
  } finally {
    document.body.removeChild(container);
  }
}

/* Setores grandes (ex.: Lojas) viram várias folhas no formato exato de uma
   folha A4 deitada (a 200dpi: 2339x1654px) — cada arquivo já sai pronto
   para imprimir numa folha, sem cortar nem esticar o conteúdo (o que não
   couber é centralizado com margem branca, nunca distorcido). Quando dá
   mais de uma folha, todas saem juntas dentro de um único .zip (em vez de
   vários downloads separados, que o navegador costuma bloquear a partir
   do segundo arquivo). */
const MM_PER_INCH = 25.4;
const A4_DPI = 200;
const TILE_W = Math.round((297 / MM_PER_INCH) * A4_DPI); // A4 paisagem
const TILE_H = Math.round((210 / MM_PER_INCH) * A4_DPI);
const TILE_OVERLAP = 24;

function canvasToPngBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function computeTileGrid(width, height) {
  const cols = Math.max(1, Math.ceil(width / TILE_W));
  const rows = Math.max(1, Math.ceil(height / TILE_H));
  return { cols, rows };
}

/* Recorta [sx,sy,sw,sh] do canvas de origem e centraliza numa folha A4
   (TILE_W x TILE_H) sem distorcer — só reduz (nunca aumenta) se precisar. */
function placeOnA4Sheet(sourceCanvas, sx, sy, sw, sh) {
  const scale = Math.min(1, TILE_W / sw, TILE_H / sh);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  const dx = Math.round((TILE_W - dw) / 2);
  const dy = Math.round((TILE_H - dh) / 2);
  const tile = document.createElement('canvas');
  tile.width = TILE_W;
  tile.height = TILE_H;
  const tctx = tile.getContext('2d');
  tctx.fillStyle = '#ffffff';
  tctx.fillRect(0, 0, TILE_W, TILE_H);
  tctx.drawImage(sourceCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
  return tile;
}

function stampLabel(tile, text) {
  const tctx = tile.getContext('2d');
  tctx.font = '600 20px Arial, sans-serif';
  const textWidth = tctx.measureText(text).width;
  const padX = 10, boxH = 30, marginPx = 8;
  tctx.fillStyle = 'rgba(255,255,255,.92)';
  tctx.fillRect(marginPx, tile.height - boxH - marginPx, textWidth + padX * 2, boxH);
  tctx.strokeStyle = '#33404D';
  tctx.lineWidth = 1;
  tctx.strokeRect(marginPx, tile.height - boxH - marginPx, textWidth + padX * 2, boxH);
  tctx.fillStyle = '#0B1420';
  tctx.textBaseline = 'middle';
  tctx.fillText(text, marginPx + padX, tile.height - boxH / 2 - marginPx + 2);
}

async function deliverSectorCanvas(canvas, node) {
  const { cols, rows } = computeTileGrid(canvas.width, canvas.height);
  const baseName = slugify(node.cargo);

  if (cols === 1 && rows === 1) {
    const tile = placeOnA4Sheet(canvas, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToPngBlob(tile);
    if (!blob) { showToast('Não foi possível gerar a imagem.'); return; }
    downloadBlob(blob, `organograma-${baseName}-a4.png`);
    showToast('Imagem gerada (formato A4) — pronta para imprimir.');
    return;
  }

  const coreW = Math.ceil(canvas.width / cols);
  const coreH = Math.ceil(canvas.height / rows);
  const total = cols * rows;
  showToast(`Gerando ${total} folhas A4...`);

  const zip = new JSZip();
  let count = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      count++;
      const coreX = c * coreW;
      const coreY = r * coreH;
      const sx = Math.max(0, coreX - (c > 0 ? TILE_OVERLAP : 0));
      const sy = Math.max(0, coreY - (r > 0 ? TILE_OVERLAP : 0));
      const exRight = c < cols - 1 ? TILE_OVERLAP : 0;
      const exBottom = r < rows - 1 ? TILE_OVERLAP : 0;
      const sw = Math.min(canvas.width - sx, coreX + coreW - sx + exRight);
      const sh = Math.min(canvas.height - sy, coreY + coreH - sy + exBottom);

      const tile = placeOnA4Sheet(canvas, sx, sy, sw, sh);
      stampLabel(tile, `${node.cargo} — folha ${count}/${total} (linha ${r + 1}, coluna ${c + 1})`);

      const blob = await canvasToPngBlob(tile);
      if (blob) {
        const filename = `folha-${String(count).padStart(2, '0')}-de-${String(total).padStart(2, '0')}.png`;
        zip.file(filename, blob);
      }
    }
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(zipBlob, `organograma-${baseName}-${total}-folhas-a4.zip`);
  showToast(`${total} folhas A4 geradas num único .zip — encaixe pela sobreposição das bordas.`);
}

function render() {
  document.getElementById('tree-root').innerHTML = renderNode(orgData.raiz, 0);
  renderSummary();
  const count = searchMatches.size;
  const searchCountEl = document.getElementById('search-count');
  const searchInput = document.getElementById('search-input');
  if (searchInput.value.trim()) {
    searchCountEl.textContent = count ? `${count} encontrado(s)` : 'nenhum resultado';
  } else {
    searchCountEl.textContent = '';
  }
}

/* ---------- Transform (zoom/pan) ---------- */
function applyTransform() {
  document.getElementById('canvas-pan').style.transform = `translate(${panX}px, ${panY}px)`;
  document.getElementById('canvas-zoom').style.transform = `scale(${zoom})`;
  document.getElementById('zoom-reset').textContent = `${Math.round(zoom * 100)}%`;
}

function centerOnNode(id) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
    const viewport = document.getElementById('canvas-viewport');
    if (!el || !viewport) return;
    const vpRect = viewport.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const elCenterX = elRect.left + elRect.width / 2 - vpRect.left;
    const elCenterY = elRect.top + elRect.height / 2 - vpRect.top;
    panX += (vpRect.width / 2 - elCenterX);
    panY += (vpRect.height / 2 - elCenterY);
    applyTransform();
  });
}

/* ---------- Modal genérico ---------- */
const modalOverlay = () => document.getElementById('modal-overlay');
let modalConfirmHandler = null;

function openModal({ title, bodyHtml, warning, confirmLabel = 'Confirmar', danger = false, onConfirm, focusSelector, wide = false, hideCancel = false }) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.querySelector('#modal-overlay .modal').classList.toggle('is-wide', wide);
  document.querySelector('#modal-overlay .modal-actions').classList.toggle('hide-cancel', hideCancel);
  const warningEl = document.getElementById('modal-warning');
  if (warning) { warningEl.textContent = warning; warningEl.classList.remove('hidden'); }
  else { warningEl.classList.add('hidden'); }
  const confirmBtn = document.getElementById('modal-confirm');
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
  modalConfirmHandler = onConfirm;
  modalOverlay().classList.remove('hidden');
  const focusEl = focusSelector ? document.querySelector(focusSelector) : confirmBtn;
  if (focusEl) { focusEl.focus(); if (focusEl.select) focusEl.select(); }
}

function closeModal() {
  modalOverlay().classList.add('hidden');
  modalConfirmHandler = null;
}

function confirmModal() {
  if (typeof modalConfirmHandler === 'function') {
    const result = modalConfirmHandler();
    if (result === false) return; // validação falhou, mantém modal aberto
  }
  closeModal();
}

/* ---------- Toast ---------- */
let toastTimer = null;
function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

/* Para modais que chamam o servidor: mantém o modal aberto, trava o botão
   durante a requisição e mostra o erro se falhar. A tarefa decide o que
   abrir/fechar quando der certo. */
function runModalAction(task) {
  const btn = document.getElementById('modal-confirm');
  if (btn.disabled) return false;
  btn.disabled = true;
  task()
    .catch(err => showToast(err.message, 5000))
    .finally(() => { btn.disabled = false; });
  return false;
}

/* ---------- Ações de modal específicas ---------- */
function showAddColabModal(nodeId) {
  const node = findNode(nodeId);
  if (!node) return;
  openModal({
    title: `Adicionar colaborador — ${node.cargo}`,
    bodyHtml: `<label for="input-colab-name">Nome do colaborador</label>
               <input type="text" id="input-colab-name" placeholder="Ex.: Maria Silva">`,
    confirmLabel: 'Adicionar',
    focusSelector: '#input-colab-name',
    onConfirm: () => {
      const input = document.getElementById('input-colab-name');
      const name = input.value.trim();
      if (!name) { input.focus(); return false; }
      node.colaboradores.push({ nome: name, gerente: false });
      saveState(`Adicionou ${name} em ${node.cargo}`);
      render();
      showToast(`${name} adicionado(a) em ${node.cargo}.`);
    }
  });
}

function showEditColabModal(nodeId, idx) {
  const node = findNode(nodeId);
  if (!node || !node.colaboradores[idx]) return;
  const current = node.colaboradores[idx].nome;
  openModal({
    title: `Editar nome — ${node.cargo}`,
    bodyHtml: `<label for="input-colab-edit">Nome do colaborador</label>
               <input type="text" id="input-colab-edit" value="${escapeHtml(current)}">`,
    confirmLabel: 'Salvar',
    focusSelector: '#input-colab-edit',
    onConfirm: () => {
      const input = document.getElementById('input-colab-edit');
      const name = input.value.trim();
      if (!name) { input.focus(); return false; }
      node.colaboradores[idx].nome = name;
      saveState(`Renomeou ${current} para ${name} (${node.cargo})`);
      render();
      showToast('Nome atualizado.');
    }
  });
}

function showRemoveColabConfirm(nodeId, idx) {
  const node = findNode(nodeId);
  if (!node || !node.colaboradores[idx]) return;
  const name = node.colaboradores[idx].nome;
  openModal({
    title: 'Remover colaborador',
    bodyHtml: `<p>Remover <strong>${escapeHtml(name)}</strong> de <strong>${escapeHtml(node.cargo)}</strong>?</p>`,
    confirmLabel: 'Remover',
    danger: true,
    onConfirm: () => {
      node.colaboradores.splice(idx, 1);
      saveState(`Removeu ${name} de ${node.cargo}`);
      render();
      showToast(`${name} removido(a).`);
    }
  });
}

function toggleGerente(nodeId, idx) {
  const node = findNode(nodeId);
  if (!node || !node.colaboradores[idx]) return;
  const c = node.colaboradores[idx];
  c.gerente = !c.gerente;
  saveState(`${c.gerente ? 'Marcou' : 'Desmarcou'} ${c.nome} como gerente (${node.cargo})`);
  render();
  showToast(c.gerente ? `${c.nome} marcado(a) como gerente.` : `${c.nome} não é mais gerente.`);
}

function showAddChildModal(parentId) {
  const parent = findNode(parentId);
  if (!parent) return;
  openModal({
    title: `Nova área/cargo em — ${parent.cargo}`,
    bodyHtml: `<label for="input-child-name">Nome da nova área/cargo</label>
               <input type="text" id="input-child-name" placeholder="Ex.: Suporte ao Cliente">`,
    confirmLabel: 'Criar',
    focusSelector: '#input-child-name',
    onConfirm: () => {
      const input = document.getElementById('input-child-name');
      const cargo = input.value.trim();
      if (!cargo) { input.focus(); return false; }
      const id = generateNodeId(cargo);
      parent.filhos.push({ id, cargo, colaboradores: [], filhos: [] });
      expandedIds.add(parent.id);
      saveState(`Criou a área ${cargo} em ${parent.cargo}`);
      render();
      showToast(`Área "${cargo}" criada.`);
    }
  });
}

function showDeleteNodeConfirm(nodeId) {
  const found = findNodeAndParent(nodeId);
  if (!found || !found.parent) return;
  const { node } = found;
  const descendantCount = countDescendants(node);
  const warning = descendantCount > 0
    ? `Esta área possui ${descendantCount} sub-área(s)/subordinado(s), que também serão removidos.`
    : null;
  openModal({
    title: 'Excluir área',
    bodyHtml: `<p>Tem certeza que deseja excluir <strong>${escapeHtml(node.cargo)}</strong>?</p>`,
    warning,
    confirmLabel: 'Excluir',
    danger: true,
    onConfirm: () => {
      const { parent } = findNodeAndParent(nodeId);
      parent.filhos = parent.filhos.filter(c => c.id !== nodeId);
      expandedIds.delete(nodeId);
      saveState(`Excluiu a área ${node.cargo}`);
      render();
      showToast(`Área "${node.cargo}" excluída.`);
    }
  });
}

/* ---------- Histórico de versões ---------- */
let historyCache = new Map();

async function showHistoryModal() {
  let res;
  try { res = await api('historico.php'); } catch (err) { showToast(err.message, 5000); return; }
  historyCache = new Map(res.versoes.map(v => [v.id, v]));
  const rows = res.versoes.map(v => `
    <div class="list-row">
      <div class="list-main">
        <div class="list-title">${escapeHtml(v.descricao)}</div>
        <div class="list-meta">Versão ${v.versao} · ${escapeHtml(v.usuario || '—')} · ${formatDateTime(v.criado_em)}</div>
      </div>
      <div class="list-actions">
        ${v.versao === orgVersion
          ? '<span class="list-tag is-current">Atual</span>'
          : `<button class="btn-small" type="button" data-history-restore="${v.id}" data-requires="editor">Restaurar</button>`}
        <button class="btn-small" type="button" data-history-download="${v.id}">Baixar</button>
      </div>
    </div>`).join('');
  openModal({
    title: 'Histórico de alterações',
    bodyHtml: `<p class="hint">Cada alteração fica guardada aqui (as ${res.versoes.length} mais recentes). Restaurar uma versão não apaga nada — vira uma nova versão, que também pode ser desfeita.</p>
               <div class="list-scroll">${rows || '<p class="list-empty">Nenhuma versão registrada.</p>'}</div>`,
    confirmLabel: 'Fechar',
    hideCancel: true,
    wide: true,
  });
}

function showRestoreVersionConfirm(id) {
  const v = historyCache.get(id);
  if (!v || !canEdit()) return;
  openModal({
    title: 'Restaurar versão',
    bodyHtml: `<p>O organograma vai voltar a ficar como estava na <strong>versão ${v.versao}</strong> (${formatDateTime(v.criado_em)} — ${escapeHtml(v.descricao)}).</p>
               <p class="hint">A versão atual continua no histórico, então dá para desfazer depois.</p>`,
    confirmLabel: 'Restaurar',
    onConfirm: () => runModalAction(async () => {
      await saveChain;
      try {
        const res = await api('historico.php', { method: 'POST', body: { id, versao_base: orgVersion } });
        applyServerData(res);
        setSaveStatus('saved', `✓ Versão ${v.versao} restaurada`);
        closeModal();
        showToast(`Versão ${v.versao} restaurada.`);
      } catch (err) {
        if (err.status === 409 && err.data.dados) {
          applyServerData(err.data);
          closeModal();
          showToast('O organograma foi alterado por outra pessoa enquanto isso. Abra o histórico e tente de novo.', 6000);
          return;
        }
        throw err;
      }
    }),
  });
}

async function downloadVersion(id) {
  try {
    const v = await api(`historico.php?id=${encodeURIComponent(id)}`);
    const blob = new Blob([JSON.stringify(v.dados, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `org-data-versao-${v.versao}.json`);
  } catch (err) {
    showToast(err.message, 5000);
  }
}

/* ---------- Usuários (somente admin) ---------- */
let usersCache = new Map();

function papelOptions(selected) {
  return Object.keys(PAPEL_ROTULO)
    .map(p => `<option value="${p}" ${p === selected ? 'selected' : ''}>${PAPEL_ROTULO[p]}</option>`)
    .join('');
}

async function showUsersModal() {
  let res;
  try { res = await api('usuarios.php'); } catch (err) { showToast(err.message, 5000); return; }
  usersCache = new Map(res.usuarios.map(u => [u.id, u]));
  const rows = res.usuarios.map(u => {
    const isMe = u.id === res.eu;
    return `
    <div class="list-row">
      <div class="list-main">
        <div class="list-title">${escapeHtml(u.nome)}
          ${isMe ? '<span class="list-tag">Você</span>' : ''}
          ${!u.ativo ? '<span class="list-tag is-off">Desativado</span>' : ''}</div>
        <div class="list-meta">login: ${escapeHtml(u.usuario)} · último acesso: ${u.ultimo_login ? formatDateTime(u.ultimo_login) : 'nunca'}</div>
      </div>
      <div class="list-actions">
        <select data-user-role="${u.id}" aria-label="Perfil de ${escapeHtml(u.nome)}" ${isMe ? 'disabled' : ''}>${papelOptions(u.papel)}</select>
        <button class="btn-small" type="button" data-user-password="${u.id}">Senha</button>
        <button class="btn-small" type="button" data-user-toggle="${u.id}" ${isMe ? 'disabled' : ''}>${u.ativo ? 'Desativar' : 'Ativar'}</button>
        <button class="btn-small danger" type="button" data-user-delete="${u.id}" ${isMe ? 'disabled' : ''}>Excluir</button>
      </div>
    </div>`;
  }).join('');
  openModal({
    title: 'Usuários',
    bodyHtml: `<div class="list-toolbar"><button class="btn-small" type="button" data-user-new>+ Novo usuário</button></div>
               <p class="hint"><strong>Leitor</strong>: só visualiza e imprime. <strong>Editor</strong>: altera o organograma. <strong>Administrador</strong>: também gerencia usuários.</p>
               <div class="list-scroll">${rows}</div>`,
    confirmLabel: 'Fechar',
    hideCancel: true,
    wide: true,
  });
}

async function updateUser(id, changes, successMsg) {
  try {
    await api('usuarios.php', { method: 'PUT', body: { id, ...changes } });
    showToast(successMsg);
  } catch (err) {
    showToast(err.message, 5000);
  }
  showUsersModal();
}

function showNewUserModal() {
  openModal({
    title: 'Novo usuário',
    bodyHtml: `<div class="field"><label for="nu-nome">Nome</label><input type="text" id="nu-nome" placeholder="Ex.: Maria Silva"></div>
               <div class="field"><label for="nu-usuario">Login</label><input type="text" id="nu-usuario" placeholder="Ex.: maria" autocapitalize="none" autocomplete="off"></div>
               <div class="field"><label for="nu-senha">Senha inicial</label><input type="password" id="nu-senha" autocomplete="new-password">
                 <p class="hint">Mínimo de 8 caracteres. A pessoa pode trocar depois em "Minha senha".</p></div>
               <div class="field"><label for="nu-papel">Perfil</label><select id="nu-papel">${papelOptions('leitor')}</select></div>`,
    confirmLabel: 'Criar usuário',
    focusSelector: '#nu-nome',
    onConfirm: () => runModalAction(async () => {
      await api('usuarios.php', {
        method: 'POST',
        body: {
          nome: document.getElementById('nu-nome').value,
          usuario: document.getElementById('nu-usuario').value,
          senha: document.getElementById('nu-senha').value,
          papel: document.getElementById('nu-papel').value,
        },
      });
      showToast('Usuário criado.');
      showUsersModal();
    }),
  });
}

function showUserPasswordModal(id) {
  const u = usersCache.get(id);
  if (!u) return;
  openModal({
    title: `Nova senha — ${u.nome}`,
    bodyHtml: `<div class="field"><label for="up-senha">Nova senha</label><input type="password" id="up-senha" autocomplete="new-password">
                 <p class="hint">Mínimo de 8 caracteres.</p></div>`,
    confirmLabel: 'Salvar senha',
    focusSelector: '#up-senha',
    onConfirm: () => runModalAction(async () => {
      await api('usuarios.php', { method: 'PUT', body: { id, senha: document.getElementById('up-senha').value } });
      showToast(`Senha de ${u.nome} alterada.`);
      showUsersModal();
    }),
  });
}

function showDeleteUserConfirm(id) {
  const u = usersCache.get(id);
  if (!u) return;
  openModal({
    title: 'Excluir usuário',
    bodyHtml: `<p>Excluir o usuário <strong>${escapeHtml(u.nome)}</strong> (${escapeHtml(u.usuario)})? Se quiser só bloquear o acesso por um tempo, use "Desativar".</p>`,
    confirmLabel: 'Excluir',
    danger: true,
    onConfirm: () => runModalAction(async () => {
      await api(`usuarios.php?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast('Usuário excluído.');
      showUsersModal();
    }),
  });
}

function showMyPasswordModal() {
  openModal({
    title: 'Trocar minha senha',
    bodyHtml: `<div class="field"><label for="mp-atual">Senha atual</label><input type="password" id="mp-atual" autocomplete="current-password"></div>
               <div class="field"><label for="mp-nova">Nova senha</label><input type="password" id="mp-nova" autocomplete="new-password"></div>
               <div class="field"><label for="mp-nova2">Repita a nova senha</label><input type="password" id="mp-nova2" autocomplete="new-password">
                 <p class="hint">Mínimo de 8 caracteres.</p></div>`,
    confirmLabel: 'Salvar',
    focusSelector: '#mp-atual',
    onConfirm: () => runModalAction(async () => {
      const nova = document.getElementById('mp-nova').value;
      if (nova !== document.getElementById('mp-nova2').value) throw new Error('As senhas novas não conferem.');
      await api('auth.php', { method: 'POST', body: { acao: 'senha', senha_atual: document.getElementById('mp-atual').value, senha_nova: nova } });
      closeModal();
      showToast('Senha alterada.');
    }),
  });
}

/* ---------- Import / Export ---------- */
function exportData() {
  const dataStr = JSON.stringify(orgData, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `org-data-${stamp}.json`);
  showToast('Arquivo exportado.');
}

function importDataFromFile(file) {
  const reader = new FileReader();
  reader.onload = (evt) => {
    let parsed;
    try {
      parsed = JSON.parse(evt.target.result);
    } catch (err) {
      showToast('Erro ao importar: arquivo JSON inválido.', 5000);
      return;
    }
    if (!parsed || !parsed.raiz || !parsed.raiz.id || !parsed.raiz.cargo || !Array.isArray(parsed.raiz.filhos)) {
      showToast('Arquivo inválido: estrutura não reconhecida (esperado objeto com "raiz").', 5000);
      return;
    }
    openModal({
      title: 'Importar dados',
      bodyHtml: `<p>Substituir o organograma atual pelo conteúdo de <strong>${escapeHtml(file.name)}</strong>?</p>
                 <p class="hint">A mudança vale para todos os usuários. A versão atual fica guardada no histórico.</p>`,
      confirmLabel: 'Importar',
      danger: true,
      onConfirm: () => {
        normalizeTree(parsed.raiz);
        orgData = parsed;
        expandedIds = new Set([orgData.raiz.id]);
        searchMatches.clear();
        document.getElementById('search-input').value = '';
        render();
        saveState(`Importou o arquivo ${file.name}`);
        showToast('Dados importados.');
      },
    });
  };
  reader.readAsText(file, 'utf-8');
}

/* ---------- Eventos globais ---------- */
const EDIT_ACTIONS = new Set(['add-colab', 'edit-colab', 'remove-colab', 'toggle-gerente', 'add-child', 'delete-node']);

function attachGlobalListeners() {
  // Login
  document.getElementById('login-form').addEventListener('submit', handleLoginSubmit);
  document.getElementById('login-cancel').addEventListener('click', hideLogin);
  document.getElementById('btn-login').addEventListener('click', () => showLogin());
  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('btn-password').addEventListener('click', showMyPasswordModal);
  document.getElementById('btn-history').addEventListener('click', showHistoryModal);
  document.getElementById('btn-users').addEventListener('click', showUsersModal);

  // Botões dentro das listas de histórico/usuários (o conteúdo do modal é recriado a cada abertura)
  const modalBody = document.getElementById('modal-body');
  modalBody.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    const d = btn.dataset;
    if (d.historyRestore) showRestoreVersionConfirm(+d.historyRestore);
    else if (d.historyDownload) downloadVersion(+d.historyDownload);
    else if (d.userNew !== undefined) showNewUserModal();
    else if (d.userPassword) showUserPasswordModal(+d.userPassword);
    else if (d.userDelete) showDeleteUserConfirm(+d.userDelete);
    else if (d.userToggle) {
      const u = usersCache.get(+d.userToggle);
      if (u) updateUser(u.id, { ativo: !u.ativo }, u.ativo ? `${u.nome} desativado(a).` : `${u.nome} ativado(a).`);
    }
  });
  modalBody.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-user-role]');
    if (!sel) return;
    const u = usersCache.get(+sel.dataset.userRole);
    if (u) updateUser(u.id, { papel: sel.value }, `${u.nome} agora é ${PAPEL_ROTULO[sel.value]}.`);
  });

  // Delegação de cliques nas caixas do organograma
  document.getElementById('canvas-viewport').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.action;
    const nodeId = btn.dataset.node;
    if (EDIT_ACTIONS.has(action) && !canEdit()) return;
    switch (action) {
      case 'toggle': {
        if (expandedIds.has(nodeId)) expandedIds.delete(nodeId); else expandedIds.add(nodeId);
        render();
        break;
      }
      case 'add-colab': showAddColabModal(nodeId); break;
      case 'edit-colab': showEditColabModal(nodeId, parseInt(btn.dataset.idx, 10)); break;
      case 'remove-colab': showRemoveColabConfirm(nodeId, parseInt(btn.dataset.idx, 10)); break;
      case 'toggle-gerente': toggleGerente(nodeId, parseInt(btn.dataset.idx, 10)); break;
      case 'print-sector': exportSectorImage(nodeId); break;
      case 'add-child': showAddChildModal(nodeId); break;
      case 'delete-node': showDeleteNodeConfirm(nodeId); break;
    }
  });

  // Busca
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    const matches = applySearch(searchInput.value);
    render();
    if (matches.length) centerOnNode(matches[0]);
  });

  // Zoom
  document.getElementById('zoom-in').addEventListener('click', () => {
    zoom = Math.min(ZOOM_MAX, +(zoom + ZOOM_STEP).toFixed(2));
    applyTransform();
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    zoom = Math.max(ZOOM_MIN, +(zoom - ZOOM_STEP).toFixed(2));
    applyTransform();
  });
  document.getElementById('zoom-reset').addEventListener('click', () => {
    zoom = 1; panX = 0; panY = 0;
    applyTransform();
  });

  // Roda do mouse para zoom (com Ctrl) sobre o canvas
  const viewport = document.getElementById('canvas-viewport');
  viewport.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(zoom + delta).toFixed(2)));
    applyTransform();
  }, { passive: false });

  // Pan (arrastar)
  let dragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
  viewport.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, input, .colab-actions')) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startPanX = panX; startPanY = panY;
    viewport.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panX = startPanX + (e.clientX - startX);
    panY = startPanY + (e.clientY - startY);
    applyTransform();
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    viewport.classList.remove('dragging');
  });

  // Modal
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-confirm').addEventListener('click', confirmModal);
  modalOverlay().addEventListener('click', (e) => {
    if (e.target === modalOverlay()) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (modalOverlay().classList.contains('hidden')) return;
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter') {
      const active = document.activeElement;
      if (active && active.tagName === 'INPUT') confirmModal();
    }
  });

  // Exportar / Importar
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-import').click());
  document.getElementById('file-import').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file && canEdit()) importDataFromFile(file);
    e.target.value = '';
  });

  // Avisa antes de fechar a aba se ainda há alteração sendo enviada
  window.addEventListener('beforeunload', (e) => {
    if (pendingSaves > 0) { e.preventDefault(); e.returnValue = ''; }
  });
}

/* ---------- Inicialização ---------- */
async function init() {
  attachGlobalListeners();
  applyTransform();
  try {
    await refreshSession();
  } catch (err) {
    showFatal(err);
    return;
  }
  if (!session.usuario && !session.publico) {
    showLogin();
    return;
  }
  try {
    await startApp();
  } catch (err) {
    showFatal(err);
  }
}

document.addEventListener('DOMContentLoaded', init);
