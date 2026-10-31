'use strict';

// ==========================================================================
// KOPESA EXPRESS - LÓGICA PRINCIPAL
// ==========================================================================
// Nota: tudo é guardado no localStorage do navegador. Isto serve para
// protótipo/demonstração. Para uso real (pagamentos, contas, admin) é
// necessário um servidor com base de dados e autenticação.

const CHAVES = {
    utilizadores: 'kopesa_utilizadores',
    sessao: 'kopesa_usuario_atual',
    produtos: 'kopesa_produtos',
    carrinhoLegado: 'kopesa_carrinho',
    financeiro: 'kopesa_admin_financeiro'
};

// Sem comissão sobre as vendas. O criador ganha uma taxa fixa de publicação,
// que depende do valor do produto. Cada escalão vale a partir do valor "de".
const VALOR_MINIMO = 25000;
const TABELA_TAXAS = [
    { de: 25000, taxa: 2000 },
    { de: 50000, taxa: 4000 },
    { de: 200000, taxa: 6000 },
    { de: 700000, taxa: 10000 }
];

function calcularTaxa(valor) {
    if (!Number.isFinite(valor) || valor < VALOR_MINIMO) return null;
    let taxa = null;
    TABELA_TAXAS.forEach((faixa) => {
        if (valor >= faixa.de) taxa = faixa.taxa;
    });
    return taxa;
}
const CATEGORIAS = ['Moda', 'Eletrónicos', 'Casa', 'Beleza', 'Desporto', 'Outros'];
const ECRAS = ['ecra-auth', 'ecra-escolha', 'ecra-cliente', 'ecra-vendedor', 'ecra-admin'];

// O PIN do admin já não está no código em texto simples (apenas o hash).
// Continua a ser uma proteção apenas visual, pois corre no navegador.
const PIN_SAL = 'kopesa-admin';
const PIN_HASH = '9b92be5ca0f6ef563b5db7aa693fbe91aa4bb73c554d58b487eba49c99eab4cf';

// DADOS DE PAGAMENTO DO CRIADOR: preencha com os seus dados.
// É para estes dados que o vendedor paga a taxa de publicação.
const PAGAMENTO = {
    titular: '',   // nome do titular da conta
    iban: '',      // IBAN angolano (AO + 23 dígitos)
    express: ''    // telemóvel do Multicaixa Express (9 dígitos); também recebe o comprovativo por WhatsApp
};

const IMG_PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150">' +
    '<rect width="300" height="150" fill="#1f1a17"/>' +
    '<g fill="none" stroke="#c86336" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="125" y="50" width="50" height="40" rx="6"/><circle cx="141" cy="64" r="4"/>' +
    '<path d="M127 86l16-14 12 10 8-6 10 10"/></g></svg>'
);

// --------------------------------------------------------------------------
// ESTADO
// --------------------------------------------------------------------------
let modoAuth = 'entrar';
let usuarioAtual = null;
let carrinho = [];            // [{ id, qty }]
let estaAdmin = false;
let tentativasPin = 0;
let bloqueadoAte = 0;
let ultimoFoco = null;
let temporizadorPesquisa = null;
const filtros = { termo: '', categoria: 'Todas', ordem: 'recentes' };

// --------------------------------------------------------------------------
// UTILITÁRIOS
// --------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function lerJSON(chave, padrao) {
    try {
        const bruto = localStorage.getItem(chave);
        return bruto ? JSON.parse(bruto) : padrao;
    } catch (e) {
        return padrao;
    }
}

function guardarJSON(chave, valor) {
    try {
        localStorage.setItem(chave, JSON.stringify(valor));
        return true;
    } catch (e) {
        mostrarToast('Sem espaço de armazenamento. Use uma foto mais pequena.', 'exclamation-circle');
        return false;
    }
}

