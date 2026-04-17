// NOME DO ARQUIVO: gemini-api.js
// LOCALIZAÇÃO: Dentro da pasta 'js'

import { database, ref, push, set, get } from './firebase-config.js';

let chatHistoryCliente  = [];
let chaveApiArmazenada  = null;
let chaveGroqArmazenada = null;
let leadJaCapturado     = false;
let _geminiLocked       = false;

// =========================================================================
// CÉREBRO 1: FUNIL DUAL — EMPRESA + VIDA PESSOAL
// =========================================================================
export let systemPrompt = `Você é o Consultor Sênior e Arquiteto de Software da 'thIAguinho Soluções'.
Você atende TANTO empresas QUANTO pessoas físicas com projetos digitais pessoais.

PROJETOS PESSOAIS QUE VOCÊ DESENVOLVE:
- Planilhas inteligentes de controle financeiro, gastos e investimentos
- Checklists e organizadores de rotina diária ou semanal
- Apps simples de metas e hábitos
- Dashboards de saúde, treino e dieta
- Planejadores de viagens, eventos e projetos pessoais
- Qualquer ferramenta digital de organização pessoal

REGRA DOS BOTÕES: Finalize TODAS as mensagens com [OPCOES: Opção 1 | Opção 2]. NUNCA use "A" ou "B".

PASSO 1 - NOME (SEMPRE primeiro):
Cumprimente brevemente e pergunte o nome.
[OPCOES: Pode me chamar de... | Prefiro não informar]
Use o nome em TODAS as mensagens seguintes.

PASSO 2 - DIREÇÃO:
[OPCOES: Para minha Empresa | Para minha Vida Pessoal]
- Se Vida Pessoal: Pergunte qual aspecto da rotina ele quer organizar. (Ex: Finanças, Produtividade, Saúde).
- Se Empresa: Pergunte o segmento da empresa.

PASSO 3 - A DOR:
Investigue qual o maior desafio ou problema que ele quer resolver com essa ferramenta/sistema.

PASSO 4 - TELEFONE (APENAS DEPOIS DE ENTENDER A DOR):
Peça o WhatsApp para enviar o link do sistema quando ficar pronto.
[OPCOES: Meu WhatsApp é... | Agora não]

PASSO 5 - ENCERRAMENTO E CAPTURA:
Confirme que a 'Fábrica' (seu cérebro de desenvolvedor) começará a gerar o sistema imediatamente.
GERE UM RESUMO EXATO NO FINAL NESTE FORMATO (ESCONDIDO DO USUÁRIO):
[JSON_CAPTURA]
{ "nome": "Nome Capturado", "empresa": "Nome da Empresa ou 'Projeto Pessoal'", "dores": "Resumo da dor", "whatsapp": "Numero capturado ou Vazio" }
[/JSON_CAPTURA]`;

export function atualizarPromptMemoria(novoPrompt) {
    if(novoPrompt && novoPrompt.trim().length > 10) {
        systemPrompt = novoPrompt;
    }
}

function extractJSONCaptura(texto) {
    const match = texto.match(/\[JSON_CAPTURA\]([\s\S]*?)\[\/JSON_CAPTURA\]/);
    if (match) {
        try {
            return JSON.parse(match[1]);
        } catch (e) {
            console.error("[JARVIS] Falha ao extrair JSON do Lead:", e);
            return null;
        }
    }
    return null;
}

export function adicionarAoHistorico(role, text) {
    chatHistoryCliente.push({ role, parts: [{ text }] });
}

// =========================================================================
// CAMADA BASE DE REDE
// =========================================================================
async function sendMessageToGemini(history, text, apiKey) {
    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const safeHistory = history.map(item => ({
        role: item.role === 'user' ? 'user' : 'model',
        parts: Array.isArray(item.parts) ? item.parts : [{text: String(item.text||"")}]
    }));

    const contents = [...safeHistory, { role: 'user', parts: [{ text }] }];

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`[JARVIS][Gemini] Tentativa ${attempt} — ${model}:generateContent`);
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: contents,
                    systemInstruction: { parts: [{ text: systemPrompt }] }
                })
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(`${response.status}: ${errData.error?.message || 'Erro desconhecido'}`);
            }

            const data = await response.json();
            return data.candidates[0].content.parts[0].text;
            
        } catch (error) {
            console.warn(`[JARVIS][Gemini] Falha tentativa ${attempt}: ${error.message}`);
            if (attempt === 3) throw error;
            await new Promise(r => setTimeout(r, 1500 * attempt));
        }
    }
}

