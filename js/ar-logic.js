// NOME DO ARQUIVO: ar-logic.js
// LOCALIZAÇÃO: Dentro da pasta 'js'

import { askGemini, adicionarAoHistorico } from './gemini-api.js';
import { database, ref, get } from './firebase-config.js';

document.addEventListener('DOMContentLoaded', async () => {
    const chatDisplay   = document.getElementById('chat-display');
    const userInput     = document.getElementById('user-input');
    const btnSend       = document.getElementById('btn-send');
    const btnMic        = document.getElementById('btn-mic');
    const videoMascote  = document.getElementById('vid');

    const startScreen = document.getElementById('start-screen');
    const uiLayer     = document.getElementById('ui-layer');

    let isProcessing = false;
    let audioAtual   = null;

    // LOCK TTS: impede múltiplas sínteses simultâneas
    let _ttsLocked = false;

    // VARIÁVEL GLOBAL DE ÁUDIO (destrancada pelo gesto do usuário)
    let globalAudioCtx = null;

    // ============================================================
    // DESTRANCADOR DE ÁUDIO (obrigatório para iOS/Android)
    // ============================================================
    function unlockAudio() {
        if (!globalAudioCtx) {
            globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (globalAudioCtx.state === 'suspended') {
            globalAudioCtx.resume();
        }
        // Toca buffer silencioso para "destravar" o contexto
        const buffer = globalAudioCtx.createBuffer(1, 1, 22050);
        const source = globalAudioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(globalAudioCtx.destination);
        source.start(0);
    }

    document.getElementById('btn-start').addEventListener('click', () => {
        unlockAudio();

        startScreen.classList.add('hidden');
        uiLayer.classList.remove('hidden');

        if (videoMascote) {
            videoMascote.play().catch(e => console.log('[JARVIS][Video] Auto-play bloqueado:', e.message));
        }

        if (chatDisplay.children.length === 0) {
            const msgInicial = 'Olá! Sou o arquiteto inteligente da thIAguinho Soluções! Como posso te chamar? E você busca uma solução para sua Empresa ou para sua Vida Pessoal? [OPCOES: Para minha Empresa | Para minha Vida Pessoal]';
            processarEExibirMensagemBot(msgInicial);
        }
    });

    // ============================================================
    // SÍNTESE DE VOZ — Motor Gemini TTS com fallback local
    // CORREÇÃO: modelo atualizado para gemini-2.5-flash (único que
    // suporta responseModalities: ["AUDIO"] na v1beta REST API)
    // ============================================================
    async function falar(texto) {
        // LOCK TTS: ignora chamada se já está sintetizando
        if (_ttsLocked) {
            console.warn('[JARVIS][TTS] Síntese bloqueada — outra em andamento.');
            return;
        }
        _ttsLocked = true;

        try {
            // Para sínteses anteriores
            if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();
            if (globalAudioCtx && audioAtual) {
                try { audioAtual.stop(); } catch (e) { /* silencia erro de stop em source já parado */ }
                audioAtual = null;
            }

            // Limpa texto para voz: remove tokens de opções, markdown bold, espaços extras
            let textoVoz = texto
                .replace(/\[OPCOES:.*?\]/i, '')
                .replace(/\*\*/g, '')
                .trim();
            if (!textoVoz) return;

            // Separa números longos com hífens para que a voz os leia corretamente
            textoVoz = textoVoz.replace(/\d{5,}/g, match => match.split('').join(' '));

            // Tenta buscar a chave via Firebase
            let apiKey   = null;
            let voiceName = 'Aoede';
            try {
                const snapKey   = await get(ref(database, 'admin_config/gemini_api_key'));
                const snapVoice = await get(ref(database, 'admin_config/gemini_voice_name'));
                if (snapKey.exists())   apiKey    = snapKey.val();
                if (snapVoice.exists()) voiceName = snapVoice.val();
            } catch (e) {
                console.warn('[JARVIS][TTS] Falha ao buscar chave do Firebase. Usando plano B local.', e.message);
            }

            if (apiKey) {
                try {
                    // CORREÇÃO: gemini-2.5-flash suporta responseModalities AUDIO
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
                    const payload = {
                        contents: [{ role: 'user', parts: [{ text: textoVoz }] }],
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: { voiceName }
                                }
                            }
                        }
                    };

                    console.log('[JARVIS][TTS] Solicitando síntese Gemini...');

                    // TTS NÃO usa retry para não acumular 400s em cascata
                    const controller = new AbortController();
                    const timeoutId  = setTimeout(() => controller.abort(), 12000);

                    const res  = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    const data = await res.json();

                    if (!res.ok || data.error) {
                        throw new Error(`${data.error?.code || res.status}: ${data.error?.message || 'Erro TTS'}`);
                    }

                    const base64Audio = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                    if (!base64Audio) throw new Error('Sem dado de áudio na resposta Gemini.');

                    // Decodifica PCM16 e reproduz via Web Audio API
                    const binaryString = window.atob(base64Audio);
                    const buffer       = new ArrayBuffer(binaryString.length);
                    const view         = new Uint8Array(buffer);
                    for (let i = 0; i < binaryString.length; i++) {
                        view[i] = binaryString.charCodeAt(i);
                    }
                    const int16View   = new Int16Array(buffer);
                    const audioBuffer = globalAudioCtx.createBuffer(1, int16View.length, 24000);
                    const channelData = audioBuffer.getChannelData(0);
                    for (let i = 0; i < int16View.length; i++) {
                        channelData[i] = int16View[i] / 32768.0;
                    }

                    audioAtual = globalAudioCtx.createBufferSource();
                    audioAtual.buffer = audioBuffer;
                    audioAtual.connect(globalAudioCtx.destination);
                    audioAtual.onended = () => { audioAtual = null; };
                    audioAtual.start();

                    console.log('[JARVIS][TTS] Áudio Gemini reproduzindo.');
                    return; // Sucesso — sai da função antes do fallback

                } catch (e) {
                    console.warn('[JARVIS][TTS] Motor Gemini falhou, ativando plano B local:', e.message);
                }
            }

            // PLANO B: SpeechSynthesis nativa do navegador
            const utterance = new SpeechSynthesisUtterance(textoVoz);
            utterance.lang  = 'pt-BR';
            window.speechSynthesis.speak(utterance);

        } finally {
            // SEMPRE libera o lock TTS (mesmo que o áudio ainda esteja tocando)
            // O lock serve apenas para evitar que duas sínteses INICIEM ao mesmo tempo
            _ttsLocked = false;
        }
    }

    // ============================================================
    // RECONHECIMENTO DE VOZ (Microfone)
    // ============================================================
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.lang  = 'pt-BR';

        btnMic.addEventListener('click', () => {
            unlockAudio();
            if (isProcessing) return;
            if (btnMic.classList.contains('listening')) {
                recognition.stop();
                btnMic.classList.remove('listening');
                userInput.placeholder = 'Digite ou escolha uma opção...';
            } else {
                recognition.start();
                btnMic.classList.add('listening');
                userInput.placeholder = 'Ouvindo...';
            }
        });

        recognition.onresult = (e) => {
            userInput.value = e.results[0][0].transcript;
            btnMic.classList.remove('listening');
            userInput.placeholder = 'Digite ou escolha uma opção...';
            enviarMensagemDigitada();
        };

        recognition.onerror = (e) => {
            console.warn('[JARVIS][Mic] Erro no reconhecimento:', e.error);
            btnMic.classList.remove('listening');
            userInput.placeholder = 'Digite ou escolha uma opção...';
        };
    } else {
        btnMic.style.display = 'none';
    }

    // ============================================================
    // RENDERIZAÇÃO DE MENSAGENS NA UI
    // ============================================================
    function addMsgVisual(sender, text) {
        const div       = document.createElement('div');
        div.className   = `msg ${sender}`;
        div.innerHTML   = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        chatDisplay.appendChild(div);
        chatDisplay.scrollTop = chatDisplay.scrollHeight;
    }

    function processarEExibirMensagemBot(respostaCompleta) {
        const regexOpcoes = /\[OPCOES:\s*(.*?)\]/i;
        const match       = respostaCompleta.match(regexOpcoes);

        let textoLimpo = respostaCompleta.replace(regexOpcoes, '').trim();

        addMsgVisual('bot', textoLimpo);
        adicionarAoHistorico('bot', respostaCompleta);
        falar(textoLimpo);

        if (match && match[1]) {
            const opcoes = match[1].split('|').map(o => o.trim());
            renderizarBotoesDeOpcao(opcoes);
        }
    }

    function renderizarBotoesDeOpcao(arrayOpcoes) {
        const antigos = document.getElementById('opcoes-ativas');
        if (antigos) antigos.remove();

        const container   = document.createElement('div');
        container.className = 'opcoes-container';
        container.id      = 'opcoes-ativas';

        arrayOpcoes.forEach(opcaoText => {
            const btn     = document.createElement('button');
            btn.className = 'btn-opcao';
            btn.innerText = opcaoText;
            btn.onclick   = (event) => {
                unlockAudio();
                if (isProcessing) { event.preventDefault(); return; }
                isProcessing = true;
                container.style.opacity       = '0.5';
                container.style.pointerEvents = 'none';
                setTimeout(() => { enviarMensagemClicada(opcaoText); }, 50);
            };
            container.appendChild(btn);
        });

        chatDisplay.appendChild(container);
        chatDisplay.scrollTop = chatDisplay.scrollHeight;
    }

    // ============================================================
    // ENVIO DE MENSAGENS
    // ============================================================
    async function enviarMensagemClicada(textoClicado) {
        const antigasOpcoes = document.getElementById('opcoes-ativas');
        if (antigasOpcoes) antigasOpcoes.remove();

        addMsgVisual('user', textoClicado);
        adicionarAoHistorico('user', textoClicado);
        await invocarGemini(textoClicado);
    }

    async function enviarMensagemDigitada() {
        unlockAudio();
        if (isProcessing) return;

        const msg = userInput.value.trim();
        if (!msg) return;
        isProcessing = true;

        userInput.value = '';
        const antigasOpcoes = document.getElementById('opcoes-ativas');
        if (antigasOpcoes) antigasOpcoes.remove();

        addMsgVisual('user', msg);
        adicionarAoHistorico('user', msg);
        await invocarGemini(msg);
    }

    // ============================================================
    // INVOCAÇÃO DO GEMINI (com try/catch para garantir reset do lock)
    // ============================================================
    async function invocarGemini(textoUser) {
        // Desabilita UI durante processamento
        btnSend.style.opacity       = '0.5';
        btnSend.style.pointerEvents = 'none';
        userInput.disabled          = true;

        const ind       = document.createElement('div');
        ind.className   = 'text-xs text-slate-400 mt-1 mb-3 text-center font-bold';
        ind.id          = 'digitando';
        ind.innerHTML   = "<i class='bx bx-loader-alt bx-spin'></i> Construindo a arquitetura técnica...";
        chatDisplay.appendChild(ind);
        chatDisplay.scrollTop = chatDisplay.scrollHeight;

        try {
            const resp = await askGemini(textoUser);

            document.getElementById('digitando')?.remove();
            processarEExibirMensagemBot(resp);

        } catch (e) {
            // Captura erros inesperados que possam vazar do askGemini
            console.error('[JARVIS][invocarGemini] Erro inesperado:', e.message);
            document.getElementById('digitando')?.remove();
            processarEExibirMensagemBot('Houve uma falha na conexão. Pode repetir a informação?');

        } finally {
            // SEMPRE reseta o lock de processamento e reabilita a UI
            isProcessing                = false;
            btnSend.style.opacity       = '1';
            btnSend.style.pointerEvents = 'auto';
            userInput.disabled          = false;
            userInput.focus();
        }
    }

    // ============================================================
    // EVENT LISTENERS
    // ============================================================
    btnSend.addEventListener('click', enviarMensagemDigitada);
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') enviarMensagemDigitada();
    });
});
