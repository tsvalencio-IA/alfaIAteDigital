// NOME DO ARQUIVO: gemini-api.js
// LOCALIZAÇÃO: Dentro da pasta 'js'

import { database, ref, push, set, get } from './firebase-config.js';

let chatHistoryCliente = [];
let chaveApiArmazenada = null;
let leadJaCapturado = false;

// ============================================================
// LOCK GLOBAL: impede múltiplas chamadas simultâneas à API
// ============================================================
let _geminiLocked = false;

// =========================================================================
// CÉREBRO 1: A CONSULTORA E ARQUITETA (ENTREVISTA PROFISSIONAL)
// =========================================================================
export let systemPrompt = `Você é o Consultor Sênior e Arquiteto de Software da 'thIAguinho Soluções'. 
Sua missão é atuar como um verdadeiro perito de negócios. NÃO peça o WhatsApp no início. Você precisa fazer um diagnóstico completo primeiro.

REGRA DOS BOTÕES: Finalize todas as mensagens com opções clicáveis OBRIGATÓRIAS.
Formato exato: [OPCOES: Opção 1 | Opção 2]. NUNCA use "A" ou "B".

FUNIL DE ENTREVISTA OBRIGATÓRIO (Siga a ordem, UMA pergunta por vez):
PASSO 1 (Abertura): Cumprimente, pergunte o nome e se busca solução para Empresa ou Pessoal.
PASSO 2 (O Contexto): Pergunte o Ramo de Atuação, como a empresa funciona hoje ou o tamanho da equipe. Deixe o cliente explicar o cenário.
PASSO 3 (A Dor Real): Descubra o gargalo. Se o cliente disser "fluxo de caixa", pergunte como fazem hoje (papel, planilha?). Cave fundo no problema.
PASSO 4 (A Autoridade): Mostre empatia. Explique brevemente como a automação de processos e um sistema digital resolvem essa falha específica da operação deles.
PASSO 5 (O Fechamento): AGORA SIM, diga que você tem todas as informações para desenhar a arquitetura ideal e PEÇA O WHATSAPP (com DDD).
PASSO 6 (A Confirmação do Celular): Quando o cliente digitar o número, você DEVE PERGUNTAR se o número está correto. Exemplo: "Esse é o seu celular: 1-7-9-9... ?". [OPCOES: Sim, é esse mesmo | Não, vou digitar de novo]. ATENÇÃO MÁXIMA: Para a nossa voz robótica ler o número corretamente e não como milhões, você DEVE OBRIGATORIAMENTE escrever o número com hífens entre cada dígito (exemplo: 1-7-9-9-7-6-3-1-2-1-0). Nunca escreva os números todos juntos.
PASSO 7 (Despedida): Após o cliente confirmar que o número está correto ("Sim"), agradeça, diga que o Thiago entrará em contato com a solução pronta e encerre a conversa gerando a tag secreta.

REGRA DE ENCERRAMENTO: Após receber a confirmação do WhatsApp e gerar a Tag, a entrevista ACABA. Se o cliente continuar falando, apenas diga: "Tudo anotado! O Thiago entrará em contato em breve."

SEGREDO DA TAG (GERAR APENAS NO PASSO 7, UMA ÚNICA VEZ):
[LEAD: NOME=nome | EMPRESA=ramo e tamanho | DORES=resumo da dor profunda | FACILITOIDE=arquitetura do sistema proposta | WHATSAPP=numeros]`;

export function atualizarPromptMemoria(novoPrompt) {
    if (novoPrompt && novoPrompt.trim() !== '') {
        systemPrompt = novoPrompt;
    }
}

async function obterChaveDaApi() {
    if (chaveApiArmazenada) return chaveApiArmazenada;
    try {
        const snapshot = await get(ref(database, 'admin_config/gemini_api_key'));
        if (snapshot.exists()) {
            chaveApiArmazenada = snapshot.val();
            return chaveApiArmazenada;
        }
    } catch (e) {
        console.error('[JARVIS][Firebase] Erro ao resgatar chave da API:', e);
    }
    return null;
}

