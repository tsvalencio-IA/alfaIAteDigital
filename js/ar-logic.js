// NOME DO ARQUIVO: ar-logic.js
// LOCALIZAÇÃO: Dentro da pasta 'js'

import { askGemini, adicionarAoHistorico } from './gemini-api.js';
import { database, ref, get } from './firebase-config.js';

document.addEventListener('DOMContentLoaded', async () => {
    const chatDisplay  = document.getElementById('chat-display');
    const userInput    = document.getElementById('user-input');
    const btnSend      = document.getElementById('btn-send');
    const btnMic       = document.getElementById('btn-mic');
    const videoMascote = document.getElementById('vid');
    const startScreen  = document.getElementById('start-screen');
    const uiLayer      = document.getElementById('ui-layer');

    let isProcessing   = false;
    let audioAtual     = null;
    let _ttsLocked     = false;
    let globalAudioCtx = null;

    // ============================================================
    // DESTRANCADOR DE ÁUDIO (obrigatório iOS/Android)
    // ============================================================
    function unlockAudio() {
        if (!globalAudioCtx) globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (globalAudioCtx.state === 'suspended') globalAudioCtx.resume();
        const buf = globalAudioCtx.createBuffer(1, 1, 22050);
        const src = globalAudioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(globalAudioCtx.destination);
        src.start(0);
    }

    document.getElementById('btn-start').addEventListener('click', () => {
        unlockAudio();
        startScreen.classList.add('hidden');
        uiLayer.classList.remove('hidden');
        if (videoMascote) videoMascote.play().catch(e => console.log('[JARVIS][Video] Auto-play bloqueado:', e.message));
        if (chatDisplay.children.length === 0) {
            const msgInicial = 'Olá! Sou o arquiteto inteligente da thIAguinho Soluções! Como posso te chamar? E você busca uma solução para sua Empresa ou para sua Vida Pessoal? [OPCOES: Para minha Empresa | Para minha Vida Pessoal]';
            processarEExibirMensagemBot(msgInicial);
        }
    });

    // ============================================================
    // SÍNTESE DE VOZ — gemini-2.5-flash-preview-tts + fallback
    // ============================================================
    async function falar(texto) {
        if (_ttsLocked) { console.warn('[JARVIS][TTS] Bloqueado — sintese em andamento.'); return; }
        _ttsLocked = true;
        try {
            if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();
            if (globalAudioCtx && audioAtual) { try { audioAtual.stop(); } catch (e) {} audioAtual = null; }

            let textoVoz = texto.replace(/\[OPCOES:.*?\]/i, '').replace(/\*\*/g, '').trim();
            if (!textoVoz) return;
            textoVoz = textoVoz.replace(/\d{5,}/g, m => m.split('').join(' '));

            let apiKey = null; let voiceName = 'Aoede';
            try {
                const sk = await get(ref(database, 'admin_config/gemini_api_key'));
                const sv = await get(ref(database, 'admin_config/gemini_voice_name'));
                if (sk.exists()) apiKey    = sk.val();
                if (sv.exists()) voiceName = sv.val();
            } catch (e) { console.warn('[JARVIS][TTS] Falha Firebase, plano B local.', e.message); }

            if (apiKey) {
                try {
                    // CORRECAO: gemini-2.5-flash-preview-tts e o modelo correto para audio REST API
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
                    const payload = { contents: [{ role: 'user', parts: [{ text: textoVoz }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } } };
                    const controller = new AbortController();
                    const tid = setTimeout(() => controller.abort(), 12000);
                    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
                    clearTimeout(tid);
                    const data = await res.json();
                    if (!res.ok || data.error) throw new Error(`${data.error?.code || res.status}: ${data.error?.message || 'Erro TTS'}`);
                    const b64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                    if (!b64) throw new Error('Sem audio na resposta.');
                    const bs = window.atob(b64); const buf = new ArrayBuffer(bs.length); const v = new Uint8Array(buf);
                    for (let i = 0; i < bs.length; i++) v[i] = bs.charCodeAt(i);
                    const i16 = new Int16Array(buf); const ab = globalAudioCtx.createBuffer(1, i16.length, 24000); const ch = ab.getChannelData(0);
                    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768.0;
                    audioAtual = globalAudioCtx.createBufferSource();
                    audioAtual.buffer = ab; audioAtual.connect(globalAudioCtx.destination);
                    audioAtual.onended = () => { audioAtual = null; };
                    audioAtual.start();
                    console.log('[JARVIS][TTS] Audio Gemini TTS reproduzindo.');
                    return;
                } catch (e) { console.warn('[JARVIS][TTS] Gemini TTS falhou, plano B local:', e.message); }
            }

            // PLANO B: SpeechSynthesis do navegador
            const u = new SpeechSynthesisUtterance(textoVoz);
            u.lang = 'pt-BR';
            window.speechSynthesis.speak(u);
        } finally { _ttsLocked = false; }
    }

    // ============================================================
    // RECONHECIMENTO DE VOZ
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
            console.warn('[JARVIS][Mic] Erro:', e.error);
            btnMic.classList.remove('listening');
            userInput.placeholder = 'Digite ou escolha uma opção...';
        };
    } else {
        btnMic.style.display = 'none';
    }

    // ============================================================
    // RENDERIZAÇÃO DE MENSAGENS
    // ============================================================
    function addMsgVisual(sender, text) {
        const div     = document.createElement('div');
        div.className = `msg ${sender}`;
        div.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        chatDisplay.appendChild(div);
        chatDisplay.scrollTop = chatDisplay.scrollHeight;
    }

    function processarEExibirMensagemBot(respostaCompleta) {
        const regexOpcoes = /\[OPCOES:\s*(.*?)\]/i;
        const match       = respostaCompleta.match(regexOpcoes);
        const textoLimpo  = respostaCompleta.replace(regexOpcoes, '').trim();
        addMsgVisual('bot', textoLimpo);
        adicionarAoHistorico('bot', respostaCompleta);
        falar(textoLimpo);
        if (match && match[1]) renderizarBotoesDeOpcao(match[1].split('|').map(o => o.trim()));
    }

    function renderizarBotoesDeOpcao(arrayOpcoes) {
        const antigos = document.getElementById('opcoes-ativas');
        if (antigos) antigos.remove();
        const container     = document.createElement('div');
        container.className = 'opcoes-container';
        container.id        = 'opcoes-ativas';
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
        const antigos = document.getElementById('opcoes-ativas');
        if (antigos) antigos.remove();
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
        const antigos = document.getElementById('opcoes-ativas');
        if (antigos) antigos.remove();
        addMsgVisual('user', msg);
        adicionarAoHistorico('user', msg);
        await invocarGemini(msg);
    }

    // ============================================================
    // INVOCAÇÃO GEMINI (try/catch garante reset do lock)
    // ============================================================
    async function invocarGemini(textoUser) {
        btnSend.style.opacity       = '0.5';
        btnSend.style.pointerEvents = 'none';
        userInput.disabled          = true;
        const ind     = document.createElement('div');
        ind.className = 'text-xs text-slate-400 mt-1 mb-3 text-center font-bold';
        ind.id        = 'digitando';
        ind.innerHTML = "<i class='bx bx-loader-alt bx-spin'></i> Construindo a arquitetura técnica...";
        chatDisplay.appendChild(ind);
        chatDisplay.scrollTop = chatDisplay.scrollHeight;
        try {
            const resp = await askGemini(textoUser);
            document.getElementById('digitando')?.remove();
            processarEExibirMensagemBot(resp);
        } catch (e) {
            console.error('[JARVIS][invocarGemini] Erro inesperado:', e.message);
            document.getElementById('digitando')?.remove();
            processarEExibirMensagemBot('Houve uma falha na conexão. Pode repetir a informação?');
        } finally {
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
    userInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') enviarMensagemDigitada(); });
});
