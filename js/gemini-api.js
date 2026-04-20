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

--- CAMINHO EMPRESA ---
PASSO 3E: Ramo de atuação, equipe, como funciona hoje. [OPCOES: Explico melhor | Descrevo o problema]
PASSO 4E: Descubra a dor real. Cave fundo. [OPCOES: É isso mesmo | Tem mais detalhe]
PASSO 5E: Mostre empatia + como a solução digital resolve. [OPCOES: Faz sentido | Outra dúvida]
PASSO 6E: Peça o WhatsApp com DDD. [OPCOES: Vou passar meu número | Prefiro outro contato]

--- CAMINHO VIDA PESSOAL ---
PASSO 3P: Qual área quer turbinar? Dê exemplos concretos. [OPCOES: Finanças pessoais | Rotina e hábitos | Saúde e treino | Outro]
PASSO 4P: Como lida com isso hoje? Qual a maior frustração? [OPCOES: Explico melhor | Esse é o ponto]
PASSO 5P: Descreva entusiasticamente a ferramenta que criaria para essa pessoa especificamente. [OPCOES: Adorei! | Quero ajustar algo]
PASSO 6P: Diga que vai criar sob medida. Peça o WhatsApp com DDD. [OPCOES: Vou passar meu número | Prefiro outro contato]

--- CONFIRMAÇÃO (ambos os caminhos) ---
PASSO 7: Confirme o número. ESCREVA com hífens entre CADA dígito (ex: 1-7-9-9-7-6-3-1-2-1-0).
[OPCOES: Sim, é esse mesmo | Não, vou digitar de novo]

PASSO 8: Agradeça pelo nome, deseje ótimo dia, gere a TAG.
Após a tag: "Tudo anotado, [NOME]! O Thiago entrará em contato em breve. 😊"