async function callGroqAPI(prompt, sys, apiKey, model = "llama-3.3-70b-versatile") {
    const url = "https://api.groq.com/openai/v1/chat/completions";
    
    console.log(`[JARVIS][Groq] Chamando ${model}...`);
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: sys },
                { role: "user", content: prompt }
            ],
            temperature: 0.5,
            max_tokens: 6000
        })
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error?.message || "Erro Groq API");
    }

    const data = await response.json();
    console.log(`[JARVIS][Groq] ${model} OK (${data.choices[0].message.content.length} chars).`);
    return data.choices[0].message.content;
}

// -------------------------------------------------------------------------
// NOVA FUNÇÃO: FORÇAR GERADOR DE CÓDIGO HTML/JS PELA GROQ
// -------------------------------------------------------------------------
async function callGroqHTMLGenerator(prompt, sys, apiKey) {
    const model = "llama-3.3-70b-versatile";
    console.log(`[JARVIS][Groq] Gerando CÓDIGO FINAL via ${model}...`);
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: sys },
                { role: "user", content: prompt }
            ],
            temperature: 0.2, // Mais baixo para focar em código exato
            max_tokens: 7500
        })
    });

    if (!response.ok) {
         const err = await response.json();
         throw new Error(err.error?.message || "Erro Groq API no CÓDIGO");
    }
    const data = await response.json();
    console.log(`[JARVIS][Groq] Geração de Código Concluída.`);
    return data.choices[0].message.content;
}