// Escapa texto antes de o inserir em HTML (evita injeção de código)
function esc(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function kz(valor) {
    const n = Number(valor) || 0;
    return n.toLocaleString('pt-PT', { maximumFractionDigits: 2 }) + ' Kz';
}

function arredondar(n) {
    return Math.round(n * 100) / 100;
}

function srcFoto(foto) {
    return typeof foto === 'string' && /^(data:image\/|https?:\/\/)/.test(foto) ? foto : IMG_PLACEHOLDER;
}

function normalizarContacto(valor) {
    const v = String(valor || '').trim();
    if (v.includes('@')) return v.toLowerCase();
    return v.replace(/[\s\-().]/g, '').replace(/^(\+?244)/, '');
}

function ehTelefone(v) {
    return /^9\d{8}$/.test(v);
}

function ehEmail(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function hashTexto(texto, sal) {
    if (!window.crypto || !crypto.subtle) throw new Error('crypto-indisponivel');
    const dados = new TextEncoder().encode(`${sal}:${texto}`);
    const buf = await crypto.subtle.digest('SHA-256', dados);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function gerarSal() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --------------------------------------------------------------------------
// NOTIFICAÇÕES
// --------------------------------------------------------------------------
function mostrarToast(mensagem, icone = 'check-circle') {
    const container = $('toast-container');
    if (!container) return;

    while (container.children.length >= 3) container.firstElementChild.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');

    const i = document.createElement('i');
    i.className = `fas fa-${icone}`;
    i.setAttribute('aria-hidden', 'true');

    const texto = document.createElement('span');
    texto.textContent = mensagem;

    toast.append(i, texto);
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('saindo');
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

// --------------------------------------------------------------------------
// MODAIS
// --------------------------------------------------------------------------
function abrirModal(id) {
    const modal = $(id);
    if (!modal) return;
    ultimoFoco = document.activeElement;
    modal.classList.remove('oculto');
    document.body.classList.add('sem-scroll');
    const primeiro = modal.querySelector('input:not([type="file"]), select, .btn-principal');
    if (primeiro) primeiro.focus();
}

function fecharModal(id) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.add('oculto');
    if (!document.querySelector('.modal:not(.oculto)')) document.body.classList.remove('sem-scroll');
    if (ultimoFoco && typeof ultimoFoco.focus === 'function') ultimoFoco.focus();
}

function fecharModalAberto() {
    const abertos = document.querySelectorAll('.modal:not(.oculto)');
    if (abertos.length) fecharModal(abertos[abertos.length - 1].id);
}

// --------------------------------------------------------------------------
// ECRÃS E NAVEGAÇÃO
// --------------------------------------------------------------------------
// Qualquer utilizador com sessão iniciada pode comprar e vender
const ehVendedor = () => !!usuarioAtual;

function mostrarEcra(id) {
    ECRAS.forEach((ecra) => $(ecra).classList.toggle('oculto', ecra !== id));

    const logado = !!usuarioAtual;
    $('btn-carrinho').classList.toggle('oculto', id !== 'ecra-cliente');
    $('btn-logout').classList.toggle('oculto', !logado);
    $('btn-flutuante').classList.toggle('oculto', !logado || id === 'ecra-cliente');

    const badge = $('badge-utilizador');
    badge.textContent = logado ? usuarioAtual.nome : '';
    badge.classList.toggle('oculto', !logado);

    if (id !== 'ecra-admin') estaAdmin = false;
    window.scrollTo(0, 0);
}

function aplicarPapel() {
    $('card-vendedor').classList.toggle('oculto', !ehVendedor());
    $('btn-publicar').classList.toggle('oculto', !ehVendedor());
}

function irParaHome() {
    if (usuarioAtual) {
        aplicarPapel();
        mostrarEcra('ecra-escolha');
    } else {
        mostrarEcra('ecra-auth');
    }
}

function irParaMarketplace() {
    if (!usuarioAtual) {
        mostrarToast('Inicie sessão para ver os produtos.', 'exclamation-circle');
        mostrarEcra('ecra-auth');
        return;
    }
    aplicarPapel();
    mostrarEcra('ecra-cliente');
    renderChips();
    renderMarketplace();
    atualizarBadgeCarrinho();
}

function irParaPainelVendedor() {
    if (!ehVendedor()) {
        mostrarToast('Esta área é só para contas de vendedor.', 'exclamation-circle');
        return;
    }
    mostrarEcra('ecra-vendedor');
    renderPainelVendedor();
}

// --------------------------------------------------------------------------
// AUTENTICAÇÃO
// --------------------------------------------------------------------------
function mudarModoAuth(modo) {
    modoAuth = modo;
    const criar = modo === 'criar';

    $('tab-entrar').classList.toggle('ativo', !criar);
    $('tab-criar').classList.toggle('ativo', criar);
    $('tab-entrar').setAttribute('aria-selected', String(!criar));
    $('tab-criar').setAttribute('aria-selected', String(criar));

    $('grupo-nome').classList.toggle('oculto', !criar);
    $('auth-nome').required = criar;
    $('auth-password').autocomplete = criar ? 'new-password' : 'current-password';
    $('btn-submit-auth').innerHTML = criar
        ? '<i class="fas fa-user-plus" aria-hidden="true"></i> Criar conta'
        : 'Entrar <i class="fas fa-arrow-right" aria-hidden="true"></i>';
}

function iniciarSessao(utilizador) {
    usuarioAtual = {
        id: utilizador.id,
        nome: utilizador.nome,
        contacto: utilizador.contacto,
        tipo: utilizador.tipo === 'vendedor' ? 'vendedor' : 'cliente'
    };
    guardarJSON(CHAVES.sessao, usuarioAtual);
    carregarCarrinho();
    $('form-auth').reset();
    irParaHome();
}

async function processarAutenticacao(evento) {
    evento.preventDefault();

    const botao = $('btn-submit-auth');
    const contacto = normalizarContacto($('auth-contacto').value);
    const senha = $('auth-password').value;

    if (!ehTelefone(contacto) && !ehEmail(contacto)) {
        mostrarToast('Insira um telemóvel (9 dígitos) ou um email válido.', 'exclamation-circle');
        return;
    }
    if (!senha) {
        mostrarToast('Insira a palavra-passe.', 'exclamation-circle');
        return;
    }

    botao.disabled = true;
    try {
        const utilizadores = lerJSON(CHAVES.utilizadores, []);

        if (modoAuth === 'criar') {
            const nome = $('auth-nome').value.trim().replace(/\s+/g, ' ');
            const tipo = 'utilizador';

            if (nome.length < 2) {
                mostrarToast('Por favor, insira o seu nome completo.', 'exclamation-circle');
                return;
            }
            if (senha.length < 6) {
                mostrarToast('A palavra-passe deve ter pelo menos 6 caracteres.', 'exclamation-circle');
                return;
            }
            if (utilizadores.some((u) => normalizarContacto(u.contacto) === contacto)) {
                mostrarToast('Este contacto já se encontra registado.', 'exclamation-circle');
                return;
            }

            const sal = gerarSal();
            const novo = { id: contacto, nome, contacto, tipo, sal, hash: await hashTexto(senha, sal) };
            utilizadores.push(novo);
            if (!guardarJSON(CHAVES.utilizadores, utilizadores)) return;

            mostrarToast('Conta criada com sucesso!');
            iniciarSessao(novo);
            return;
        }

        // Entrar
        const utilizador = utilizadores.find((u) => normalizarContacto(u.contacto) === contacto);
        let valido = false;

        if (utilizador) {
            if (utilizador.hash) {
                valido = (await hashTexto(senha, utilizador.sal)) === utilizador.hash;
            } else if (typeof utilizador.password === 'string') {
                // Conta antiga com palavra-passe em texto simples: valida e converte para hash
                valido = utilizador.password === senha.trim();
                if (valido) {
                    utilizador.sal = gerarSal();
                    utilizador.hash = await hashTexto(senha.trim(), utilizador.sal);
                    delete utilizador.password;
                    utilizador.id = utilizador.id || normalizarContacto(utilizador.contacto);
                    guardarJSON(CHAVES.utilizadores, utilizadores);
                }
            }
        }

        if (!valido) {
            mostrarToast('Contacto ou palavra-passe incorretos.', 'exclamation-circle');
            return;
        }

        utilizador.id = utilizador.id || normalizarContacto(utilizador.contacto);
        mostrarToast(`Bem-vindo de volta, ${utilizador.nome}!`);
        iniciarSessao(utilizador);
    } catch (e) {
        mostrarToast('Não foi possível processar. Abra o site por HTTPS ou localhost.', 'exclamation-circle');
    } finally {
        botao.disabled = false;
    }
}

function realizarLogout() {
    usuarioAtual = null;
    carrinho = [];
    localStorage.removeItem(CHAVES.sessao);
    atualizarBadgeCarrinho();
    mostrarToast('Sessão terminada.', 'info-circle');
    mudarModoAuth('entrar');
    mostrarEcra('ecra-auth');
}

function restaurarSessao() {
    const guardada = lerJSON(CHAVES.sessao, null);
    if (!guardada || !guardada.nome || !guardada.contacto) return null;
    return {
        id: guardada.id || normalizarContacto(guardada.contacto),
        nome: String(guardada.nome),
        contacto: String(guardada.contacto),
        tipo: guardada.tipo === 'vendedor' ? 'vendedor' : 'cliente'
    };
}

// --------------------------------------------------------------------------
// PRODUTOS
// --------------------------------------------------------------------------
function lerProdutos() {
    const lista = lerJSON(CHAVES.produtos, []);
    return Array.isArray(lista) ? lista.filter((p) => p && p.id && p.nome) : [];
}

// Produtos antigos (sem estado) contam como publicados
const ehPublicado = (p) => p.estado !== 'pendente';
const lerProdutosPublicados = () => lerProdutos().filter(ehPublicado);

function abrirModalNovoProduto() {
    if (!ehVendedor()) {
        mostrarToast('Só contas de vendedor podem publicar produtos.', 'exclamation-circle');
        return;
    }
    abrirModal('modal-produto');
}

function lerImagemComprimida(ficheiro, max = 800, qualidade = 0.78) {
    return new Promise((resolve, reject) => {
        if (!ficheiro.type.startsWith('image/')) return reject(new Error('Ficheiro inválido'));
        if (ficheiro.size > 10 * 1024 * 1024) return reject(new Error('A imagem tem mais de 10 MB'));

        const url = URL.createObjectURL(ficheiro);
        const img = new Image();
        img.onload = () => {
            const fator = Math.min(1, max / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * fator));
            canvas.height = Math.max(1, Math.round(img.height * fator));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/jpeg', qualidade));
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Não foi possível ler a imagem'));
        };
        img.src = url;
    });
}

async function guardarNovoProduto(evento) {
    evento.preventDefault();
    if (!ehVendedor()) return;

    const botao = $('btn-submit-produto');
    const nome = $('prod-nome').value.trim().replace(/\s+/g, ' ');
    const valor = Number($('prod-valor').value);
    const categoria = $('prod-categoria').value;
    const contacto = normalizarContacto($('prod-contacto').value);
    const ficheiro = $('prod-foto').files[0];

    if (nome.length < 2) return mostrarToast('Insira o nome do produto.', 'exclamation-circle');
    if (!Number.isFinite(valor) || valor < VALOR_MINIMO) return mostrarToast(`O valor mínimo para publicar é ${kz(VALOR_MINIMO)}.`, 'exclamation-circle');
    if (!CATEGORIAS.includes(categoria)) return mostrarToast('Escolha uma categoria.', 'exclamation-circle');
    if (!ehTelefone(contacto)) return mostrarToast('Insira um telemóvel válido (9 dígitos).', 'exclamation-circle');

    const taxa = calcularTaxa(Math.round(valor));
    if (!confirm(`Para este produto ser publicado, tem de pagar uma taxa de ${kz(taxa)}. Não há comissão sobre a venda. Continuar?`)) return;

    botao.disabled = true;
    try {
        const foto = ficheiro ? await lerImagemComprimida(ficheiro) : '';
        const produtos = lerProdutos();
        const novoId = String(Date.now());

        produtos.push({
            id: novoId,
            nome,
            valor: Math.round(valor),
            taxa,
            estado: 'pendente',
            referencia: gerarReferencia(novoId),
            categoria,
            contacto,
            vendedor: usuarioAtual.nome,
            vendedorId: usuarioAtual.id,
            foto
        });

        if (!guardarJSON(CHAVES.produtos, produtos)) return;

        $('form-produto').reset();
        atualizarInfoTaxa();
        $('prod-foto-texto').textContent = 'Toque para carregar a foto do produto';
        fecharModal('modal-produto');
        mostrarToast('Produto guardado. Pague a taxa para o publicar.', 'info-circle');
        mostrarPagamento(novoId);

        if (!$('ecra-cliente').classList.contains('oculto')) {
            renderChips();
            renderMarketplace();
        }
        if (!$('ecra-vendedor').classList.contains('oculto')) renderPainelVendedor();
    } catch (e) {
        mostrarToast(e.message || 'Não foi possível publicar o produto.', 'exclamation-circle');
    } finally {
        botao.disabled = false;
    }
}

function ehMeuProduto(p) {
    if (!usuarioAtual) return false;
    if (p.vendedorId) return p.vendedorId === usuarioAtual.id;
    return p.vendedor === usuarioAtual.nome; // produtos antigos, sem vendedorId
}

function apagarProduto(id) {
    const produtos = lerProdutos();
    const produto = produtos.find((p) => p.id === id);
    if (!produto || !ehMeuProduto(produto)) return;
    if (!confirm(`Apagar "${produto.nome}"?`)) return;

    guardarJSON(CHAVES.produtos, produtos.filter((p) => p.id !== id));
    carrinho = carrinho.filter((i) => i.id !== id);
    guardarCarrinho();
    atualizarBadgeCarrinho();
    renderPainelVendedor();
    mostrarToast('Produto apagado.', 'info-circle');
}

// --------------------------------------------------------------------------
// PAINEL DO VENDEDOR
// --------------------------------------------------------------------------
function gerarReferencia(id) {
    return 'KPS-' + String(id).slice(-5);
}

async function copiarTexto(texto) {
    try {
        await navigator.clipboard.writeText(texto);
        mostrarToast('Copiado!');
    } catch (e) {
        mostrarToast('Não foi possível copiar. Selecione o texto e copie manualmente.', 'exclamation-circle');
    }
}

// Mostra ao vendedor para onde pagar a taxa de publicação
function mostrarPagamento(id) {
    const p = lerProdutos().find((x) => x.id === id);
    if (!p || p.estado !== 'pendente' || !ehMeuProduto(p)) return;

    const linhas = [];
    if (PAGAMENTO.titular) linhas.push({ rotulo: 'Titular', valor: PAGAMENTO.titular, copiar: false });
    if (PAGAMENTO.iban) linhas.push({ rotulo: 'IBAN', valor: PAGAMENTO.iban, copiar: true });
    if (PAGAMENTO.express) linhas.push({ rotulo: 'Multicaixa Express', valor: PAGAMENTO.express, copiar: true });
    const temDados = Boolean(PAGAMENTO.iban || PAGAMENTO.express);
    if (temDados) linhas.push({ rotulo: 'Referência', valor: p.referencia, copiar: true });

    const mensagem = `Olá! Paguei a taxa de publicação de ${kz(p.taxa)} do produto "${p.nome}" (ref. ${p.referencia}). Segue o comprovativo.`;
    const numero = normalizarContacto(PAGAMENTO.express);
    const link = ehTelefone(numero) ? `https://wa.me/244${numero}?text=${encodeURIComponent(mensagem)}` : '';

    const linhasHtml = linhas.map((l) => `
        <div class="dado-linha">
            <span>${esc(l.rotulo)}</span>
            <strong>${esc(l.valor)}</strong>
            ${l.copiar
                ? `<button type="button" class="btn-copiar" data-action="copiar" data-valor="${esc(l.valor)}" aria-label="Copiar ${esc(l.rotulo)}">
                       <i class="fas fa-copy" aria-hidden="true"></i>
                   </button>`
                : '<span></span>'}
        </div>`).join('');

    $('pagamento-conteudo').innerHTML = `
        <p class="resultado-intro">Para publicar <strong>${esc(p.nome)}</strong>, pague a taxa de publicação e indique a referência.</p>
        <div class="pagamento-valor">${esc(kz(p.taxa))}</div>
        ${temDados
            ? `<div class="dados-pagamento">${linhasHtml}</div>`
            : '<p class="taxa-info erro">Os dados de pagamento ainda não foram configurados. Contacte o administrador.</p>'}
        <p class="taxa-info">O produto aparece no market assim que o pagamento for confirmado.</p>
        ${link
            ? `<a class="btn-principal btn-bloco" href="${esc(link)}" target="_blank" rel="noopener">
                   <i class="fab fa-whatsapp" aria-hidden="true"></i> Enviar comprovativo
               </a>`
            : ''}
        <button type="button" class="btn-secundario btn-bloco" data-action="fechar-pagamento">Fechar</button>`;
    abrirModal('modal-pagamento');
}

function renderPainelVendedor() {
    if (!ehVendedor()) return;
    const meus = lerProdutos().filter(ehMeuProduto);
    const publicados = meus.filter(ehPublicado);

    $('stat-total-produtos').textContent = publicados.length;
    $('stat-valor-catalogo').textContent = kz(publicados.reduce((soma, p) => soma + Number(p.valor || 0), 0));

    const lista = $('lista-meus-produtos');
    if (!meus.length) {
        lista.innerHTML = `
            <div class="estado-vazio">
                <i class="fas fa-box-open" aria-hidden="true"></i>
                <p>Ainda não publicou nenhum produto.</p>
                <button type="button" class="btn-principal btn-sm" data-action="abrir-novo-produto">Publicar o primeiro produto</button>
            </div>`;
        return;
    }

    lista.innerHTML = meus.map((p) => `
        <div class="meu-produto">
            <img src="${esc(srcFoto(p.foto))}" alt="" loading="lazy">
            <div class="meu-produto-info">
                <strong>${esc(p.nome)}</strong>
                <span>${esc(kz(p.valor))}</span>
                ${ehPublicado(p)
                    ? '<em class="estado estado-publicado">Publicado</em>'
                    : '<em class="estado estado-pendente">A aguardar pagamento da taxa</em>'}
            </div>
            <div class="meu-produto-acoes">
                ${ehPublicado(p) ? '' : `<button type="button" class="btn-principal btn-sm" data-action="ver-pagamento" data-id="${esc(p.id)}">Pagar taxa</button>`}
                <button type="button" class="btn-perigo" data-action="apagar-produto" data-id="${esc(p.id)}"
                        aria-label="Apagar ${esc(p.nome)}">
                    <i class="fas fa-trash-alt" aria-hidden="true"></i>
                </button>
            </div>
        </div>`).join('');
}

// --------------------------------------------------------------------------
// MARKETPLACE: PESQUISA, FILTROS E LISTAGEM
// --------------------------------------------------------------------------
function renderChips() {
    const todas = ['Todas', ...CATEGORIAS];
    $('chips-categorias').innerHTML = todas.map((cat) => `
        <button type="button" class="chip${cat === filtros.categoria ? ' ativo' : ''}"
                data-action="filtrar-categoria" data-cat="${esc(cat)}"
                aria-pressed="${cat === filtros.categoria}">${esc(cat)}</button>`).join('');
}

function renderMarketplace() {
    const lista = $('lista-produtos-cliente');
    const termo = filtros.termo.trim().toLowerCase();

    let produtos = lerProdutosPublicados().filter((p) => {
        const categoria = CATEGORIAS.includes(p.categoria) ? p.categoria : 'Outros';
        const passaCategoria = filtros.categoria === 'Todas' || categoria === filtros.categoria;
        const passaTermo = !termo || p.nome.toLowerCase().includes(termo);
        return passaCategoria && passaTermo;
    });

    const ordenar = {
        'recentes': (a, b) => Number(b.id) - Number(a.id),
        'preco-asc': (a, b) => Number(a.valor) - Number(b.valor),
        'preco-desc': (a, b) => Number(b.valor) - Number(a.valor),
        'nome': (a, b) => a.nome.localeCompare(b.nome, 'pt')
    };
    produtos.sort(ordenar[filtros.ordem] || ordenar.recentes);

    $('contador-produtos').textContent = produtos.length === 1 ? '1 produto' : `${produtos.length} produtos`;

    if (!produtos.length) {
        const filtrado = termo || filtros.categoria !== 'Todas';
        lista.innerHTML = `
            <div class="estado-vazio">
                <i class="fas fa-store-slash" aria-hidden="true"></i>
                <p>${filtrado ? 'Nenhum produto corresponde à sua pesquisa.' : 'Ainda não há produtos publicados.'}</p>
                ${ehVendedor() && !filtrado
                    ? '<button type="button" class="btn-principal btn-sm" data-action="abrir-novo-produto">Publicar um produto</button>'
                    : ''}
            </div>`;
        return;
    }

    lista.innerHTML = produtos.map((p) => {
        const categoria = CATEGORIAS.includes(p.categoria) ? p.categoria : 'Outros';
        const meu = ehMeuProduto(p);
        return `
            <article class="produto-card">
                <img src="${esc(srcFoto(p.foto))}" alt="${esc(p.nome)}" width="300" height="150" loading="lazy" decoding="async">
                <span class="tag-categoria">${esc(categoria)}</span>
                <h4 class="produto-nome">${esc(p.nome)}</h4>
                <p class="produto-vendedor">Vendedor: ${esc(p.vendedor)}</p>
                <div class="produto-info-bottom">
                    <div class="produto-preco">${esc(kz(p.valor))}</div>
                    <button type="button" class="btn-principal btn-compacto" data-action="add-carrinho"
                            data-id="${esc(p.id)}" ${meu ? 'disabled title="Este produto é seu"' : ''}>
                        <i class="fas fa-cart-plus" aria-hidden="true"></i> ${meu ? 'O seu produto' : 'Adicionar'}
                    </button>
                </div>
            </article>`;
    }).join('');
}

// --------------------------------------------------------------------------
// CARRINHO
// --------------------------------------------------------------------------
function chaveCarrinho() {
    return `${CHAVES.carrinhoLegado}_${usuarioAtual ? usuarioAtual.id : 'anonimo'}`;
}

function guardarCarrinho() {
    if (usuarioAtual) guardarJSON(chaveCarrinho(), carrinho);
}

function carregarCarrinho() {
    let dados = lerJSON(chaveCarrinho(), null);

    if (dados === null) {
        // Migra o carrinho antigo (partilhado) para esta conta, uma única vez
        dados = lerJSON(CHAVES.carrinhoLegado, []);
        localStorage.removeItem(CHAVES.carrinhoLegado);
    }

    const mapa = new Map();
    (Array.isArray(dados) ? dados : []).forEach((item) => {
        if (!item || !item.id) return;
        const qty = Math.max(1, Math.min(99, parseInt(item.qty, 10) || 1));
        mapa.set(item.id, Math.min(99, (mapa.get(item.id) || 0) + qty));
    });
    carrinho = Array.from(mapa, ([id, qty]) => ({ id, qty }));
    guardarCarrinho();
    atualizarBadgeCarrinho();
}

// Junta o carrinho com os dados atuais dos produtos (preços sempre atualizados)
function itensDetalhados() {
    const mapa = new Map(lerProdutosPublicados().map((p) => [p.id, p]));
    return carrinho
        .map((item) => ({ ...item, produto: mapa.get(item.id) }))
        .filter((item) => item.produto);
}

function atualizarBadgeCarrinho() {
    const total = carrinho.reduce((soma, i) => soma + i.qty, 0);
    const badge = $('badge-carrinho');
    badge.textContent = total;
    badge.classList.toggle('oculto', total === 0);
}

function adicionarAoCarrinho(id) {
    const produto = lerProdutosPublicados().find((p) => p.id === id);
    if (!produto) return mostrarToast('Este produto já não está disponível.', 'exclamation-circle');
    if (ehMeuProduto(produto)) return mostrarToast('Não pode comprar o seu próprio produto.', 'exclamation-circle');

    const existente = carrinho.find((i) => i.id === id);
    if (existente) {
        if (existente.qty >= 99) return mostrarToast('Quantidade máxima atingida.', 'exclamation-circle');
        existente.qty += 1;
    } else {
        carrinho.push({ id, qty: 1 });
    }
    guardarCarrinho();
    atualizarBadgeCarrinho();
    mostrarToast('Produto adicionado ao carrinho!');
}

function alterarQuantidade(id, delta) {
    const item = carrinho.find((i) => i.id === id);
    if (!item) return;
    item.qty = Math.max(1, Math.min(99, item.qty + delta));
    guardarCarrinho();
    atualizarBadgeCarrinho();
    renderCarrinho();
}

function removerDoCarrinho(id) {
    carrinho = carrinho.filter((i) => i.id !== id);
    guardarCarrinho();
    atualizarBadgeCarrinho();
    renderCarrinho();
    mostrarToast('Produto removido do carrinho.', 'info-circle');
}

function renderCarrinho() {
    const lista = $('itens-carrinho-lista');
    const itens = itensDetalhados();

    // Remove do carrinho produtos que já não existem
    if (itens.length !== carrinho.length) {
        carrinho = itens.map(({ id, qty }) => ({ id, qty }));
        guardarCarrinho();
        atualizarBadgeCarrinho();
    }

    $('btn-finalizar').disabled = itens.length === 0;

    if (!itens.length) {
        lista.innerHTML = '<p class="carrinho-vazio">O seu carrinho está vazio.</p>';
        $('carrinho-total-valor').textContent = kz(0);
        return;
    }

    let total = 0;
    lista.innerHTML = itens.map(({ produto: p, qty }) => {
        total += Number(p.valor) * qty;
        return `
            <div class="carrinho-item">
                <img src="${esc(srcFoto(p.foto))}" alt="" loading="lazy">
                <div class="carrinho-item-info">
                    <strong>${esc(p.nome)}</strong>
                    <small>${esc(kz(Number(p.valor) * qty))}</small>
                </div>
                <div class="qtd">
                    <button type="button" data-action="qtd-menos" data-id="${esc(p.id)}" aria-label="Diminuir quantidade">&minus;</button>
                    <span>${qty}</span>
                    <button type="button" data-action="qtd-mais" data-id="${esc(p.id)}" aria-label="Aumentar quantidade">+</button>
                </div>
                <button type="button" class="btn-perigo" data-action="remover-carrinho" data-id="${esc(p.id)}"
                        aria-label="Remover ${esc(p.nome)}">
                    <i class="fas fa-trash-alt" aria-hidden="true"></i>
                </button>
            </div>`;
    }).join('');

    $('carrinho-total-valor').textContent = kz(total);
}

function abrirCarrinho() {
    $('carrinho-corpo').classList.remove('oculto');
    $('carrinho-resultado').classList.add('oculto');
    renderCarrinho();
    abrirModal('modal-carrinho');
}

function fecharCarrinho() {
    fecharModal('modal-carrinho');
}

function finalizarSolicitacaoCompra() {
    const itens = itensDetalhados();
    if (!itens.length) return;

    // Agrupa por vendedor para enviar uma mensagem por vendedor
    const grupos = new Map();
    itens.forEach(({ produto: p, qty }) => {
        const chave = p.contacto || p.vendedor;
        if (!grupos.has(chave)) grupos.set(chave, { vendedor: p.vendedor, contacto: p.contacto, itens: [], subtotal: 0 });
        const grupo = grupos.get(chave);
        grupo.itens.push({ nome: p.nome, qty, valor: Number(p.valor) });
        grupo.subtotal += Number(p.valor) * qty;
    });

    renderResultadoCompra(Array.from(grupos.values()));

    carrinho = [];
    guardarCarrinho();
    atualizarBadgeCarrinho();
    mostrarToast('Pedido registado! Contacte os vendedores.');
}

function linkContacto(grupo) {
    const linhas = grupo.itens.map((i) => `- ${i.qty}x ${i.nome} (${kz(i.valor)})`).join('\n');
    const mensagem = `Olá! Vi no Kopesa Express:\n${linhas}\nTotal: ${kz(grupo.subtotal)}.\nPodemos combinar a entrega e o pagamento?`;
    const contacto = normalizarContacto(grupo.contacto);

    if (ehTelefone(contacto)) return `https://wa.me/244${contacto}?text=${encodeURIComponent(mensagem)}`;
    if (ehEmail(contacto)) return `mailto:${contacto}?subject=${encodeURIComponent('Pedido Kopesa Express')}&body=${encodeURIComponent(mensagem)}`;
    return '';
}

function renderResultadoCompra(grupos) {
    const blocos = grupos.map((g) => {
        const link = linkContacto(g);
        return `
            <div class="resultado-vendedor">
                <h4>${esc(g.vendedor)}</h4>
                <ul>${g.itens.map((i) => `<li>${i.qty}x ${esc(i.nome)}</li>`).join('')}</ul>
                ${link
                    ? `<a class="btn-principal btn-compacto" href="${esc(link)}" target="_blank" rel="noopener">
                           <i class="fab fa-whatsapp" aria-hidden="true"></i> Falar com o vendedor
                       </a>`
                    : `<p class="resultado-intro">Contacto: ${esc(g.contacto || 'não indicado')}</p>`}
            </div>`;
    }).join('');

    $('carrinho-resultado').innerHTML = `
        <p class="resultado-intro">Combine a entrega e o pagamento diretamente com cada vendedor:</p>
        ${blocos}
        <button type="button" class="btn-secundario" style="width:100%" data-action="fechar-carrinho">Fechar</button>`;

    $('carrinho-corpo').classList.add('oculto');
    $('carrinho-resultado').classList.remove('oculto');
}

// --------------------------------------------------------------------------
// ADMINISTRAÇÃO
// --------------------------------------------------------------------------
function lerFinanceiro() {
    const dados = lerJSON(CHAVES.financeiro, {});
    const numero = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return {
        taxas: numero(dados.taxas),
        saldo: numero(dados.saldo),
        publicacoes: numero(dados.publicacoes),
        registos: Array.isArray(dados.registos) ? dados.registos : []
    };
}

function registarTaxa({ produto, vendedor, taxa }) {
    const dados = lerFinanceiro();
    dados.taxas = arredondar(dados.taxas + taxa);
    dados.saldo = arredondar(dados.saldo + taxa);
    dados.publicacoes += 1;
    dados.registos.unshift({ produto, vendedor, taxa, data: new Date().toISOString() });
    dados.registos = dados.registos.slice(0, 50);
    guardarJSON(CHAVES.financeiro, dados);
}

// Mostra a taxa em tempo real enquanto o vendedor escreve o valor
function atualizarInfoTaxa() {
    const info = $('taxa-info');
    if (!info) return;

    const valor = Math.round(Number($('prod-valor').value));
    const menor = TABELA_TAXAS[0].taxa;
    const maior = TABELA_TAXAS[TABELA_TAXAS.length - 1].taxa;

    info.classList.remove('erro');
    if (!valor) {
        info.textContent = `Taxa de publicação: de ${kz(menor)} a ${kz(maior)}, conforme o valor. Sem comissão sobre a venda.`;
    } else if (valor < VALOR_MINIMO) {
        info.classList.add('erro');
        info.textContent = `O valor mínimo para publicar é ${kz(VALOR_MINIMO)}.`;
    } else {
        info.textContent = `Taxa de publicação: ${kz(calcularTaxa(valor))}. Sem comissão sobre a venda.`;
    }
}

function renderListaTaxas(registos) {
    const lista = $('admin-lista-taxas');
    if (!registos.length) {
        lista.innerHTML = '<p class="carrinho-vazio">Ainda não há taxas registadas.</p>';
        return;
    }
    lista.innerHTML = registos.slice(0, 20).map((r) => {
        const data = new Date(r.data);
        const dataTexto = Number.isNaN(data.getTime()) ? '' : data.toLocaleDateString('pt-PT');
        return `
            <div class="taxa-linha">
                <div class="taxa-linha-info">
                    <strong>${esc(r.produto)}</strong>
                    <span>Vendedor: ${esc(r.vendedor)}${dataTexto ? `, ${esc(dataTexto)}` : ''}</span>
                </div>
                <b>${esc(kz(r.taxa))}</b>
            </div>`;
    }).join('');
}

function solicitarPinAdmin() {
    $('input-pin').value = '';
    abrirModal('modal-pin');
}

async function verificarPinAdmin(evento) {
    evento.preventDefault();

    if (Date.now() < bloqueadoAte) {
        const segundos = Math.ceil((bloqueadoAte - Date.now()) / 1000);
        return mostrarToast(`Demasiadas tentativas. Aguarde ${segundos}s.`, 'exclamation-circle');
    }

    const pin = $('input-pin').value.trim();
    try {
        if (pin && (await hashTexto(pin, PIN_SAL)) === PIN_HASH) {
            tentativasPin = 0;
            fecharModal('modal-pin');
            estaAdmin = true;
            abrirPainelAdmin();
            return;
        }
    } catch (e) {
        return mostrarToast('Abra o site por HTTPS ou localhost para usar esta área.', 'exclamation-circle');
    }

    tentativasPin += 1;
    $('input-pin').value = '';
    if (tentativasPin >= 5) {
        tentativasPin = 0;
        bloqueadoAte = Date.now() + 60000;
        mostrarToast('PIN incorreto. Bloqueado durante 60 segundos.', 'exclamation-circle');
    } else {
        mostrarToast('PIN incorreto.', 'exclamation-circle');
    }
}

function abrirPainelAdmin() {
    if (!estaAdmin) return;
    mostrarEcra('ecra-admin');
    estaAdmin = true; // mostrarEcra repõe a flag; aqui o acesso já foi validado
    renderPainelAdmin();
}

function renderPainelAdmin() {
    const dados = lerFinanceiro();
    $('admin-total-taxas').textContent = kz(dados.taxas);
    $('admin-saldo').textContent = kz(dados.saldo);
    $('admin-total-publicacoes').textContent = dados.publicacoes;
    renderPendentes();
    renderListaTaxas(dados.registos);
}

function renderPendentes() {
    const lista = $('admin-lista-pendentes');
    const pendentes = lerProdutos().filter((p) => p.estado === 'pendente');

    if (!pendentes.length) {
        lista.innerHTML = '<p class="carrinho-vazio">Nenhum pagamento por confirmar.</p>';
        return;
    }

    lista.innerHTML = pendentes.map((p) => `
        <div class="taxa-linha">
            <div class="taxa-linha-info">
                <strong>${esc(p.nome)}</strong>
                <span>Vendedor: ${esc(p.vendedor)}, contacto ${esc(p.contacto || '')}, ref. ${esc(p.referencia || '')}</span>
            </div>
            <div class="taxa-acoes">
                <b>${esc(kz(p.taxa))}</b>
                <button type="button" class="btn-principal btn-sm" data-action="confirmar-pagamento" data-id="${esc(p.id)}">Confirmar</button>
                <button type="button" class="btn-perigo" data-action="recusar-produto" data-id="${esc(p.id)}"
                        aria-label="Recusar ${esc(p.nome)}"><i class="fas fa-times" aria-hidden="true"></i></button>
            </div>
        </div>`).join('');
}

function confirmarPagamento(id) {
    if (!estaAdmin) return;
    const produtos = lerProdutos();
    const produto = produtos.find((p) => p.id === id && p.estado === 'pendente');
    if (!produto) return;
    if (!confirm(`Confirma que recebeu ${kz(produto.taxa)} de ${produto.vendedor} (ref. ${produto.referencia})?`)) return;

    produto.estado = 'publicado';
    if (!guardarJSON(CHAVES.produtos, produtos)) return;
    registarTaxa({ produto: produto.nome, vendedor: produto.vendedor, taxa: Number(produto.taxa) || 0 });

    renderPainelAdmin();
    mostrarToast('Pagamento confirmado. Produto publicado!');
}

function recusarProduto(id) {
    if (!estaAdmin) return;
    const produtos = lerProdutos();
    const produto = produtos.find((p) => p.id === id && p.estado === 'pendente');
    if (!produto) return;
    if (!confirm(`Recusar e remover "${produto.nome}"?`)) return;

    guardarJSON(CHAVES.produtos, produtos.filter((p) => p.id !== id));
    renderPainelAdmin();
    mostrarToast('Produto removido.', 'info-circle');
}

function realizarSaqueAdmin(evento) {
    evento.preventDefault();
    if (!estaAdmin) return mostrarToast('Sessão de administrador expirada.', 'exclamation-circle');

    const conta = $('admin-conta-saque').value.replace(/[\s\-]/g, '').toUpperCase();
    const valor = Number($('admin-valor-saque').value);

    const contaValida = /^AO\d{23}$/.test(conta) || ehTelefone(normalizarContacto(conta));
    if (!contaValida) return mostrarToast('Insira um IBAN angolano (AO + 23 dígitos) ou telemóvel válido.', 'exclamation-circle');
    if (!Number.isFinite(valor) || valor <= 0) return mostrarToast('Insira um valor maior que zero.', 'exclamation-circle');

    const dados = lerFinanceiro();
    if (valor > dados.saldo) return mostrarToast('Saldo insuficiente.', 'exclamation-circle');

    dados.saldo = arredondar(dados.saldo - valor);
    guardarJSON(CHAVES.financeiro, dados);

    $('form-saque').reset();
    mostrarToast(`Levantamento de ${kz(valor)} registado.`);
    abrirPainelAdmin();
}

// --------------------------------------------------------------------------
// EVENTOS
// --------------------------------------------------------------------------
const ACOES = {
    'ir-home': () => irParaHome(),
    'ir-marketplace': () => irParaMarketplace(),
    'ir-vendedor': () => irParaPainelVendedor(),
    'voltar-escolha': () => irParaHome(),
    'logout': () => realizarLogout(),
    'modo-auth': (el) => mudarModoAuth(el.dataset.modo),
    'abrir-novo-produto': () => abrirModalNovoProduto(),
    'fechar-novo-produto': () => fecharModal('modal-produto'),
    'abrir-carrinho': () => abrirCarrinho(),
    'fechar-carrinho': () => fecharCarrinho(),
    'finalizar-compra': () => finalizarSolicitacaoCompra(),
    'abrir-pin': () => solicitarPinAdmin(),
    'fechar-pin': () => fecharModal('modal-pin'),
    'add-carrinho': (el) => adicionarAoCarrinho(el.dataset.id),
    'qtd-mais': (el) => alterarQuantidade(el.dataset.id, 1),
    'qtd-menos': (el) => alterarQuantidade(el.dataset.id, -1),
    'remover-carrinho': (el) => removerDoCarrinho(el.dataset.id),
    'apagar-produto': (el) => apagarProduto(el.dataset.id),
    'ver-pagamento': (el) => mostrarPagamento(el.dataset.id),
    'fechar-pagamento': () => fecharModal('modal-pagamento'),
    'copiar': (el) => copiarTexto(el.dataset.valor),
    'confirmar-pagamento': (el) => confirmarPagamento(el.dataset.id),
    'recusar-produto': (el) => recusarProduto(el.dataset.id),
    'filtrar-categoria': (el) => {
        filtros.categoria = el.dataset.cat;
        renderChips();
        renderMarketplace();
    }
};

function iniciarEventos() {
    document.addEventListener('click', (e) => {
        // Clicar fora do conteúdo do modal fecha-o
        if (e.target.classList && e.target.classList.contains('modal')) {
            fecharModal(e.target.id);
            return;
        }
        const el = e.target.closest('[data-action]');
        if (!el || el.disabled) return;
        const acao = ACOES[el.dataset.action];
        if (acao) acao(el);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') fecharModalAberto();
    });

    $('form-auth').addEventListener('submit', processarAutenticacao);
    $('form-produto').addEventListener('submit', guardarNovoProduto);
    $('form-pin').addEventListener('submit', verificarPinAdmin);
    $('form-saque').addEventListener('submit', realizarSaqueAdmin);

    $('input-pesquisa-produto').addEventListener('input', (e) => {
        clearTimeout(temporizadorPesquisa);
        temporizadorPesquisa = setTimeout(() => {
            filtros.termo = e.target.value;
            renderMarketplace();
        }, 150);
    });

    $('select-ordem').addEventListener('change', (e) => {
        filtros.ordem = e.target.value;
        renderMarketplace();
    });

    $('prod-valor').addEventListener('input', atualizarInfoTaxa);

    $('prod-foto').addEventListener('change', (e) => {
        const ficheiro = e.target.files[0];
        $('prod-foto-texto').textContent = ficheiro ? `Foto selecionada: ${ficheiro.name}` : 'Toque para carregar a foto do produto';
    });
}

// Produto de teste, criado uma única vez para experimentar o carrinho.
// Para o remover, apague esta função e a chamada em iniciar().
function semearProdutoDemo() {
    const CHAVE_DEMO = 'kopesa_demo_semeado';
    if (localStorage.getItem(CHAVE_DEMO)) return;

    const produtos = lerProdutos();
    produtos.push({
        id: 'demo-1',
        nome: 'Ténis Nike Air Max (produto de teste)',
        valor: 25000,
        categoria: 'Moda',
        contacto: '923456789',
        vendedor: 'Loja Teste',
        vendedorId: 'loja-teste',
        foto: ''
    });
    if (guardarJSON(CHAVES.produtos, produtos)) localStorage.setItem(CHAVE_DEMO, '1');
}

function iniciar() {
    semearProdutoDemo();
    $('prod-categoria').innerHTML =
        '<option value="">Selecione a categoria</option>' +
        CATEGORIAS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

    iniciarEventos();
    mudarModoAuth('entrar');
    atualizarInfoTaxa();

    usuarioAtual = restaurarSessao();
    if (usuarioAtual) {
        guardarJSON(CHAVES.sessao, usuarioAtual); // remove campos antigos (ex.: palavra-passe) da sessão
        carregarCarrinho();
    }
    irParaHome();
}

document.addEventListener('DOMContentLoaded', iniciar);