TAG (APENAS no Passo 8, UMA vez):
[LEAD: NOME=nome | EMPRESA=empresa ou "Projeto Pessoal: descrição" | DORES=resumo | FACILITOIDE=solução proposta | WHATSAPP=numeros]`;

export function atualizarPromptMemoria(novoPrompt) {
    if (novoPrompt && novoPrompt.trim()) systemPrompt = novoPrompt;
}

// ============================================================
// CHAVES
// ============================================================
async function obterChaveDaApi() {
    if (chaveApiArmazenada) return chaveApiArmazenada;
    try {
        const s = await get(ref(database, 'admin_config/gemini_api_key'));
        if (s.exists()) { chaveApiArmazenada = s.val(); return chaveApiArmazenada; }
    } catch (e) { console.error('[JARVIS][Firebase] Erro chave Gemini:', e); }
    return null;
}

async function obterChaveGroq() {
    if (chaveGroqArmazenada) return chaveGroqArmazenada;
    try {
        const s = await get(ref(database, 'admin_config/groq_api_key'));
        if (s.exists()) { chaveGroqArmazenada = s.val(); return chaveGroqArmazenada; }
    } catch (e) { console.warn('[JARVIS][Firebase] Chave Groq ausente:', e.message); }
    return null;
}

// ============================================================
// MOTOR GEMINI: timeout 25s, retry 2x com backoff
// ============================================================
async function sendMessageToGemini(modelUrl, requestBody, retryCount = 0) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 25000);
    try {
        console.log(`[JARVIS][Gemini] Tentativa ${retryCount + 1} — ${modelUrl.split('?')[0].split('/').pop()}`);
        const res  = await fetch(modelUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody), signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(`${data.error?.code || res.status}: ${data.error?.message || 'Erro API'}`);
        console.log('[JARVIS][Gemini] Resposta OK.');
        return data;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('[Timeout] 25s excedidos.');
        console.warn(`[JARVIS][Gemini] Falha tentativa ${retryCount + 1}:`, e.message);
        if (retryCount < 2) { await new Promise(r => setTimeout(r, (retryCount + 1) * 2000)); return sendMessageToGemini(modelUrl, requestBody, retryCount + 1); }
        throw e;
    }
}

// ============================================================
// MOTOR GROQ: OpenAI-compatible, sem retry (evita cascata 429)
// ============================================================
async function callGroqAPI(systemInstruction, userContent, model, groqKey) {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 30000);
    try {
        console.log(`[JARVIS][Groq] Chamando ${model}...`);
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: userContent }], max_tokens: 4096, temperature: 0.3 }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error?.message || `HTTP ${res.status}`);
        const resultado = data.choices?.[0]?.message?.content || '';
        console.log(`[JARVIS][Groq] ${model} OK (${resultado.length} chars).`);
        return resultado;
    } catch (e) {
        clearTimeout(timeoutId);
        console.error(`[JARVIS][Groq] Erro (${model}):`, e.message);
        throw e;
    }
}

async function callGeminiText(systemInstruction, userContent, geminiKey) {
    const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
    const data = await sendMessageToGemini(MODEL_URL, { contents: [{ role: 'user', parts: [{ text: userContent }] }], system_instruction: { parts: [{ text: systemInstruction }] } });
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ============================================================
// SNIPPET TTS injetado em todos os sistemas gerados
// ============================================================
const SNIPPET_TTS = `let globalAudioCtx = null;
async function falarComMascote(textoParaFalar) {
    if (!globalAudioCtx) globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (globalAudioCtx.state === 'suspended') globalAudioCtx.resume();
    try {
        const resKey = await fetch('https://thiaguinho-40a14-default-rtdb.firebaseio.com/admin_config/gemini_api_key.json');
        const adminApiKey = await resKey.json();
        const resVoice = await fetch('https://thiaguinho-40a14-default-rtdb.firebaseio.com/admin_config/gemini_voice_name.json');
        const voiceName = await resVoice.json() || 'Aoede';
        if (!adminApiKey) throw new Error('Chave nao encontrada.');
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + adminApiKey;
        const payload = { contents: [{ role: 'user', parts: [{ text: textoParaFalar }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } } } };
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error?.message || 'Erro TTS');
        const b64 = data.candidates[0].content.parts[0].inlineData.data;
        const bs = window.atob(b64); const buf = new ArrayBuffer(bs.length); const v = new Uint8Array(buf);
        for (let i = 0; i < bs.length; i++) v[i] = bs.charCodeAt(i);
        const i16 = new Int16Array(buf); const ab = globalAudioCtx.createBuffer(1, i16.length, 24000); const ch = ab.getChannelData(0);
        for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768.0;
        const src = globalAudioCtx.createBufferSource(); src.buffer = ab; src.connect(globalAudioCtx.destination); src.start();
    } catch(e) { const f = new SpeechSynthesisUtterance(textoParaFalar); f.lang = 'pt-BR'; window.speechSynthesis.speak(f); }
}`;

// ============================================================
// BUILDCONTENTS
// ============================================================
function buildContents(history) {
    const contents = [];
    for (const m of history) {
        const roleApi = (m.role === 'user' || m.role === 'admin') ? 'user' : 'model';
        const texto   = String(m.text || '').trim();
        if (!texto) continue;
        if (contents.length === 0 || contents[contents.length - 1].role !== roleApi) {
            contents.push({ role: roleApi, parts: [{ text: texto }] });
        } else {
            contents[contents.length - 1].parts.push({ text: texto });
        }
    }
    if (contents.length > 0 && contents[0].role === 'model') {
        console.warn('[JARVIS][History] Historico iniciava com model — inserindo ancora user.');
        contents.unshift({ role: 'user', parts: [{ text: 'Ola' }] });
    }
    return contents;
}

// ============================================================
// CÉREBRO 1 — askGemini (Conversa Principal)
// ============================================================
export async function askGemini(msgUsuario) {
    if (_geminiLocked) { console.warn('[JARVIS] Bloqueado — chamada em andamento.'); return 'Aguarde, ainda estou processando...'; }
    _geminiLocked = true;
    try {
        const msgSanitizada = String(msgUsuario || '').trim().replace(/</g,'&lt;').replace(/>/g,'&gt;').substring(0, 2000);
        if (!msgSanitizada) return 'Por favor, envie uma mensagem para continuar.';
        const apiKey = await obterChaveDaApi();
        if (!apiKey) return 'Aviso: Chave da API nao configurada no Firebase.';
        const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        const contents  = buildContents(chatHistoryCliente);
        if (contents.length === 0) { contents.push({ role: 'user', parts: [{ text: msgSanitizada }] }); }
        else if (contents[contents.length - 1].role !== 'user') { contents.push({ role: 'user', parts: [{ text: msgSanitizada }] }); }
        const data = await sendMessageToGemini(MODEL_URL, { contents, system_instruction: { parts: [{ text: systemPrompt }] } });
        let botReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!botReply) return 'Desculpe, ocorreu um erro de processamento. Pode repetir?';
        const regexLead = /\[LEAD:\s*NOME=([\s\S]*?)\|\s*EMPRESA=([\s\S]*?)\|\s*DORES=([\s\S]*?)\|\s*FACILITOIDE=([\s\S]*?)\|\s*WHATSAPP=([\s\S]*?)\]/i;
        const match = botReply.match(regexLead);
        if (match) {
            if (!leadJaCapturado) {
                const [, nome, empresa, dores, facilitoide, whatsapp] = match;
                let wppLimpo = whatsapp.replace(/\D/g, '');
                if (wppLimpo.startsWith('55') && wppLimpo.length > 11) wppLimpo = wppLimpo.substring(2);
                const novoLeadRef = push(ref(database, 'projetos_capturados'));
                await set(novoLeadRef, { nome: nome.trim() || 'Cliente Indefinido', empresa: empresa.trim() || 'Nao informada', dores: dores.trim() || 'Sem dor', facilitoide: facilitoide.trim() || 'Arquitetura pendente.', whatsapp: wppLimpo, data: new Date().toISOString(), devChat: [], status: 'novo' });
                leadJaCapturado = true;
                console.log('[JARVIS][Lead] Lead capturado!');
            }
            botReply = botReply.replace(regexLead, '').trim();
        } else if (leadJaCapturado) { botReply = botReply.replace(/\[LEAD:.*?\]/gi, '').trim(); }
        return botReply;
    } catch (e) { console.error('[JARVIS] Falha em askGemini:', e.message); return 'Houve uma falha na conexão. Pode repetir a informação?'; }
    finally { _geminiLocked = false; }
}

export function adicionarAoHistorico(role, texto) { chatHistoryCliente.push({ role, text: texto }); }

// =========================================================================
// CÉREBRO 2: RODÍZIO 4 AGENTES — ENGENHEIRO SAAS
// Agente 1: Groq/llama-3.3-70b  → Analista Técnico
// Agente 2: Gemini               → Arquiteto de Sistema
// Agente 3: Groq/llama-3.3-70b  → Desenvolvedor Fullstack
// Agente 4: Gemini               → Revisor Final + Injeções
// =========================================================================
export async function conversarComDesenvolvedorIA(msgAdmin, contextoProjeto, historicoSalvo = [], idProjetoAtivo = 'padrao') {
    try {
        const apiKeyGemini = await obterChaveDaApi();
        const apiKeyGroq   = await obterChaveGroq();
        if (!apiKeyGemini) return 'Configure a chave Gemini no Painel primeiro.';
        const temGroq = !!apiKeyGroq;
        console.log(`[JARVIS][Rodizio-Dev] Pipeline iniciado. Groq disponivel: ${temGroq}`);

        // AGENTE 1: ANALISTA TÉCNICO (Groq)
        console.log('[JARVIS][Rodizio-Dev] Agente 1 — Analista Técnico...');
        let especTecnica = `CONTEXTO: ${contextoProjeto}\nPEDIDO: ${msgAdmin}`;
        if (temGroq) {
            try {
                especTecnica = await callGroqAPI(
`Você é um Analista de Sistemas Sênior. Analise o pedido e estruture:
1. OBJETIVO PRINCIPAL: o que o sistema deve resolver
2. USUARIOS FINAIS: quem usa, em que situação, qual dispositivo
3. FUNCIONALIDADES (máx 10, com complexidade baixa/média/alta)
4. ESTRUTURA DE DADOS: nós Firebase necessários (JSON paths)
5. FLUXO DE TELAS: sequência lógica de estados/telas
6. INTEGRACOES: Gemini API, Firebase Auth, outros
7. RISCOS TÉCNICOS: o que pode dar problema
8. COMPLEXIDADE TOTAL: simples/médio/complexo e porquê`,
                    `CONTEXTO: ${contextoProjeto}\nPEDIDO: ${msgAdmin}`,
                    'llama-3.3-70b-versatile', apiKeyGroq
                );
                console.log('[JARVIS][Rodizio-Dev] Agente 1 OK.');
            } catch (e) { console.warn('[JARVIS][Rodizio-Dev] Agente 1 falhou:', e.message); }
        }

        // AGENTE 2: ARQUITETO (Gemini)
        console.log('[JARVIS][Rodizio-Dev] Agente 2 — Arquiteto...');
        let arquitetura = especTecnica;
        try {
            arquitetura = await callGeminiText(
`Você é um Arquiteto de Software Sênior da thIAguinho Soluções.
Com base na análise técnica, projete a ARQUITETURA COMPLETA:
- Estrutura HTML (seções, modais, componentes)
- Lógica JS (funções principais, eventos, fluxo de dados)
- Estrutura Firebase (paths, estrutura JSON)
- Componentes UI (Tailwind, mobile-first, dark theme)
- Onde e como usar Gemini API e Firebase
Seja detalhado — será usado pelo desenvolvedor na fase seguinte.`,
                `ANÁLISE TÉCNICA:\n${especTecnica}\n\nPEDIDO ORIGINAL: ${msgAdmin}`,
                apiKeyGemini
            );
            console.log('[JARVIS][Rodizio-Dev] Agente 2 OK.');
        } catch (e) { console.warn('[JARVIS][Rodizio-Dev] Agente 2 falhou:', e.message); }

        // AGENTE 3: DESENVOLVEDOR (Groq)
        console.log('[JARVIS][Rodizio-Dev] Agente 3 — Desenvolvedor...');
        let codigoBase = arquitetura;
        if (temGroq) {
            try {
                codigoBase = await callGroqAPI(
`Você é um Desenvolvedor Fullstack. Implemente o sistema em UM arquivo HTML completo e funcional.
REGRAS:
- Zero TODOs ou placeholders — código 100% funcional
- Tailwind CSS CDN: https://cdn.tailwindcss.com
- Boxicons CDN para ícones
- Firebase URL: https://thiaguinho-40a14-default-rtdb.firebaseio.com/
- Responsivo mobile-first, dark theme profissional
- Todos modais e formulários devem funcionar
- Retorne APENAS o HTML dentro de \`\`\`html ... \`\`\``,
                    `ARQUITETURA:\n${arquitetura}\n\nCONTEXTO: ${contextoProjeto}\nID CLIENTE: ${idProjetoAtivo}`,
                    'llama-3.3-70b-versatile', apiKeyGroq
                );
                console.log('[JARVIS][Rodizio-Dev] Agente 3 OK.');
            } catch (e) {
                console.warn('[JARVIS][Rodizio-Dev] Agente 3 Groq falhou, tentando Gemini:', e.message);
                try {
                    codigoBase = await callGeminiText(
                        'Você é um Desenvolvedor Fullstack. Crie um arquivo HTML completo e funcional com Tailwind CSS e Firebase conforme a arquitetura abaixo.',
                        'ARQUITETURA:\n' + arquitetura + '\n\nCONTEXTO: ' + contextoProjeto,
                        apiKeyGemini
                    );
                    console.log('[JARVIS][Rodizio-Dev] Agente 3 OK (Gemini fallback).');
                } catch (e2) {
                    console.warn('[JARVIS][Rodizio-Dev] Agente 3 Gemini fallback falhou:', e2.message);
                }
            }
        }

        // AGENTE 4: REVISOR FINAL (Gemini) + INJEÇÕES OBRIGATÓRIAS
        console.log('[JARVIS][Rodizio-Dev] Agente 4 — Revisor Final...');
        const promptA4 = `Você é o Engenheiro Sênior da thIAguinho Soluções. Revise, corrija e entregue o produto final enterprise.

PROJETO: ${contextoProjeto} | ID CLIENTE: ${idProjetoAtivo}

SE há código HTML, REVISE: corrija bugs, melhore UX/UI, garanta todas as funcionalidades.
SE não há código HTML (apenas arquitetura), CRIE o sistema completo agora.

INJETE OBRIGATORIAMENTE:
1. MOTOR DE VOZ TTS — copie exatamente:
\`\`\`javascript
${SNIPPET_TTS}
\`\`\`

2. BOTÃO DE FEEDBACK REVERSO — botão flutuante canto inferior direito:
\`\`\`javascript
async function enviarFeedback(mensagem) {
    await fetch('https://thiaguinho-40a14-default-rtdb.firebaseio.com/projetos_capturados/${idProjetoAtivo}/feedbacks.json', { method: 'POST', body: JSON.stringify({ texto: mensagem, data: new Date().toISOString() }), headers: { 'Content-Type': 'application/json' } });
}
\`\`\`

INICIE com: **Rodizio de IAs Concluido** + resumo do que cada agente fez e o que você corrigiu/melhorou.
Depois entregue o código final completo.

CÓDIGO BASE:
${codigoBase}`;

        const contsA4 = [];
        for (const m of historicoSalvo) {
            const r = m.role === 'user' ? 'user' : 'model'; const t = String(m.text || '').trim();
            if (!t) continue;
            if (contsA4.length === 0 || contsA4[contsA4.length-1].role !== r) contsA4.push({ role: r, parts: [{ text: t }] });
            else contsA4[contsA4.length-1].parts.push({ text: t });
        }
        if (contsA4.length > 0 && contsA4[0].role === 'model') contsA4.unshift({ role: 'user', parts: [{ text: 'Preciso de ajuda.' }] });
        if (contsA4.length === 0 || contsA4[contsA4.length-1].role !== 'user') contsA4.push({ role: 'user', parts: [{ text: promptA4 }] });
        else contsA4[contsA4.length-1].parts.push({ text: promptA4 });

        const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKeyGemini}`;
        const data = await sendMessageToGemini(MODEL_URL, { contents: contsA4, system_instruction: { parts: [{ text: 'Engenheiro Sênior da thIAguinho. Entregue sistemas profissionais, completos e funcionais.' }] } });
        const resultado = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Erro no revisor.';
        const label = temGroq ? 'Groq Analista → Gemini Arquiteto → Groq Dev → Gemini Revisor' : 'Gemini Arquiteto → Gemini Revisor';
        console.log('[JARVIS][Rodizio-Dev] Pipeline completo!');
        return `**Rodizio IAs:** ${label}\n\n${resultado}`;
    } catch (e) { console.error('[JARVIS][Dev] Erro pipeline:', e.message); return 'Erro no pipeline de IAs: ' + e.message; }
}

// =========================================================================
// CÉREBRO 3: RODÍZIO 4 AGENTES — AIMP (PADRÃO MCDONALD'S)
// Agente 1: Groq/llama-3.3-70b → Diagnóstico de Campo
// Agente 2: Groq/llama-3.3-70b → Redator do POP
// Agente 3: Groq/llama3-8b     → KPIs, Auditorias, Formulários
// Agente 4: Gemini              → Formatador HTML Profissional
// =========================================================================
export async function analisarEGerarProcessoAIMP(contextoCaotico, nomeVideoAnexado = null) {
    try {
        const apiKeyGemini = await obterChaveDaApi();
        const apiKeyGroq   = await obterChaveGroq();
        if (!apiKeyGemini) throw new Error('Chave Gemini não encontrada.');
        let intro = nomeVideoAnexado ? `[Video: ${nomeVideoAnexado}]\n\n${contextoCaotico}` : contextoCaotico;
        const temGroq = !!apiKeyGroq;
        console.log(`[JARVIS][AIMP] Pipeline iniciado. Groq: ${temGroq}`);

        // AGENTE 1: DIAGNÓSTICO DE CAMPO
        console.log('[JARVIS][AIMP] Agente 1 — Diagnóstico...');
        let diagnostico = intro;
        if (temGroq) {
            try {
                diagnostico = await callGroqAPI(
`Especialista em Engenharia de Processos ISO 9001. Diagnóstico clínico:
1. PROCESSO IDENTIFICADO: nome e categoria
2. SITUAÇÃO ATUAL (AS-IS): como funciona hoje passo a passo
3. PONTOS DE FALHA: todos os momentos onde erros ocorrem
4. CAUSA RAIZ: origem real do caos (não sintomas)
5. IMPACTO NO NEGÓCIO: financeiro, reputação, operacional
6. GARGALOS CRITICOS: top 3 travadores de eficiência
7. KPIs SUGERIDOS: 5 indicadores mensuráveis
8. BENCHMARKS: como empresas excelentes fazem este processo`,
                    `SITUAÇÃO:\n${intro}`, 'llama-3.3-70b-versatile', apiKeyGroq
                );
                console.log('[JARVIS][AIMP] Agente 1 OK.');
            } catch (e) { console.warn('[JARVIS][AIMP] Agente 1 falhou:', e.message); }
        }

        // AGENTE 2: REDATOR DO POP
        console.log('[JARVIS][AIMP] Agente 2 — POP...');
        let popDraft = diagnostico;
        if (temGroq) {
            try {
                popDraft = await callGroqAPI(
`Consultor de Processos. Crie um POP completo padrão McDonald's:
- TÍTULO e VERSÃO
- OBJETIVO (uma frase)
- ESCOPO (quem faz, quando)
- PRÉ-REQUISITOS (materiais, acessos)
- PASSO A PASSO: QUEM | O QUÊ | QUANDO | COMO | TEMPO
- CHECKPOINTS obrigatórios com critérios
- TRATAMENTO DE EXCEÇÕES
- DEFINIÇÃO DE PRONTO (critérios objetivos)
- RESPONSÁVEL PELO POP`,
                    `DIAGNÓSTICO:\n${diagnostico}`, 'llama-3.3-70b-versatile', apiKeyGroq
                );
                console.log('[JARVIS][AIMP] Agente 2 OK.');
            } catch (e) { console.warn('[JARVIS][AIMP] Agente 2 falhou:', e.message); popDraft = diagnostico; }
        }

        // AGENTE 3: ENRIQUECEDOR (KPIs + AUDITORIA + FORMULÁRIOS)
        console.log('[JARVIS][AIMP] Agente 3 — Métricas e Auditorias...');
        let popCompleto = popDraft;
        if (temGroq) {
            try {
                popCompleto = await callGroqAPI(
`Especialista em Qualidade e Indicadores. Adicione ao POP:
1. CHECKLIST DE AUDITORIA DIÁRIA (12-15 itens: Sim/Não/N.A. + observação)
2. DASHBOARD DE INDICADORES (KPI | Meta | Como medir | Frequência | Responsável)
3. FORMULÁRIO DE NÃO-CONFORMIDADE (data, desvio, causa, ação corretiva, prazo, responsável)
4. PLANO DE TREINAMENTO (duração, método, critério de aprovação)
5. LOG DE MELHORIAS (data, sugestão, status, resultado)
6. MATRIZ RACI (Responsável/Aprovador/Consultado/Informado por etapa)`,
                    `POP:\n${popDraft}`, 'llama3-8b-8192', apiKeyGroq
                );
                console.log('[JARVIS][AIMP] Agente 3 OK.');
            } catch (e) { console.warn('[JARVIS][AIMP] Agente 3 falhou:', e.message); }
        }

        // AGENTE 4: HTML PROFISSIONAL (Gemini)
        console.log('[JARVIS][AIMP] Agente 4 — Formatador HTML...');
        const promptHtml = `Formate TODO o conteúdo em HTML puro com Tailwind CSS. SEM markdown. Retorne apenas HTML.