async function callGeminiText(prompt, sys, apiKey) {
    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            console.log(`[JARVIS][Gemini] Tentativa ${attempt} — ${model}:generateContent`);
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    systemInstruction: { parts: [{ text: sys }] }
                })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(`${response.status}: ${errData.error?.message || 'Erro desconhecido'}`);
            }
            const data = await response.json();
            return data.candidates[0].content.parts[0].text;
        } catch (error) {
            console.warn(`[JARVIS][Gemini] Falha tentativa ${attempt}: ${error.message}`);
            if (attempt === 2) throw error;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// =========================================================================
// MOTOR PRINCIPAL - CHAT DO CLIENTE (Mascote / AR)
// =========================================================================
export async function askGemini(text) {
    if (_geminiLocked) return "Aguarde, estou processando sua última resposta...";
    _geminiLocked = true;

    try {
        if (!chaveApiArmazenada) {
            const snap = await get(ref(database, 'admin_config/gemini_api_key'));
            if(snap.exists()) chaveApiArmazenada = snap.val();
            else throw new Error("API Key do Gemini não configurada pelo Admin.");
        }

        const resposta = await sendMessageToGemini(chatHistoryCliente, text, chaveApiArmazenada);
        adicionarAoHistorico('user', text);
        
        let textoLimpo = resposta;
        const dadosCaptura = extractJSONCaptura(resposta);
        
        if (dadosCaptura) {
            textoLimpo = resposta.replace(/\\[JSON_CAPTURA\\][\\s\\S]*?\\[\\/JSON_CAPTURA\\]/, "").trim();
            if(!leadJaCapturado) {
                try {
                    const novoLeadRef = push(ref(database, 'projetos_capturados'));
                    await set(novoLeadRef, {
                        ...dadosCaptura,
                        data: new Date().toISOString(),
                        status: 'novo',
                        origem: 'AR_Assistant',
                        devChat: []
                    });
                    leadJaCapturado = true;
                    console.log("[JARVIS] Lead salvo com sucesso no Banco de Dados!");
                } catch(e) {
                    console.error("[JARVIS] Falha ao salvar lead:", e);
                }
            }
        }
        
        adicionarAoHistorico('model', textoLimpo);
        return textoLimpo;
        
    } catch (error) {
        console.error("Erro na API Gemini:", error);
        return "A API do cérebro está indisponível no momento. Pode tentar novamente?";
    } finally {
        _geminiLocked = false;
    }
}

// =========================================================================
// CÉREBRO 2: DEV CHAT DO ADMIN (Agora otimizado para Groq/Fallback)
// =========================================================================
export async function conversarComDesenvolvedorIA(mensagemUsuario, contextoCliente, historicoDev, idProjeto = null) {
    try {
        if (!chaveApiArmazenada) {
            const snap = await get(ref(database, 'admin_config/gemini_api_key'));
            if (snap.exists()) chaveApiArmazenada = snap.val();
        }
        if (!chaveGroqArmazenada) {
            const snapGroq = await get(ref(database, 'admin_config/groq_api_key'));
            if(snapGroq.exists()) chaveGroqArmazenada = snapGroq.val();
        }

        let voiceName = "pt-BR-Standard-B"; 
        const snapVoice = await get(ref(database, 'admin_config/gemini_voice_name'));
        if(snapVoice.exists() && snapVoice.val().trim() !== "") {
            voiceName = snapVoice.val().trim();
        }

        const devSystemPrompt = `Você é o ARQUITETO DE CÓDIGO DA THIAGUINHO SOLUÇÕES.
Sua missão final é SEMPRE retornar código HTML único e completo (HTML+CSS Tailwind+JS) ou apenas JS, dependendo do pedido.

Contexto do Cliente Atual:
${contextoCliente}

REGRAS OBRIGATÓRIAS DE SISTEMA (SE GERAR HTML):
1. Use Tailwind via CDN (<script src="https://cdn.tailwindcss.com"></script>).
2. TEMA OBRIGATÓRIO: Dark mode (bg-slate-900 text-white), com acentos em Emerald (emerald-500) e Sky (sky-500).
3. Use a fonte 'Montserrat' do Google Fonts.
4. Inclua ícones do Boxicons (<link href="https://cdn.jsdelivr.net/npm/boxicons@2.1.4/css/boxicons.min.css" rel="stylesheet">).
5. O sistema deve ser LINDO, MODERNO e PARECER CARO. Use shadows, bordas sutis (border-slate-700), cantos arredondados (rounded-xl) e glassmorphism (bg-slate-800/80 backdrop-blur).

REGRA DE ÁUDIO NEURAL PARA O CLIENTE:
Para qualquer botão ou ação importante que o cliente clicar no sistema que você gerar, inclua uma resposta em áudio Neural do Google TTS com sotaque natural.
VOCÊ DEVE INCLUIR ESTA FUNÇÃO JS GLOBAL NO SEU CÓDIGO HTML:
\`\`\`javascript
window.tocarAudioNeural = function(texto) {
    const url = 'https://texttospeech.googleapis.com/v1/text:synthesize?key=${chaveApiArmazenada}';
    fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            input: { text: texto },
            voice: { languageCode: 'pt-BR', name: '${voiceName}' },
            audioConfig: { audioEncoding: 'MP3', pitch: 0, speakingRate: 1.05 }
        })
    })
    .then(r => r.json())
    .then(data => {
        if(data.audioContent) {
            const audio = new Audio("data:audio/mp3;base64," + data.audioContent);
            audio.play().catch(e => console.log('Erro de autoplay:', e));
        }
    })
    .catch(console.error);
};
\`\`\`
Exemplo de uso no HTML: <button onclick="window.tocarAudioNeural('Seu pedido foi adicionado ao carrinho com sucesso.')">Adicionar</button>`;

        const temGroq = !!chaveGroqArmazenada;
        
        console.log(`[JARVIS][Rodizio-Dev] Pipeline iniciado. Groq disponivel: ${temGroq}`);

        if (temGroq) {
            // ==========================================
            // MODO TURBO (100% GROQ - LLAMA 3)
            // Ignorando Gemini para evitar erro 503
            // ==========================================
            
            // Passo 1: Análise
            console.log(`[JARVIS][Rodizio-Dev] Agente 1 (Groq) — Analista Técnico...`);
            const p1 = `Analise este pedido e defina a arquitetura de variáveis e funções JS necessárias.\nPedido: ${mensagemUsuario}`;
            const sys1 = `Você é o Arquiteto Analista. Seja curto e direto. Crie a lista de funções e variáveis necessárias baseada no pedido.`;
            const r1 = await callGroqAPI(p1, sys1, chaveGroqArmazenada);

            // Passo 2: Layout
            console.log(`[JARVIS][Rodizio-Dev] Agente 2 (Groq) — Arquiteto Layout...`);
            const p2 = `Com base nesta análise: ${r1}\nCrie o rascunho de estrutura HTML (Wireframe escrito, sem código) para o layout de Tailwind escuro. O que vai em cada DIV?`;
            const sys2 = `Você é UX Designer sênior. Responda apenas com a estrutura da tela em tópicos rápidos.`;
            const r2 = await callGroqAPI(p2, sys2, chaveGroqArmazenada);

            // Passo 3: GERAÇÃO FINAL DO CÓDIGO (100% Groq)
            console.log(`[JARVIS][Rodizio-Dev] Agente 3 (Groq) — Gerador de Código...`);
            const pFinal = `Você possui:
1. Funções/Lógica: ${r1}
2. Estrutura UX: ${r2}
3. Pedido Original: ${mensagemUsuario}
4. Chat Anterior (Contexto): ${JSON.stringify(historicoDev.slice(-3))}

GERE O CÓDIGO HTML COMPLETO AGORA, JUNTANDO TUDO NUM ÚNICO ARQUIVO.
Lembre-se da regra da função 'window.tocarAudioNeural' exigida no seu System Prompt e aplique-a nos botões de interação.
Use a tag \`\`\`html no início e \`\`\` no fim da resposta. NÃO DIGA MAIS NADA ALÉM DO CÓDIGO.`;

            // Usamos a função focada em Código
            const respostaFinalCode = await callGroqHTMLGenerator(pFinal, devSystemPrompt, chaveGroqArmazenada);
            
            const headerLog = `<div class="bg-slate-800 border border-slate-600 rounded p-2 mb-2 text-[10px] text-slate-400 italic">
<i class='bx bx-check-shield text-emerald-400'></i> Pipeline Concluído 100% via Groq LLaMA-3 (Prevenção Erro 503 Gemini).</div>`;
            return headerLog + respostaFinalCode;

        } else {
            // ==========================================
            // MODO PADRÃO (Apenas Gemini - Pode dar 503)
            // ==========================================
            console.log(`[JARVIS][Rodizio-Dev] Modo Single-Agent Gemini. Requerendo paciência do Servidor...`);
            
            const pFinal = `Pedido Atual do Cliente: ${mensagemUsuario}\n\nVocê tem as rédeas completas.
Analise a dor, projete o UX de alto nível e construa o arquivo HTML final completo.\n
Gere apenas o código no bloco \`\`\`html \`\`\`. Não dê explicações gigantes.`;
            
            const resposta = await sendMessageToGemini(historicoDev, pFinal, chaveApiArmazenada);
            
            const headerLog = `<div class="bg-slate-800 border border-slate-600 rounded p-2 mb-2 text-[10px] text-slate-400 italic">
<i class='bx bx-error text-yellow-500'></i> Chave do Groq Ausente. Rodando apenas com Gemini (Sujeito a lentidão do Servidor Google).</div>`;
            return headerLog + resposta;
        }

    } catch (error) {
        console.error("[JARVIS][Dev] Erro pipeline:", error);
        return `**Erro Sistêmico na Fábrica:** Ocorreu uma instabilidade na comunicação com o motor (Possível servidor ocupado). \n\nLog: *${error.message}*\n\nSugestão: Tente pedir para gerar apenas uma parte do código, ou verifique sua conexão.`;
    }
}

// =========================================================================
// AIMP: ENGENHARIA DE PROCESSOS (Corrigido para Groq Llama 3)
// =========================================================================
export async function analisarEGerarProcessoAIMP(contextoUsuario, nomeArquivoAnexo) {
    if (!chaveApiArmazenada) {
        const snap = await get(ref(database, 'admin_config/gemini_api_key'));
        if (snap.exists()) chaveApiArmazenada = snap.val();
    }
    if (!chaveGroqArmazenada) {
        const snapGroq = await get(ref(database, 'admin_config/groq_api_key'));
        if(snapGroq.exists()) chaveGroqArmazenada = snapGroq.val();
    }

    const temGroq = !!chaveGroqArmazenada;
    console.log(`[JARVIS][AIMP] Pipeline iniciado. Groq: ${temGroq}`);

    let diagnostico = "";
    let popCompleto = "";
    let metricas = "";

    try {
        if(temGroq) {
            // AGENTE 1
            console.log(`[JARVIS][AIMP] Agente 1 — Diagnóstico...`);
            const p1 = `Contexto do Cliente: ${contextoUsuario} \nArquivo Analisado: ${nomeArquivoAnexo || 'Nenhum'}\nQuais são os gargalos e riscos dessa operação?`;
            diagnostico = await callGroqAPI(p1, "Você é Engenheiro de Processos Sênior.", chaveGroqArmazenada, "llama-3.3-70b-versatile");
            console.log(`[JARVIS][AIMP] Agente 1 OK.`);

            // AGENTE 2
            console.log(`[JARVIS][AIMP] Agente 2 — POP...`);
            const p2 = `Com base nisso: ${diagnostico}\nCrie o POP (Procedimento Operacional Padrão) em formato de Checklist prático.`;
            popCompleto = await callGroqAPI(p2, "Você é Especialista em Qualidade McDonald's. Regras blindadas a erros.", chaveGroqArmazenada, "llama-3.3-70b-versatile");
            console.log(`[JARVIS][AIMP] Agente 2 OK.`);

            // AGENTE 3 (CORRIGIDO: Era 8b-8192, agora é llama-3.1-8b-instant)
            console.log(`[JARVIS][AIMP] Agente 3 — Métricas e Auditorias...`);
            const p3 = `Com base no POP: ${popCompleto}\nQuais são os 3 KPIs (Métricas) para medir se o funcionário está fazendo certo? Como auditar?`;
            try {
                metricas = await callGroqAPI(p3, "Você é Auditor de Qualidade.", chaveGroqArmazenada, "llama-3.1-8b-instant");
                console.log(`[JARVIS][AIMP] Agente 3 OK.`);
            } catch(e) {
                console.warn(`[JARVIS][AIMP] Agente 3 falhou, ignorando métricas:`, e.message);
                metricas = "Métricas não puderam ser geradas.";
            }

        } else {
            console.log(`[JARVIS][AIMP] Rodando modo single-agent Gemini...`);
            const pUnico = `Analise: ${contextoUsuario}\nArquivo: ${nomeArquivoAnexo||'Nenhum'}\nGere 1) Diagnóstico, 2) POP em Checklist e 3) KPIs de Auditoria.`;
            popCompleto = await callGeminiText(pUnico, "Você é Engenheiro de Processos. Gere texto claro e estruturado.", chaveApiArmazenada);
        }

        // AGENTE 4 - RENDERIZADOR (Continua com Gemini, pois é leve)
        console.log(`[JARVIS][AIMP] Agente 4 — Formatador HTML...`);
        const promptHtml = `Formate o texto abaixo em blocos HTML puros usando as classes Tailwind que enviei nas instruções. Não crie \`<html>\` ou \`<body>\`, apenas as DIVs internas que vão compor a tela.

Use APENAS este design system Tailwind:
Para títulos principais de seções: 
<div class="relative pl-4 mb-6">
  <div class="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500 rounded-full"></div>
  <h1 class="text-xl font-extrabold text-white tracking-wide uppercase">[TITULO AQUI]</h1>
</div>

Para parágrafos normais e diagnósticos: 
<div class="bg-slate-800/50 border border-slate-700 rounded-xl p-5 mb-4 text-slate-300 text-sm leading-relaxed">[texto]</div>

Para alertas, avisos críticos ou riscos:
<div class="bg-red-900/20 border border-red-800 rounded-xl p-4 mb-4 flex items-start gap-3">
  <i class='bx bx-error-circle text-red-500 text-xl shrink-0 mt-0.5'></i>
  <p class="text-red-200 text-sm">[aviso aqui]</p>
</div>

Para checklists de tarefas e POPs (MUITO IMPORTANTE FORMATAR ASSIM):
<div class="space-y-2 mb-6">
  <label class="flex items-center gap-3 p-3 bg-slate-800/80 border border-slate-700 hover:border-emerald-500/50 rounded-lg cursor-pointer transition">
    <input type="checkbox" class="w-5 h-5 rounded border-slate-600 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-900 bg-slate-900">
    <span class="text-slate-200 text-sm font-medium">[PASSO DO CHECKLIST AQUI]</span>
  </label>
</div>

Para Indicadores (KPIs) e Métricas (Crie "Cards" para eles):
<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
  <div class="bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700 rounded-xl p-4">
    <div class="text-sky-400 text-xs font-bold uppercase tracking-wider mb-1">[NOME DO KPI]</div>
    <div class="text-white text-lg font-semibold">[VALOR/META DO KPI]</div>
    <div class="text-slate-400 text-xs mt-2">[Como auditar / explicação]</div>
  </div>
</div>

CONTEÚDO PARA FORMATAR:
--- DIAGNÓSTICO E RISCOS ---
${diagnostico}

--- PROCEDIMENTO (POP) ---
${popCompleto}

--- KPIs / MÉTRICAS ---
${metricas}
`;

        let htmlFinal = await callGeminiText(promptHtml, "Você formata textos puramente em HTML Tailwind seguindo o design system fornecido. Não adicione markdown.", chaveApiArmazenada);
        htmlFinal = htmlFinal.replace(/```html/g, '').replace(/```/g, '').trim();

        const label = temGroq ? 'Groq LLaMA-3 (Fast)' : 'Gemini 2.5';
        const headerRodizio = `<div class="flex items-center gap-2 text-[10px] text-slate-500 mb-6 pb-2 border-b border-slate-800 uppercase tracking-widest font-bold"><i class='bx bx-bot'></i> Engine Padrão McDonald's via ${label}</div>`;

        return headerRodizio + htmlFinal;

    } catch (e) {
        console.error(`[JARVIS][AIMP] Erro:`, e.message);
        throw new Error(`O Cérebro Engenheiro falhou ou sobrecarregou. Detalhe: ${e.message}`);
    }
}
