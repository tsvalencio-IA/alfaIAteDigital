import { initAuth, onAuthStateChanged, auth } from './firebase-config.js';
import { initChatEvents, appendMessage } from './ar-experience.js';
import { initAdminControls, iniciarEscutaCRM, carregarCerebroIA, setCurrentUser, unsubLeads } from './admin.js';
import { chatHistory } from './gemini-api.js';

const viewHome = document.getElementById('view-home');
const viewAr = document.getElementById('view-ar');
const viewAdmin = document.getElementById('view-admin');
const viewAdminLogin = document.getElementById('admin-login');
const viewAdminDashboard = document.getElementById('admin-dashboard');

function switchView(view) {
    viewHome.classList.add('hidden-module');
    viewAr.classList.add('hidden-module');
    viewAdmin.classList.add('hidden-module');
    view.classList.remove('hidden-module');
}

// Interações de Navegação
document.getElementById('btn-go-ar').addEventListener('click', () => {
    switchView(viewAr);
    if (chatHistory.length === 0) {
        appendMessage('bot', "Olá! Sou o mascote da **thIAguinho Soluções Digitais**. Estou me materializando por aqui! Como é o seu nome e qual o ramo da sua empresa?");
        chatHistory.push({ role: 'bot', text: "Olá! Sou o mascote da thIAguinho Soluções Digitais. Estou me materializando por aqui! Como é o seu nome e qual o ramo da sua empresa?" });
    }
});

document.getElementById('btn-close-ar').addEventListener('click', () => switchView(viewHome));

document.getElementById('btn-go-admin').addEventListener('click', () => {
    switchView(viewAdmin);
    viewAdminLogin.classList.remove('hidden-module');
    viewAdminDashboard.classList.add('hidden-module');
});

document.getElementById('btn-back-home-admin').addEventListener('click', () => switchView(viewHome));

// Sistema de Login da Equipe
document.getElementById('btn-login').addEventListener('click', () => {
    const pwd = document.getElementById('admin-pwd').value;
    if (pwd === 'admin123') { // Senha Padrão
        document.getElementById('admin-pwd').value = '';
        viewAdminLogin.classList.add('hidden-module');
        viewAdminDashboard.classList.remove('hidden-module');
        if (auth.currentUser) {
            carregarCerebroIA();
            iniciarEscutaCRM();
        }
    } else {
        const input = document.getElementById('admin-pwd');
        input.classList.add('border-red-500');
        input.value = '';
        input.placeholder = 'Senha Incorreta!';
        setTimeout(() => { input.classList.remove('border-red-500'); input.placeholder = 'Senha de Acesso'; }, 2000);
    }
});

document.getElementById('btn-logout').addEventListener('click', () => {
    viewAdminDashboard.classList.add('hidden-module');
    viewAdminLogin.classList.remove('hidden-module');
    switchView(viewHome);
});

// Iniciação do Sistema
document.addEventListener('DOMContentLoaded', () => {
    initChatEvents();
    initAdminControls();
    initAuth(); // Inicializa Firebase Auth

    onAuthStateChanged(auth, (user) => {
        if (user) {
            setCurrentUser(user);
            console.log("Firebase conectado com sucesso!");
        } else {
            setCurrentUser(null);
            if (unsubLeads) unsubLeads(); // Desliga a escuta de Leads se deslogar
        }
    });
});
