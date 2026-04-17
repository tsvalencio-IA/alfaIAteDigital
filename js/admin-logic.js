// NOME DO ARQUIVO: admin-logic.js
// LOCALIZAÇÃO: Dentro da pasta 'js'

import { auth, database, signInWithEmailAndPassword, signOut, onAuthStateChanged, ref, set, onValue, get } from './firebase-config.js';
import { atualizarPromptMemoria, systemPrompt as promptPadraoDaAPI, conversarComDesenvolvedorIA, analisarEGerarProcessoAIMP } from './gemini-api.js';

document.addEventListener('DOMContentLoaded', () => {
    
    // Auth & Inputs Básicos
    const emailInput = document.getElementById('email-admin');
    const senhaInput = document.getElementById('senha-admin');
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    const erroMsg = document.getElementById('msg-erro-login');
    
    const apiKeyInput = document.getElementById('api-key-input');
const groqKeyInput = document.getElementById('groq-key-input');
    const geminiVoiceInput = document.getElementById('gemini-voice-input');
    const githubTokenInput = document.getElementById('github-token-input');
    const githubRepoInput = document.getElementById('github-repo-input');
    
    // Áreas Principais
    const gridLeads = document.getElementById('view-crm');
    const viewProcessos = document.getElementById('view-processos');
    
    let usuarioLogado = null;
    let listaDeClientesGlobais = [];
    let abaAtiva = 'novos'; // 'novos', 'concluidos', 'processos'
    let contextoProjetoAtual = ""; 
    let idProjetoAberto = null;
    let historicoDevAtual = [];
    let bufferArquivosAnexados = "";
    let unsubFeedbacks = null;

    function escapeHtml(unsafe) {
        return (unsafe || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    function formatarCodigoIA(texto) {
        if(!texto) return "";
        let textoFormatado = String(texto).replace(/```(html|javascript|js|css|json)?\n([\s\S]*?)```/gi, function(match, lang, code) {
            const linguagem = lang ? lang.toLowerCase() : 'código';
            const safeCode = escapeHtml(code);
            const blockId = 'code-' + Math.random().toString(36).substr(2, 9);
            
            let botoes = `<button onclick="navigator.clipboard.writeText(document.getElementById('${blockId}').innerText); this.innerText='Copiado!'; setTimeout(()=>this.innerText='Copiar',2000)" class="bg-slate-700 hover:bg-slate-600 text-white px-2 py-1 rounded transition text-[10px] font-bold"><i class='bx bx-copy'></i> Copiar</button>`;
            
            if (['html', 'javascript', 'js', 'css'].includes(linguagem)) {
                let ext = linguagem === 'javascript' ? 'js' : linguagem;
                botoes += `<button onclick="window.baixarCodigo('${blockId}', '${ext}')" class="bg-emerald-600 hover:bg-emerald-500 text-white px-2 py-1 rounded ml-2 transition text-[10px] font-bold"><i class='bx bx-download'></i> Baixar</button>`;
            }

            if (linguagem === 'html') {
                botoes += `<button onclick="window.abrirPreview('${blockId}')" class="bg-sky-600 hover:bg-sky-500 text-white px-2 py-1 rounded ml-2 transition text-[10px] font-bold"><i class='bx bx-play'></i> Preview</button>`;
                botoes += `<button onclick="window.publicarNoGitHub(event, '${blockId}', 'html')" class="bg-purple-600 hover:bg-purple-500 text-white px-2 py-1 rounded ml-2 transition text-[10px] font-bold shadow-lg"><i class='bx bxl-github'></i> Publicar no GitHub</button>`;
            }

            return `
            <div class="code-container">
                <div class="code-header">
                    <span class="uppercase font-bold">${linguagem}</span>
                    <div class="flex flex-wrap gap-2 justify-end">${botoes}</div>
                </div>
                <div class="code-content">
                    <code id="${blockId}">${safeCode}</code>
                </div>
            </div>`;
        });
        return textoFormatado.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    }

    // Funções Globais na Window
    window.baixarCodigo = function(blockId, extensao) {
        const codigoRaw = document.getElementById(blockId).innerText;
        const blob = new Blob([codigoRaw], { type: 'text/html;charset=utf-8' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const clienteAtivo = listaDeClientesGlobais.find(c => c.id === idProjetoAberto);
        const nomeSanitizado = clienteAtivo && clienteAtivo.nome ? clienteAtivo.nome.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '') : 'demo';
        a.download = `projeto_${nomeSanitizado}.${extensao}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    };

    window.abrirPreview = function(blockId) {
        const codigoRaw = document.getElementById(blockId).innerText;
        const janelaPreview = window.open("", "_blank");
        janelaPreview.document.write(codigoRaw);
        janelaPreview.document.close();
    };

    window.publicarNoGitHub = async function(event, blockId, extensao) {
        const btn = event.currentTarget;
        const textoOriginal = btn.innerHTML;
        btn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Publicando...";
        btn.disabled = true;

        const token = githubTokenInput ? githubTokenInput.value.trim() : "";
        const repo = githubRepoInput ? githubRepoInput.value.trim() : "";

        if(!token || !repo) {
            alert("Você precisa configurar o Token e o Repositório do GitHub nas Configurações da Nuvem primeiro!");
            btn.innerHTML = textoOriginal;
            btn.disabled = false;
            return;
        }

        const codigoRaw = document.getElementById(blockId).innerText;
        const contentEncoded = btoa(unescape(encodeURIComponent(codigoRaw)));
        
        const clienteAtivo = listaDeClientesGlobais.find(c => c.id === idProjetoAberto);
        const safeName = clienteAtivo && clienteAtivo.nome ? clienteAtivo.nome.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '') : 'demo';
        const shortId = Math.floor(Math.random() * 100); 
        const path = `clientes/projeto_${safeName}_${shortId}.${extensao}`; 
        
        const url = `https://api.github.com/repos/${repo}/contents/${path}`;

        try {
            let sha = null;
            const checkRes = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
            if(checkRes.ok) {
                const checkData = await checkRes.json();
                sha = checkData.sha;
            }

            const bodyParams = {
                message: `Deploy thIAguinho Canvas - Projeto ${safeName}`,
                content: contentEncoded
            };
            if(sha) bodyParams.sha = sha;

            const putRes = await fetch(url, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyParams)
            });

            if(putRes.ok) {
                const username = repo.split('/')[0].toLowerCase(); 
                const repoName = repo.split('/')[1];
                const pageUrl = `https://${username}.github.io/${repoName}/${path}`;
                
                btn.innerHTML = "<i class='bx bx-check'></i> Publicado!";
                btn.classList.replace('bg-purple-600', 'bg-emerald-600');
                
                await set(ref(database, `projetos_capturados/${idProjetoAberto}/linkDemo`), pageUrl);
                
                alert(`Sistema publicado com sucesso!\n\nLink: ${pageUrl}\n\nO link já foi salvo no painel! Feche esta janela e clique no botão verde do WhatsApp, o link vai aparecer lá automaticamente.`);
            } else {
                const err = await putRes.json();
                alert("Erro ao publicar no GitHub: " + err.message);
                btn.innerHTML = textoOriginal;
            }
        } catch(e) {
            alert("Erro de conexão: " + e.message);
            btn.innerHTML = textoOriginal;
        }
        btn.disabled = false;
    };

    // LÓGICA DAS ABAS SUPERIORES
    const tabNovos = document.getElementById('tab-novos');
    const tabConcluidos = document.getElementById('tab-concluidos');
    const tabProcessos = document.getElementById('tab-processos');

    function switchTab(tabName) {
        abaAtiva = tabName;
        // Reseta todos os estilos
        [tabNovos, tabConcluidos, tabProcessos].forEach(t => {
            t.classList.remove('text-white', 'border-b-2', 'border-red-500', 'text-emerald-400', 'border-emerald-500');
            if(t.id === 'tab-processos') t.classList.add('text-emerald-500/70');
            else t.classList.add('text-slate-400');
        });

        if(tabName === 'processos') {
            tabProcessos.classList.remove('text-emerald-500/70');
            tabProcessos.classList.add('text-emerald-400', 'border-b-2', 'border-emerald-500');
            gridLeads.classList.add('oculto');
            viewProcessos.classList.remove('oculto');
        } else {
            const activeEl = tabName === 'novos' ? tabNovos : tabConcluidos;
            activeEl.classList.remove('text-slate-400');
            activeEl.classList.add('text-white', 'border-b-2', 'border-red-500');
            viewProcessos.classList.add('oculto');
            gridLeads.classList.remove('oculto');
            renderizarProjetos();
        }
    }

    if(tabNovos) tabNovos.addEventListener('click', () => switchTab('novos'));
    if(tabConcluidos) tabConcluidos.addEventListener('click', () => switchTab('concluidos'));
    if(tabProcessos) tabProcessos.addEventListener('click', () => switchTab('processos'));

    // LÓGICA DO MÓDULO AIMP (ENGENHARIA DE PROCESSOS)
    const aimpVideoInput = document.getElementById('aimp-video');
    const aimpFileName = document.getElementById('aimp-file-name');
    const aimpContexto = document.getElementById('aimp-contexto');
    const btnGerarPop = document.getElementById('btn-gerar-pop');
    const aimpResultado = document.getElementById('aimp-resultado');

    if(aimpVideoInput) {
        aimpVideoInput.addEventListener('change', (e) => {
            if(e.target.files.length > 0) {
                aimpFileName.textContent = `Anexado: ${e.target.files[0].name}`;
                aimpFileName.classList.replace('text-slate-500', 'text-emerald-400');
            }
        });
    }

    if(btnGerarPop) {
        btnGerarPop.addEventListener('click', async () => {
            const contexto = aimpContexto.value.trim();
            const fileName = aimpVideoInput.files.length > 0 ? aimpVideoInput.files[0].name : null;
            
            if(!contexto && !fileName) {
                alert("Por favor, descreva a rotina ou anexe um arquivo/vídeo para análise.");
                return;
            }

            btnGerarPop.innerHTML = "<i class='bx bx-loader-alt bx-spin text-xl'></i> Aplicando Padrão McDonald's...";
            btnGerarPop.disabled = true;
            aimpResultado.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full text-emerald-500 animate-pulse">
                    <i class='bx bx-layer text-6xl mb-4'></i>
                    <p class="font-bold tracking-wider uppercase text-sm">O Arquiteto está modelando o processo...</p>
                </div>
            `;

            try {
                // Aguarda 2 segundos simulando análise de vídeo pesada para o UX
                if(fileName) await new Promise(r => setTimeout(r, 2000));
                
                const resultadoHTML = await analisarEGerarProcessoAIMP(contexto, fileName);
                
                aimpResultado.innerHTML = `
                    <div class="bg-slate-800 border border-emerald-900/50 rounded-xl p-6 shadow-2xl">
                        <div class="flex justify-between items-center border-b border-slate-700 pb-3 mb-4">
                            <h2 class="text-emerald-400 font-bold text-xl"><i class='bx bx-check-shield'></i> POP Gerado com Sucesso</h2>
                            <button onclick="navigator.clipboard.writeText(document.getElementById('pop-content').innerText); alert('Copiado para a área de transferência!')" class="text-xs bg-slate-700 hover:bg-slate-600 text-white px-3 py-1.5 rounded-lg flex items-center gap-1 transition"><i class='bx bx-copy'></i> Copiar POP</button>
                        </div>
                        <div id="pop-content" class="text-slate-200 leading-relaxed text-sm format-aimp-html">
                            ${resultadoHTML}
                        </div>
                    </div>
                `;
            } catch(e) {
                aimpResultado.innerHTML = `<div class="text-red-500 text-center p-10"><i class='bx bx-error text-4xl mb-2'></i><p>Erro ao gerar processo: ${e.message}</p></div>`;
            }
            
            btnGerarPop.innerHTML = "<i class='bx bx-brain'></i> Analisar e Gerar Padrão Ouro";
            btnGerarPop.disabled = false;
        });
    }

    // SISTEMA DE LOGIN E BANCO DE DADOS
    onAuthStateChanged(auth, (user) => {
        if (user) { usuarioLogado = user; if(erroMsg) erroMsg.classList.add('oculto'); document.getElementById('admin-login')?.classList.add('oculto'); document.getElementById('admin-dashboard')?.classList.remove('oculto'); iniciarLeituraDoBancoDeDados(); } 
        else { usuarioLogado = null; document.getElementById('admin-dashboard')?.classList.add('oculto'); document.getElementById('admin-login')?.classList.remove('oculto'); }
    });

    if(btnLogin) btnLogin.addEventListener('click', () => { btnLogin.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i>"; signInWithEmailAndPassword(auth, emailInput.value, senhaInput.value).catch(() => { erroMsg.classList.remove('oculto'); btnLogin.innerHTML = "Entrar no Painel"; }); });
    if(btnLogout) btnLogout.addEventListener('click', () => signOut(auth).then(() => window.location.reload()));

    if(document.getElementById('btn-save-key')) {
        document.getElementById('btn-save-key').addEventListener('click', () => {
            if (!usuarioLogado) return;
            const btn = document.getElementById('btn-save-key'); btn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i>";
            set(ref(database, 'admin_config/gemini_api_key'), apiKeyInput.value.trim()).then(() => { btn.innerHTML = "Salvo"; setTimeout(() => btn.innerHTML = "Salvar", 2000); });
        });
    }
    
    if(document.getElementById('btn-save-voice')) {
        document.getElementById('btn-save-voice').addEventListener('click', () => {
            if (!usuarioLogado) return;
            const btn = document.getElementById('btn-save-voice'); btn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i>";
if(document.getElementById('btn-save-groq')) {
    document.getElementById('btn-save-groq').addEventListener('click', () => {
        if (!usuarioLogado) return;
        const btn = document.getElementById('btn-save-groq');
        btn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i>";
        set(ref(database, 'admin_config/groq_api_key'), groqKeyInput.value.trim())
            .then(() => {
                btn.innerHTML = "Salvo";
                setTimeout(() => btn.innerHTML = "Salvar", 2000);
            });
    });
}
         
   set(ref(database, 'admin_config/gemini_voice_name'), geminiVoiceInput.value).then(() => { btn.innerHTML = "Salvo"; setTimeout(() => btn.innerHTML = "Salvar Voz", 2000); });
        });
    }

    if(document.getElementById('btn-save-github')) {
        document.getElementById('btn-save-github').addEventListener('click', () => {
            if (!usuarioLogado) return;
            const btn = document.getElementById('btn-save-github'); btn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i>";
            set(ref(database, 'admin_config/github_token'), githubTokenInput.value.trim());
            set(ref(database, 'admin_config/github_repo'), githubRepoInput.value.trim()).then(() => { btn.innerHTML = "Salvo"; setTimeout(() => btn.innerHTML = "Salvar GitHub", 2000); });
        });
    }

    if(document.getElementById('btn-save-prompt')) {
        document.getElementById('btn-save-prompt').addEventListener('click', () => {
            if (!usuarioLogado) return;
            const btn = document.getElementById('btn-save-prompt'); btn.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i>";
            set(ref(database, 'admin_config/prompt_mascote'), document.getElementById('prompt-ia').value)
                .then(() => { atualizarPromptMemoria(document.getElementById('prompt-ia').value); btn.innerHTML = "Atualizado!"; setTimeout(() => btn.innerHTML = "Atualizar Cérebro", 2000); });
        });
    }

    function iniciarLeituraDoBancoDeDados() {
        get(ref(database, 'admin_config/gemini_api_key')).then((s) => { if(s.exists() && apiKeyInput) apiKeyInput.value = s.val(); });
        get(ref(database, 'admin_config/gemini_voice_name')).then((s) => { if(s.exists() && geminiVoiceInput) geminiVoiceInput.value = s.val(); });
        get(ref(database, 'admin_config/github_token')).then((s) => { if(s.exists() && githubTokenInput) githubTokenInput.value = s.val(); });
        get(ref(database, 'admin_config/github_repo')).then((s) => { if(s.exists() && githubRepoInput) githubRepoInput.value = s.val(); });
get(ref(database, 'admin_config/groq_api_key')).then((s) => {
    if (s.exists() && groqKeyInput) groqKeyInput.value = s.val();

        get(ref(database, 'admin_config/prompt_mascote')).then((s) => {
            const caixaTexto = document.getElementById('prompt-ia');
            if (s.exists() && caixaTexto) { caixaTexto.value = s.val(); atualizarPromptMemoria(s.val()); } 
            else if(caixaTexto) { caixaTexto.value = promptPadraoDaAPI; }
        });

        onValue(ref(database, 'projetos_capturados'), (snapshot) => {
            listaDeClientesGlobais = [];
            if (snapshot.exists()) { snapshot.forEach((filho) => { listaDeClientesGlobais.push({ id: filho.key, ...filho.val() }); }); listaDeClientesGlobais.sort((a, b) => new Date(b.data || 0) - new Date(a.data || 0)); }
            if(abaAtiva !== 'processos') renderizarProjetos();
        });
    }

    function renderizarProjetos() {
        if(!gridLeads) return; gridLeads.innerHTML = ''; 
        const projetosFiltrados = listaDeClientesGlobais.filter(c => { const s = c.status || 'novo'; return abaAtiva === 'novos' ? s === 'novo' : s === 'concluido'; });
        if (projetosFiltrados.length === 0) { gridLeads.innerHTML = `<div class="col-span-full text-center py-10 text-slate-500"><i class='bx bx-sleepy text-4xl mb-3'></i><p>Nenhum projeto nesta aba.</p></div>`; return; }

        projetosFiltrados.forEach(cliente => {
            const dataFormatada = cliente.data ? new Date(cliente.data).toLocaleDateString('pt-BR') : 'Sem data';
            let numWpp = cliente.whatsapp ? String(cliente.whatsapp).replace(/\D/g, '') : '';
            if (numWpp.length >= 10 && numWpp.length <= 11) numWpp = '55' + numWpp; 
            
            let textoWpp = `Olá, eu sou o Thiago Ventura Valencio responsável pela Thiaguinho Soluções. Temos aqui um demo com uma proposta para a gente começar a discutir. Acesse o link para testar o sistema: \n\n`;
            if(cliente.linkDemo) {
                textoWpp += cliente.linkDemo; 
            } else {
                textoWpp += "[ O LINK SERÁ GERADO AQUI APÓS VOCÊ PUBLICAR NO PAINEL ]";
            }
            
            const linkWppComTexto = `https://wa.me/${numWpp}?text=${encodeURIComponent(textoWpp)}`;
            
            const card = document.createElement('div');
            card.className = "w-full shrink-0 bg-slate-900 border border-slate-700 rounded-xl p-4 hover:border-sky-500 transition shadow-lg flex flex-col mb-4";
            
            card.innerHTML = `
                <div class="flex justify-between items-center cursor-pointer select-none" onclick="window.toggleCard('${cliente.id}')">
                    <div class="flex-1 overflow-hidden">
                        <h4 class="font-bold text-white text-lg leading-tight truncate">${cliente.nome || "Cliente Indefinido"}</h4>
                        <p class="text-xs text-sky-400 font-semibold uppercase tracking-wider truncate">${cliente.empresa || "Sem Empresa"}</p>
                    </div>
                    <div class="flex items-center gap-3 shrink-0">
                        <span class="text-[10px] text-slate-500 bg-slate-800 px-2 py-1 rounded hidden md:block">${dataFormatada}</span>
                        <i id="icon-${cliente.id}" class='bx bx-chevron-down text-2xl text-slate-400 transition-transform duration-300'></i>
                    </div>
                </div>
                <div id="body-${cliente.id}" class="hidden mt-4 pt-4 border-t border-slate-700">
                    <p class="text-sm text-slate-300 mb-4 italic">"${cliente.dores || "Não informou dores específicas."}"</p>
                    <div class="flex flex-wrap gap-2">
                        <button onclick="window.abrirModalProjeto('${cliente.id}')" class="flex-1 bg-sky-900/40 hover:bg-sky-600 text-white text-sm font-semibold py-2 px-3 rounded-lg transition border border-sky-800 flex items-center justify-center gap-2">
                            <i class='bx bx-terminal'></i> Abrir Fábrica
                        </button>
                        <a href="${linkWppComTexto}" target="_blank" class="w-10 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center justify-center shrink-0" title="Chamar no WhatsApp"><i class='bx bxl-whatsapp text-lg'></i></a>
                        ${abaAtiva === 'novos' ? `<button onclick="window.alterarStatus('${cliente.id}', 'concluido')" class="w-10 bg-emerald-900/50 hover:bg-emerald-600 text-emerald-400 hover:text-white rounded-lg flex items-center justify-center transition border border-emerald-800 shrink-0"><i class='bx bx-check-double text-lg'></i></button>` : `<button onclick="window.alterarStatus('${cliente.id}', 'novo')" class="w-10 bg-orange-900/50 hover:bg-orange-600 text-orange-400 hover:text-white rounded-lg flex items-center justify-center transition border border-orange-800 shrink-0"><i class='bx bx-undo text-lg'></i></button>`}
                        <button onclick="window.excluirProjeto('${cliente.id}')" class="w-10 bg-slate-800 hover:bg-red-700 text-slate-400 hover:text-white rounded-lg flex items-center justify-center transition shrink-0"><i class='bx bx-trash text-lg'></i></button>
                    </div>
                </div>
            `;
            gridLeads.appendChild(card);
        });
    }

    window.toggleCard = function(id) { const b = document.getElementById(`body-${id}`); const i = document.getElementById(`icon-${id}`); if(b && i) { b.classList.toggle('hidden'); i.style.transform = b.classList.contains('hidden') ? 'rotate(0deg)' : 'rotate(180deg)'; } };
    window.alterarStatus = function(id, novoStatus) { set(ref(database, `projetos_capturados/${id}/status`), novoStatus); };
    window.excluirProjeto = function(id) { if (confirm("Deseja excluir definitivamente este projeto?")) set(ref(database, `projetos_capturados/${id}`), null); };

    window.abrirModalProjeto = function(id) {
        try {
            const c = listaDeClientesGlobais.find(item => item.id === id);
            if(!c) return;

            idProjetoAberto = c.id;
            let chatSalvo = c.devChat || [];
            if (typeof chatSalvo === 'string') historicoDevAtual = [{role: 'model', text: chatSalvo}];
            else if (!Array.isArray(chatSalvo) && typeof chatSalvo === 'object') historicoDevAtual = Object.values(chatSalvo);
            else historicoDevAtual = chatSalvo;
            
            bufferArquivosAnexados = ""; 

            if(document.getElementById('modal-nome')) document.getElementById('modal-nome').innerText = c.nome || "Cliente";
            if(document.getElementById('modal-empresa')) document.getElementById('modal-empresa').innerText = c.empresa || "Empresa";
            if(document.getElementById('modal-dores')) document.getElementById('modal-dores').innerText = c.dores || "Sem dor detalhada.";
            contextoProjetoAtual = `Cliente: ${c.nome}. Empresa: ${c.empresa}. Dor: ${c.dores}.`;
            
            const chatDisplay = document.getElementById('dev-chat-display');
            if(chatDisplay) {
                chatDisplay.innerHTML = `<div class="msg-dev ai">Olá, Thiago! O sistema que eu gerar agora vai processar a <b>Voz Neural do Gemini</b> automaticamente direto no código do cliente. Clica no botão Roxo para publicar!</div>`;

                if(Array.isArray(historicoDevAtual)) {
                    historicoDevAtual.forEach(msg => {
                        if(!msg || !msg.text) return;
                        const textoSeguro = String(msg.text);
                        const div = document.createElement('div');
                        div.className = `msg-dev ${msg.role === 'user' ? 'admin' : 'ai shadow-lg'}`;
                        div.innerHTML = msg.role === 'user' ? textoSeguro.replace(/\n/g, '<br>') : formatarCodigoIA(textoSeguro);
                        chatDisplay.appendChild(div);
                    });
                }
                chatDisplay.scrollTop = chatDisplay.scrollHeight;
            }
            
            if(unsubFeedbacks) unsubFeedbacks(); 
            const feedbacksRef = ref(database, `projetos_capturados/${idProjetoAberto}/feedbacks`);
            unsubFeedbacks = onValue(feedbacksRef, (snap) => {
                const boxFeedbacks = document.getElementById('modal-feedbacks');
                if(!boxFeedbacks) return;
                
                boxFeedbacks.innerHTML = '';
                if(!snap.exists()) {
                    boxFeedbacks.innerHTML = '<span class="text-xs text-slate-500 italic">O cliente ainda não enviou mensagens do demo.</span>';
                    return;
                }
                
                snap.forEach(child => {
                    const msg = child.val();
                    const dataFormatada = new Date(msg.data).toLocaleString('pt-BR');
                    boxFeedbacks.innerHTML += `
                        <div class="bg-slate-800 p-2 rounded text-xs text-slate-200 border border-slate-600 shadow-sm">
                            <strong class="text-emerald-400">Cliente diz:</strong> ${escapeHtml(msg.texto)} 
                            <br><span class="text-[9px] text-slate-500">${dataFormatada}</span>
                        </div>`;
                });
                boxFeedbacks.scrollTop = boxFeedbacks.scrollHeight;
            });
            
            const modalDOM = document.getElementById('modal-projeto');
            if(modalDOM) modalDOM.classList.remove('oculto');
            
        } catch (erro) { console.error("Falha ao abrir a Fábrica: ", erro); }
    };

    if(document.getElementById('btn-fechar-modal')) {
        document.getElementById('btn-fechar-modal').addEventListener('click', () => {
            const m = document.getElementById('modal-projeto');
            if(m) m.classList.add('oculto');
            if(unsubFeedbacks) { unsubFeedbacks(); unsubFeedbacks = null; } 
        });
    }

    const devInput = document.getElementById('dev-input');
    const btnDevSend = document.getElementById('btn-dev-send');
    const devFile = document.getElementById('dev-file');
    const chatDisplay = document.getElementById('dev-chat-display');

    if(devFile) {
        devFile.addEventListener('change', async (e) => {
            const files = e.target.files;
            if(files.length === 0) return;
            for(let file of files) {
                try {
                    const text = await file.text();
                    bufferArquivosAnexados += `\n\n--- INÍCIO DO ARQUIVO: ${file.name} ---\n${text}\n--- FIM DO ARQUIVO ---\n`;
                    const divAdmin = document.createElement('div');
                    divAdmin.className = "msg-dev admin bg-slate-700 text-slate-200 text-xs italic";
                    divAdmin.innerHTML = `<i class='bx bx-file'></i> Arquivo anexado: <b>${file.name}</b>`;
                    if(chatDisplay) { chatDisplay.appendChild(divAdmin); chatDisplay.scrollTop = chatDisplay.scrollHeight; }
                } catch(err) { console.error(err); }
            }
            devFile.value = ''; 
        });
    }

    async function enviarMsgDev() {
        let msg = devInput ? devInput.value.trim() : "";
        if(!msg && !bufferArquivosAnexados) return; 

        if(devInput) devInput.value = '';
        if(devInput) devInput.disabled = true;
        if(btnDevSend) btnDevSend.innerHTML = "<i class='bx bx-loader-alt bx-spin text-xl'></i>";

        if(msg && chatDisplay) {
            const divAdmin = document.createElement('div');
            divAdmin.className = "msg-dev admin";
            divAdmin.innerText = msg;
            chatDisplay.appendChild(divAdmin);
        }

        const msgFinalParaIA = msg + "\n" + bufferArquivosAnexados;
        bufferArquivosAnexados = ""; 
        if(chatDisplay) chatDisplay.scrollTop = chatDisplay.scrollHeight;

        const respostaDaIA = await conversarComDesenvolvedorIA(msgFinalParaIA, contextoProjetoAtual, historicoDevAtual, idProjetoAberto);

        if(chatDisplay) {
            const divAI = document.createElement('div');
            divAI.className = "msg-dev ai shadow-lg w-full overflow-hidden";
            divAI.innerHTML = formatarCodigoIA(respostaDaIA);
            chatDisplay.appendChild(divAI);
            chatDisplay.scrollTop = chatDisplay.scrollHeight;
        }

        historicoDevAtual.push({ role: 'user', text: msg ? msg : "Envio de arquivos base." });
        historicoDevAtual.push({ role: 'model', text: respostaDaIA });
        set(ref(database, `projetos_capturados/${idProjetoAberto}/devChat`), historicoDevAtual);

        if(devInput) devInput.disabled = false;
        if(devInput) devInput.focus();
        if(btnDevSend) btnDevSend.innerHTML = "<i class='bx bx-send text-xl'></i>";
    }

    if(btnDevSend) btnDevSend.addEventListener('click', enviarMsgDev);
    if(devInput) devInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') enviarMsgDev(); });
});