ESTRUTURA:
<div class="space-y-6">
  <div class="bg-gradient-to-r from-emerald-900 to-slate-900 p-6 rounded-xl border border-emerald-700">
    <h1 class="text-2xl font-black text-emerald-400 mb-1">POP: [TITULO]</h1>
    <p class="text-slate-400 text-sm">Versão 1.0 — thIAguinho Soluções</p>
  </div>
  <div class="bg-slate-900 p-5 rounded-xl border-l-4 border-emerald-500">
    <h2 class="text-white font-bold text-lg mb-3 flex items-center gap-2"><i class='bx bx-target-lock text-emerald-400'></i>[TITULO SEÇÃO]</h2>
    [conteúdo]
  </div>
</div>
Para checklists: <label class="flex items-center gap-3 p-3 bg-slate-800 rounded-lg cursor-pointer hover:bg-slate-700"><input type="checkbox" class="w-5 h-5 accent-emerald-500"><span class="text-slate-200 text-sm">[item]</span></label>
Para tabelas: use bg-slate-700 no thead, text-slate-300 nas tds, border-b border-slate-700
Para alertas: bg-red-900/20 border border-red-800

CONTEÚDO:
DIAGNÓSTICO: ${diagnostico}

POP COMPLETO COM MÉTRICAS: ${popCompleto}`;

        let htmlFinal = await callGeminiText(promptHtml, promptHtml, apiKeyGemini);
        htmlFinal = htmlFinal.replace(/```html/g, '').replace(/```/g, '').trim();

        const label = temGroq
            ? 'Groq Diagnóstico → Groq POP → Groq KPIs → Gemini HTML'
            : 'Gemini POP + HTML';

        const headerRodizio = `<div class="bg-slate-800 border border-slate-600 rounded-xl p-3 mb-4 text-xs text-slate-400 flex items-center gap-2"><i class='bx bx-git-branch text-emerald-400 text-base'></i><span><strong class="text-emerald-400">Rodizio AIMP:</strong> ${label}</span></div>`;
        console.log('[JARVIS][AIMP] Pipeline completo!');
        return headerRodizio + htmlFinal;
    } catch (e) { console.error('[JARVIS][AIMP] Erro:', e.message); throw new Error('Falha Rodizio AIMP: ' + e.message); }
}