// ============================================================
// FUNÇÃO ÚNICA: sendMessageToGemini
// Centraliza timeout (15s), retry (máx 2), logging detalhado
// ============================================================
async function sendMessageToGemini(modelUrl, requestBody, retryCount = 0) {
    const MAX_RETRIES = 2;
    const TIMEOUT_MS = 15000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        console.log(`[JARVIS][API] Tentativa ${retryCount + 1} — URL: ${modelUrl.split('?')[0]}`);
        console.log('[JARVIS][API] Request body (resumo):', JSON.stringify({
            contentsLength: requestBody.contents?.length,
            firstRole: requestBody.contents?.[0]?.role,
            lastRole: requestBody.contents?.[requestBody.contents?.length - 1]?.role,
            systemInstructionLen: requestBody.system_instruction?.parts?.[0]?.text?.length
        }));

        const res = await fetch(modelUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const data = await res.json();

        if (!res.ok || data.error) {
            const errCode = data.error?.code || res.status;
            const errMsg  = data.error?.message || `HTTP ${res.status}`;
            console.error(`[JARVIS][API] Erro da API — ${errCode}: ${errMsg}`);
            throw new Error(`${errCode}: ${errMsg}`);
        }

        console.log('[JARVIS][API] Resposta recebida com sucesso.');
        return data;

    } catch (e) {
        clearTimeout(timeoutId);

        if (e.name === 'AbortError') {
            throw new Error('[Timeout] Requisição ultrapassou 15 segundos.');
        }

        console.warn(`[JARVIS][API] Falha na tentativa ${retryCount + 1}:`, e.message);

        if (retryCount < MAX_RETRIES) {
            const delay = (retryCount + 1) * 2000; // 2s, 4s
            console.log(`[JARVIS][API] Retentando em ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            return sendMessageToGemini(modelUrl, requestBody, retryCount + 1);
        }

        throw e;
    }
}

// ============================================================
// CONSTRUÇÃO SEGURA DO ARRAY DE CONTENTS
// CORREÇÃO CRÍTICA: a API do Gemini exige:
//   1. Começar com role 'user'
//   2. Alternar estritamente user → model → user → model
//   3. Terminar com role 'user' (mensagem atual)
// ============================================================
function buildContents(history) {
    const contents = [];

    for (const m of history) {
        const roleApi = (m.role === 'user' || m.role === 'admin') ? 'user' : 'model';
        const texto   = String(m.text || '').trim();
        if (!texto) continue;

        if (contents.length === 0 || contents[contents.length - 1].role !== roleApi) {
            // Novo turno: cria entrada
            contents.push({ role: roleApi, parts: [{ text: texto }] });
        } else {
            // Mesmo role consecutivo: mescla (evita erro da API)
            contents[contents.length - 1].parts.push({ text: texto });
        }
    }

    // CORREÇÃO: se o array começa com 'model' (saudação inicial do bot foi
    // adicionada ao histórico antes de qualquer mensagem do usuário),
    // insere uma âncora 'user' para satisfazer o requisito da API.
    if (contents.length > 0 && contents[0].role === 'model') {
        console.warn('[JARVIS][History] Histórico iniciava com "model" — inserindo âncora user.');
        contents.unshift({ role: 'user', parts: [{ text: 'Olá' }] });
    }

    return contents;
}

// ============================================================
// CÉREBRO 1 — askGemini: Conversa Principal
// Lock + Debounce + Timeout + Retry + Sanitização
// ============================================================
export async function askGemini(msgUsuario) {

    // DEBOUNCE / LOCK: bloqueia chamadas simultâneas
    if (_geminiLocked) {
        console.warn('[JARVIS] askGemini bloqueado — outra chamada em andamento.');
        return 'Aguarde, ainda estou processando sua mensagem...';
    }
    _geminiLocked = true;

    try {
        // Sanitização do input
        const msgSanitizada = String(msgUsuario || '')
            .trim()
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .substring(0, 2000);

        if (!msgSanitizada) {
            return 'Por favor, envie uma mensagem para continuar.';
        }

        const apiKey = await obterChaveDaApi();
        if (!apiKey) {
            return 'Aviso: Chave da API não configurada ou erro de permissão no Firebase.';
        }

        // CORREÇÃO: gemini-2.5-flash para geração de texto (suporta contexto longo)
        const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        // CORREÇÃO PRINCIPAL: constrói o histórico com alternância correta.
        // NOTA: msgUsuario já foi adicionado ao chatHistoryCliente ANTES desta chamada
        // (via adicionarAoHistorico em ar-logic.js), portanto está incluso no buildContents.
        const contents = buildContents(chatHistoryCliente);

        // Segurança adicional: se o array ficou vazio ou não termina em 'user',
        // adiciona a mensagem atual explicitamente.
        if (contents.length === 0) {
            contents.push({ role: 'user', parts: [{ text: msgSanitizada }] });
        } else if (contents[contents.length - 1].role !== 'user') {
            contents.push({ role: 'user', parts: [{ text: msgSanitizada }] });
        }

        const requestBody = {
            contents,
            system_instruction: { parts: [{ text: systemPrompt }] }
        };

        const data = await sendMessageToGemini(MODEL_URL, requestBody);

        let botReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!botReply) {
            console.error('[JARVIS][API] Resposta sem conteúdo de texto:', JSON.stringify(data));
            return 'Desculpe, ocorreu um erro de processamento. Pode repetir?';
        }

        // CAPTURA DO LEAD (lógica original preservada integralmente)
        const regexLead = /\[LEAD:\s*NOME=([\s\S]*?)\|\s*EMPRESA=([\s\S]*?)\|\s*DORES=([\s\S]*?)\|\s*FACILITOIDE=([\s\S]*?)\|\s*WHATSAPP=([\s\S]*?)\]/i;
        const match = botReply.match(regexLead);

        if (match) {
            if (!leadJaCapturado) {
                const [, nome, empresa, dores, facilitoide, whatsapp] = match;
                let wppLimpo = whatsapp.replace(/\D/g, '');
                if (wppLimpo.startsWith('55') && wppLimpo.length > 11) wppLimpo = wppLimpo.substring(2);

                const novoLeadRef = push(ref(database, 'projetos_capturados'));
                await set(novoLeadRef, {
                    nome:        nome.trim()        || 'Cliente Indefinido',
                    empresa:     empresa.trim()     || 'Não informada',
                    dores:       dores.trim()       || 'Sem dor detalhada',
                    facilitoide: facilitoide.trim() || 'Arquitetura pendente.',
                    whatsapp:    wppLimpo,
                    data:        new Date().toISOString(),
                    devChat:     [],
                    status:      'novo'
                });
                leadJaCapturado = true;
                console.log('[JARVIS][Lead] Lead capturado com sucesso!');
            }
            botReply = botReply.replace(regexLead, '').trim();
        } else if (leadJaCapturado) {
            botReply = botReply.replace(/\[LEAD:.*?\]/gi, '').trim();
        }

        return botReply;

    } catch (e) {
        console.error('[JARVIS] Falha crítica em askGemini:', e.message);
        return 'Houve uma falha na conexão. Pode repetir a informação?';
    } finally {
        // SEMPRE libera o lock, mesmo em caso de erro
        _geminiLocked = false;
    }
}

export function adicionarAoHistorico(role, texto) {
    chatHistoryCliente.push({ role, text: texto });
}

// =========================================================================
// CÉREBRO 2: O ENGENHEIRO SAAS (INJETOR DA VOZ NEURAL DO GEMINI)
// =========================================================================
export async function conversarComDesenvolvedorIA(msgAdmin, contextoProjeto, historicoSalvo = [], idProjetoAtivo = 'padrao') {
    try {
        const apiKey = await obterChaveDaApi();
        if (!apiKey) return 'Configure a chave da API no Painel primeiro.';

        // CORREÇÃO: template atualizado para gemini-2.5-flash (único que suporta AUDIO)
        const promptDesenvolvedor = `Você é um Engenheiro de Software Sênior construindo sistemas para a thIAguinho Soluções.
        Projeto atual: ${contextoProjeto}
        ID ÚNICO do Cliente: ${idProjetoAtivo}
        
        Sempre coloque os códigos gerados em blocos Markdown puros (ex: \`\`\`html).

        DIRETRIZ MÁXIMA PARA O MOTOR DE VOZ DO MASCOTE:
        Sempre que for criar um sistema com Chatbot/Mascote de voz, você é OBRIGADO a colocar exatamente a seguinte função JavaScript no código do cliente para processar a voz:

        \`\`\`javascript
        let globalAudioCtx = null;
        async function falarComMascote(textoParaFalar) {
            if (!globalAudioCtx) globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (globalAudioCtx.state === 'suspended') globalAudioCtx.resume();
            
            try {
                const resKey = await fetch('https://thiaguinho-40a14-default-rtdb.firebaseio.com/admin_config/gemini_api_key.json');
                const adminApiKey = await resKey.json();
                const resVoice = await fetch('https://thiaguinho-40a14-default-rtdb.firebaseio.com/admin_config/gemini_voice_name.json');
                const voiceName = await resVoice.json() || "Aoede";

                if (!adminApiKey) throw new Error("Chave do Admin não encontrada.");

                const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + adminApiKey;
                const payload = {
                    contents: [{ role: "user", parts: [{ text: textoParaFalar }] }],
                    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } } }
                };

                const res = await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                const data = await res.json();
                if (!res.ok || data.error) throw new Error(data.error?.message || "HTTP " + res.status);
                const base64Audio = data.candidates[0].content.parts[0].inlineData.data;

                const binaryString = window.atob(base64Audio);
                const buffer = new ArrayBuffer(binaryString.length);
                const view = new Uint8Array(buffer);
                for (let i = 0; i < binaryString.length; i++) { view[i] = binaryString.charCodeAt(i); }
                const int16View = new Int16Array(buffer);
                const audioBuffer = globalAudioCtx.createBuffer(1, int16View.length, 24000);
                const channelData = audioBuffer.getChannelData(0);
                for (let i = 0; i < int16View.length; i++) { channelData[i] = int16View[i] / 32768.0; }
                const source = globalAudioCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(globalAudioCtx.destination);
                source.start();

            } catch(e) {
                console.warn("Falha no Motor Gemini TTS, ativando plano B local: ", e.message);
                const fallback = new SpeechSynthesisUtterance(textoParaFalar);
                fallback.lang = 'pt-BR';
                window.speechSynthesis.speak(fallback);
            }
        }
        \`\`\`

        A ÚNICA OUTRA COISA OBRIGATÓRIA É O CHAT REVERSO (FEEDBACK DIRETO PARA O THIAGO):
        - Adicione um botão flutuante e chamativo no HTML gerado (ex: "Gostou do sistema? Fale com o Thiago").
        - URL EXATA DO FETCH: https://thiaguinho-40a14-default-rtdb.firebaseio.com/projetos_capturados/${idProjetoAtivo}/feedbacks.json
        - Exemplo: fetch('https://thiaguinho-40a14-default-rtdb.firebaseio.com/projetos_capturados/${idProjetoAtivo}/feedbacks.json', { method: 'POST', body: JSON.stringify({ texto: msg, data: new Date().toISOString() }) })

        Comece sua resposta avisando o Thiago que o código está pronto e que o motor de Voz Neural do Gemini foi injetado com sucesso.`;

        const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        // CORREÇÃO: buildContents aplicado ao histórico do dev também
        const contents = [];
        for (const m of historicoSalvo) {
            const roleApi = m.role === 'user' ? 'user' : 'model';
            const texto   = String(m.text || '').trim();
            if (!texto) continue;
            if (contents.length === 0 || contents[contents.length - 1].role !== roleApi) {
                contents.push({ role: roleApi, parts: [{ text: texto }] });
            } else {
                contents[contents.length - 1].parts.push({ text: texto });
            }
        }

        // Garante começa com 'user'
        if (contents.length > 0 && contents[0].role === 'model') {
            contents.unshift({ role: 'user', parts: [{ text: 'Olá, preciso de ajuda.' }] });
        }

        // Adiciona a mensagem atual do admin
        if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
            contents.push({ role: 'user', parts: [{ text: msgAdmin }] });
        } else {
            contents[contents.length - 1].parts.push({ text: msgAdmin });
        }

        const data = await sendMessageToGemini(MODEL_URL, {
            contents,
            system_instruction: { parts: [{ text: promptDesenvolvedor }] }
        });

        return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Erro de processamento da IA.';

    } catch (e) {
        console.error('[JARVIS][Dev] Erro em conversarComDesenvolvedorIA:', e.message);
        return 'Erro de compilação da IA: ' + e.message;
    }
}

// =========================================================================
// CÉREBRO 3: ENGENHARIA DE PROCESSOS (AIMP - PADRÃO MCDONALD'S)
// =========================================================================
export async function analisarEGerarProcessoAIMP(contextoCaotico, nomeVideoAnexado = null) {
    try {
        const apiKey = await obterChaveDaApi();
        if (!apiKey) throw new Error('Chave da API não encontrada.');

        let intro = contextoCaotico;
        if (nomeVideoAnexado) {
            intro = `[Análise Simulada do Vídeo Anexado: ${nomeVideoAnexado}]\n\n` + intro;
        }

        const promptEngenheiroProcessos = `Você é um Engenheiro de Processos Sênior, criador do AIMP. 
        Sua especialidade é criar a "Consistência McDonald's" para empresas que têm rotinas caóticas.
        O usuário vai relatar um problema na operação dele (ou simular a visão de um vídeo anexado).
        
        Sua Missão: Transformar essa bagunça em um Procedimento Operacional Padrão (POP) perfeito e à prova de falhas.
        
        REGRAS DE FORMATAÇÃO MÁXIMA (Obrigatório):
        - NÃO USE markdown de bloco de código (\`\`\`html).
        - Você deve responder APENAS com código HTML puro, usando as classes do Tailwind CSS para ficar lindo dentro do painel do Thiago.
        - Estrutura esperada:
          <h1 class="text-xl font-bold text-emerald-400 mb-4 border-b border-slate-700 pb-2">POP: [Nome do Processo]</h1>
          <div class="mb-4 bg-slate-900 p-4 rounded-lg border-l-4 border-emerald-500">
             <h2 class="text-white font-bold mb-2">1. Objetivo</h2>
             <p class="text-slate-300 text-sm">...</p>
          </div>
          <div class="mb-4 bg-slate-900 p-4 rounded-lg border-l-4 border-emerald-500">
             <h2 class="text-white font-bold mb-2">2. Checklist Passo a Passo</h2>
             <ul class="list-none space-y-2 text-sm text-slate-300">
                <li class="flex items-start gap-2"><i class='bx bx-check-circle text-emerald-400 mt-1'></i> [Ação]</li>
             </ul>
          </div>
          <div class="bg-red-900/20 p-4 rounded-lg border border-red-900/50">
             <h2 class="text-red-400 font-bold mb-2"><i class='bx bx-error-circle'></i> Pontos Críticos de Falha</h2>
             <p class="text-slate-300 text-sm">...</p>
          </div>
        
        Seja analítico, inteligente e mostre que a thIAguinho Soluções é capaz de estruturar negócios perfeitamente.`;

        const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

        const data = await sendMessageToGemini(MODEL_URL, {
            contents: [{ role: 'user', parts: [{ text: intro }] }],
            system_instruction: { parts: [{ text: promptEngenheiroProcessos }] }
        });

        let htmlResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Erro de geração.';
        htmlResponse = htmlResponse.replace(/```html/g, '').replace(/```/g, '').trim();
        return htmlResponse;

    } catch (e) {
        console.error('[JARVIS][AIMP] Erro:', e.message);
        throw new Error('Falha no Cérebro AIMP: ' + e.message);
    }
}
