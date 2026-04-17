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
// CAMADA BASE DE REDE (GROQ E GEMINI)
// =========================================================================

// Usando o Gemini 1.5 Flash (mais estável para contas gratuitas e limite maior)
async function sendMessageToGemini(history, text, apiKey) {
    const model = 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const safeHistory = history.map(item => ({
        role: item.role === 'user' ? 'user' : 'model',
        parts: Array.isArray(item.parts) ? item.parts : [{text: String(item.text||"")}]
    }));

    const contents = [...safeHistory, { role: 'user', parts: [{ text }] }];

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`[JARVIS][Gemini] Tentativa ${attempt} — ${model}`);
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

async function callGroqAPI(prompt, sys, apiKey, model = "llama-3.3-70b-versatile", tokens = 2000) {
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
            max_tokens: tokens // Limitado para não estourar a cota gratuita
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
// CÉREBRO 2: DEV CHAT DO ADMIN (ARQUITETURA HÍBRIDA)
// Carga pesada (HTML) fica com Gemini 1.5, Planejamento (Rápido) com Groq.
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

REGRAS OBRIGATÓRIAS DE SISTEMA:
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
Exemplo de uso no HTML: <button onclick="window.tocarAudioNeural('Sua ação foi concluída.')">Ação</button>`;

        const temGroq = !!chaveGroqArmazenada;
        
        console.log(`[JARVIS][Rodizio-Dev] Pipeline iniciado. Groq disponível: ${temGroq}`);

        if (temGroq) {
            // MODO HÍBRIDO (Bypass Limits):
            // Groq Planeja (Rápido e Leve) -> Gemini Executa (Longo e Pesado)
            
            // Passo 1: Análise (GROQ)
            console.log(`[JARVIS][Rodizio-Dev] Agente 1 (Groq) — Analista Técnico...`);
            const p1 = `Analise este pedido e defina a arquitetura de variáveis e funções JS necessárias.\nPedido: ${mensagemUsuario}`;
            const sys1 = `Você é o Arquiteto Analista. Seja curto e direto. Crie a lista de funções e variáveis necessárias baseada no pedido.`;
            const r1 = await callGroqAPI(p1, sys1, chaveGroqArmazenada, "llama-3.3-70b-versatile", 800); // Token baixo para economizar

            // Passo 2: Layout (GROQ)
            console.log(`[JARVIS][Rodizio-Dev] Agente 2 (Groq) — Arquiteto Layout...`);
            const p2 = `Com base nesta análise: ${r1}\nCrie o rascunho de estrutura HTML (Wireframe escrito, sem código) para o layout de Tailwind escuro. O que vai em cada DIV?`;
            const sys2 = `Você é UX Designer sênior. Responda apenas com a estrutura da tela em tópicos rápidos.`;
            const r2 = await callGroqAPI(p2, sys2, chaveGroqArmazenada, "llama-3.3-70b-versatile", 800); // Token baixo

            // Passo 3: GERAÇÃO FINAL DO CÓDIGO (GEMINI 1.5 FLASH)
            // O Gemini aguenta milhões de tokens, então passamos o trabalho pesado para ele.
            console.log(`[JARVIS][Rodizio-Dev] Agente 3 (Gemini 1.5) — Gerador de Código...`);
            const pFinal = `Você possui:
1. Funções/Lógica (criadas pelo Arquiteto): ${r1}
2. Estrutura UX (criada pelo Designer): ${r2}
3. Pedido Original: ${mensagemUsuario}
4. Chat Anterior (Contexto): ${JSON.stringify(historicoDev.slice(-2))}

GERE O CÓDIGO HTML COMPLETO AGORA, JUNTANDO TUDO NUM ÚNICO ARQUIVO.
Lembre-se da regra da função 'window.tocarAudioNeural' exigida nas suas instruções de sistema. Use a tag \`\`\`html no início e \`\`\` no fim da resposta. Não dê explicações.`;

            // Chamada para o Gemini 1.5 Flash
            const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${chaveApiArmazenada}`;
            const respGemini = await fetch(urlGemini, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: pFinal }] }],
                    systemInstruction: { parts: [{ text: devSystemPrompt }] }
                })
            });
            
            if(!respGemini.ok) throw new Error("Falha ao gerar o código no Agente 3 (Gemini).");
            const dataGemini = await respGemini.json();
            const respostaFinalCode = dataGemini.candidates[0].content.parts[0].text;
            
            const headerLog = `<div class="bg-slate-800 border border-slate-600 rounded p-2 mb-2 text-[10px] text-slate-400 italic">
<i class='bx bx-check-shield text-emerald-400'></i> Pipeline Híbrido Concluído: Groq LLaMA-3 (Planejamento) + Gemini 1.5 Flash (Código).</div>`;
            return headerLog + respostaFinalCode;

        } else {
            // MODO SINGLE (Só Gemini 1.5)
            console.log(`[JARVIS][Rodizio-Dev] Modo Single-Agent Gemini 1.5 Flash...`);
            const pFinal = `Pedido Atual: ${mensagemUsuario}\nAnalise a dor, projete o UX e construa o arquivo HTML final completo.\nGere apenas o código no bloco \`\`\`html \`\`\`.`;
            
            const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${chaveApiArmazenada}`;
            const respGemini = await fetch(urlGemini, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: pFinal }] }],
                    systemInstruction: { parts: [{ text: devSystemPrompt }] }
                })
            });
            const dataGemini = await respGemini.json();
            const resposta = dataGemini.candidates[0].content.parts[0].text;
            
            const headerLog = `<div class="bg-slate-800 border border-slate-600 rounded p-2 mb-2 text-[10px] text-slate-400 italic">
<i class='bx bx-error text-yellow-500'></i> Chave do Groq Ausente. Gerado 100% via Gemini 1.5 Flash.</div>`;
            return headerLog + resposta;
        }

    } catch (error) {
        console.error("[JARVIS][Dev] Erro pipeline:", error);
        return `**Erro Sistêmico:** A comunicação falhou. Isso acontece quando as APIs gratuitas estouram os limites de banda. \n\nLog: *${error.message}*\n\nSugestão: Aguarde um minuto ou peça códigos mais simples/menores por vez.`;
    }
}

// =========================================================================
// AIMP: ENGENHARIA DE PROCESSOS (Corrigido para Gemini 1.5 Flash)
// =========================================================================
export async function analisarEGerarProcessoAIMP(contextoUsuario, nomeArquivoAnexo) {
    if (!chaveApiArmazenada) {
        const snap = await get(ref(database, 'admin_config/gemini_api_key'));
        if (snap.exists()) chaveApiArmazenada = snap.val();
    }

    console.log(`[JARVIS][AIMP] Pipeline iniciado (Single-Agent 1.5 Flash) para evitar limites.`);

    try {
        const pUnico = `Analise o contexto: ${contextoUsuario}\nArquivo: ${nomeArquivoAnexo||'Nenhum'}\nGere: 1) Diagnóstico Rápido, 2) POP em formato de Checklist claro, e 3) Três KPIs para auditoria.`;
        
        // Chamada rápida via Gemini 1.5 Flash
        const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${chaveApiArmazenada}`;
        const respBase = await fetch(urlGemini, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: pUnico }] }],
                systemInstruction: { parts: [{ text: "Você é Engenheiro de Processos e Auditor de Qualidade McDonald's. Regras blindadas a erros." }] }
            })
        });
        const dataBase = await respBase.json();
        const textoBase = dataBase.candidates[0].content.parts[0].text;

        // AGENTE RENDERIZADOR HTML
        console.log(`[JARVIS][AIMP] Formatando para HTML Tailwind...`);
        const promptHtml = `Formate o texto abaixo em blocos HTML puros usando as classes Tailwind. Não crie \`<html>\` ou \`<body>\`, apenas as DIVs internas.

Para títulos: <div class="relative pl-4 mb-6"><div class="absolute left-0 top-0 bottom-0 w-1 bg-emerald-500 rounded-full"></div><h1 class="text-xl font-extrabold text-white tracking-wide uppercase">[TITULO]</h1></div>
Para textos/diagnósticos: <div class="bg-slate-800/50 border border-slate-700 rounded-xl p-5 mb-4 text-slate-300 text-sm leading-relaxed">[texto]</div>
Para alertas: <div class="bg-red-900/20 border border-red-800 rounded-xl p-4 mb-4 flex items-start gap-3"><p class="text-red-200 text-sm">[aviso]</p></div>
Para checklists: <div class="space-y-2 mb-6"><label class="flex items-center gap-3 p-3 bg-slate-800/80 border border-slate-700 hover:border-emerald-500/50 rounded-lg cursor-pointer"><input type="checkbox" class="w-5 h-5 accent-emerald-500 bg-slate-900"><span class="text-slate-200 text-sm font-medium">[PASSO DO CHECKLIST AQUI]</span></label></div>
Para KPIs: <div class="bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-700 rounded-xl p-4 mb-2"><div class="text-sky-400 text-xs font-bold uppercase">[NOME DO KPI]</div><div class="text-slate-400 text-xs mt-1">[Detalhe]</div></div>

CONTEÚDO:
${textoBase}`;

        const respHtml = await fetch(urlGemini, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: promptHtml }] }]
            })
        });
        const dataHtml = await respHtml.json();
        let htmlFinal = dataHtml.candidates[0].content.parts[0].text;
        htmlFinal = htmlFinal.replace(/```html/g, '').replace(/```/g, '').trim();

        const headerRodizio = `<div class="flex items-center gap-2 text-[10px] text-slate-500 mb-6 pb-2 border-b border-slate-800 uppercase tracking-widest font-bold"><i class='bx bx-bot'></i> Engine Padrão McDonald's via Gemini 1.5 Flash</div>`;

        return headerRodizio + htmlFinal;

    } catch (e) {
        console.error(`[JARVIS][AIMP] Erro:`, e.message);
        throw new Error(`Falha no motor de processos. Detalhe: ${e.message}`);
    }
}
