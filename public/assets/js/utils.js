/* ═══ FoodChooseApp — Shared Utilities ═══ */
// Ce fichier centralise toutes les fonctions réutilisables de l'app,
// pour éviter de dupliquer la logique dans chaque page.

// ─── Formatage monétaire ──────────────────────────────────────────
// Le FCFA est une monnaie entière : pas de centimes.
// fmtCFA() arrondit toujours à l'entier le plus proche avant d'afficher.
function fmtCFA(v) {
  return Math.round(parseFloat(v) || 0)
    .toLocaleString('fr-FR', { maximumFractionDigits: 0 })
    .replace(/ /g, ' ');
}

// L'API est sur le même domaine, donc une chaîne vide suffit comme base URL.
// Si un jour on déplace l'API ailleurs, on n'a qu'un seul endroit à modifier.
const API = '';

// ─── Auth helpers ─────────────────────────────────────
// On a plusieurs types d'utilisateurs (admin, resto, co-admin, client), chacun avec son propre token.
// Cette fonction essaie chacun dans l'ordre et renvoie le premier trouvé — pratique pour les appels génériques.
function getToken() { return localStorage.getItem('fc_token') || localStorage.getItem('fc_admin_token') || localStorage.getItem('fc_co_token'); }

// Construit les headers HTTP qu'on envoie à chaque requête.
// On accepte un token en paramètre pour les cas où on veut forcer un compte précis,
// sinon on récupère automatiquement celui qui est connecté.
function hdrs(tok) { return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok || getToken()}` }; }

// Wrapper autour de fetch() qui gère le token, la sérialisation du body et les erreurs proprement.
// Centraliser ça évite de répéter les mêmes try/catch et JSON.stringify() partout dans le code.
async function apiFetch(url, opts = {}, tok = null) {
  const res = await fetch(API + url, {
    headers: hdrs(tok),
    ...opts,
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Session expirée ou token invalide → nettoyer et rediriger vers login
    const role = localStorage.getItem('fc_role');
    localStorage.clear();
    const loginMap = { restaurant: '/restaurant/login', company: '/company/login', employee: '/employee/login', admin: '/admin/login' };
    toast('Session expirée. Reconnectez-vous.', 'error');
    setTimeout(() => { window.location.href = loginMap[role] || '/'; }, 1500);
    throw new Error('Session expirée');
  }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

// ─── Toast ────────────────────────────────────────────
// Affiche une notification temporaire en bas de l'écran.
// On crée le conteneur à la volée s'il n'existe pas encore dans le DOM,
// pour ne pas avoir à l'ajouter manuellement dans chaque page HTML.
function toast(msg, type = 'info') {
  let c = document.getElementById('toastContainer');
  if (!c) { c = document.createElement('div'); c.id = 'toastContainer'; document.body.appendChild(c); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  // Les icônes visuelles rendent le type de message immédiatement lisible, sans avoir à lire le texte
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  t.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3500);
}

// ─── Notification sound ───────────────────────────────
// AudioContext unique et global, créé au premier geste utilisateur
// pour respecter la politique autoplay de Chrome.
let audioCtx = null;
function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
// On init dès le premier clic/touch pour débloquer l'audio
document.addEventListener('click', ensureAudioCtx, { once: true });
document.addEventListener('touchstart', ensureAudioCtx, { once: true });

function playSound(type = 'notif') {
  try {
    if (!audioCtx || audioCtx.state === 'suspended') return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    if (type === 'message') {
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.setValueAtTime(660, audioCtx.currentTime + 0.08);
    } else {
      osc.frequency.setValueAtTime(700, audioCtx.currentTime);
      osc.frequency.setValueAtTime(900, audioCtx.currentTime + 0.1);
      osc.frequency.setValueAtTime(700, audioCtx.currentTime + 0.2);
    }
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.4);
  } catch(e) {}
}

// ─── Notifications polling ────────────────────────────
// On garde en mémoire le nombre de notifs non lues de la dernière vérification,
// pour savoir s'il faut jouer un son quand de nouvelles arrivent.
let lastNotifCount = 0;
// Référence à l'intervalle de polling, utile si on voulait l'annuler plus tard (déconnexion par exemple)
let notifPollInterval = null;

// Démarre le système de notifications : charge une première fois immédiatement,
// puis toutes les 6 secondes pour rester à jour sans surcharger le serveur.
function initNotifications(targetType, targetId) {
  if (!targetType) targetType = localStorage.getItem('fc_role');
  if (!targetId) targetId = localStorage.getItem('fc_id');
  loadNotifications();
  notifPollInterval = setInterval(loadNotifications, 6000);
}

// Récupère les notifications depuis l'API et met à jour le badge + dropdown.
// Si ça échoue (réseau coupé par exemple), on absorbe l'erreur silencieusement
// pour ne pas spammer de messages d'erreur à l'utilisateur.
async function loadNotifications() {
  try {
    const items = await apiFetch('/api/notifications');
    // On ne compte que les non lues pour le badge — les lues sont affichées mais sans urgence
    const unread = items.filter(n => !n.read).length;
    const badge = document.getElementById('notifCount');
    if (badge) {
      if (unread > 0 && unread !== lastNotifCount) {
        badge.classList.remove('pop');
        void badge.offsetWidth;
        badge.classList.add('pop');
      }
      badge.textContent = unread;
      badge.style.display = unread > 0 ? 'flex' : 'none';
    }
    if (unread > lastNotifCount && lastNotifCount >= 0) playSound('notif');
    lastNotifCount = unread;
    renderNotifDropdown(items);
  } catch(e) {}
}

// Construit le HTML de la liste déroulante des notifications.
// On limite à 15 items pour ne pas rendre la liste interminable à scroller.
function renderNotifDropdown(items) {
  const dd = document.getElementById('notifDropdown');
  if (!dd) return;
  // Message vide sympa si aucune notification — mieux qu'un dropdown vide qui désoriente
  if (!items.length) { dd.innerHTML = '<div class="empty-state" style="padding:20px"><span class="icon">🔔</span>Aucune notification</div>'; return; }
  dd.innerHTML = items.slice(0,15).map(n => `
    <div class="notif-item ${n.read?'':'unread'}" onclick="markNotifRead(${n.id}, this)">
      <div class="notif-title">${n.title||''}</div>
      <div class="notif-msg">${n.message||''}</div>
      <div class="notif-time">${timeAgo(n.created_at)}</div>
    </div>
  `).join('');
}

// Marque une notification comme lue côté serveur puis retire visuellement le style "non lue".
// On recharge aussi les notifs pour mettre à jour le badge immédiatement.
async function markNotifRead(id, el) {
  await apiFetch(`/api/notifications/${id}/read`, { method: 'PUT' });
  el.classList.remove('unread');
  loadNotifications();
}

// Ouvre ou ferme le panneau de notifications — simple toggle de classe CSS.
function toggleNotifDropdown() {
  const dd = document.getElementById('notifDropdown');
  if (dd) dd.classList.toggle('open');
}

// ─── Sidebar (mobile) ─────────────────────────────────
// Sur mobile, la sidebar est cachée par défaut et s'ouvre via le burger.
// L'overlay sombre derrière permet de la fermer en cliquant à côté — comportement attendu par les utilisateurs.
function initSidebar() {
  const hamburger = document.getElementById('hamburger');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay?.classList.toggle('open'); // L'overlay est optionnel, d'où le ?. pour éviter une erreur si absent
    });
    // Clic sur le fond sombre = fermeture de la sidebar, c'est intuitif et attendu sur mobile
    overlay?.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('open');
    });
  }
}

// ─── Navigation ───────────────────────────────────────
function initNav(defaultPage, onSwitch) {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', () => {
      const page = item.dataset.page;
      const currentPg = document.querySelector('.page.active:not(.leaving)');
      const nextPg    = document.getElementById(`page-${page}`);
      const doSwitch = () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active', 'leaving'));
        item.classList.add('active');
        if (nextPg) nextPg.classList.add('active');
        const tb = document.getElementById('pageTitle');
        if (tb) tb.textContent = item.querySelector('span:not(.icon):not(.nav-badge)')?.textContent.trim() || item.textContent.trim();
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebarOverlay')?.classList.remove('open');
        window.scrollTo({ top: 0, behavior: 'instant' });
        document.querySelector('.topbar')?.classList.remove('topbar-hidden');
        setTimeout(initScrollReveal, 40);
        if (onSwitch) onSwitch(page);
      };
      if (currentPg && nextPg && currentPg !== nextPg) {
        currentPg.classList.add('leaving');
        setTimeout(doSwitch, 170);
      } else {
        doSwitch();
      }
    });
  });
}

// ─── Date helpers ─────────────────────────────────────
// Retourne la date du jour au format YYYY-MM-DD, utile pour pré-remplir des champs de formulaire ou filtrer des données.
function todayStr() { return new Date().toISOString().split('T')[0]; }

// Formate une date pour l'affichage à l'utilisateur français (JJ/MM/AAAA).
// On force l'heure à midi pour éviter les décalages de fuseau horaire qui peuvent
// faire glisser une date d'un jour quand on parse une date sans heure (ex: "2024-01-15" → UTC minuit → la veille en local).
function formatDate(d) {
  if (!d) return '—'; // Le tiret long signale visuellement une valeur absente, plus élégant que "null" ou vide
  // Normalize PostgreSQL "YYYY-MM-DD HH:MM:SS" (space separator) to ISO "YYYY-MM-DDTHH:MM:SS"
  const s = typeof d === 'string' ? d.trim().replace(' ', 'T') : d;
  return new Date(s.includes('T') ? s : s + 'T12:00:00').toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
}

// Version avec l'heure en plus, pour les événements où la précision à la minute compte (commandes, messages).
function formatDateTime(d) {
  if (!d) return '—';
  const s = typeof d === 'string' ? d.trim().replace(' ', 'T') : d;
  return new Date(s).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}

// Affiche une durée relative humaine ("il y a 5 min") plutôt qu'une date brute.
// C'est bien plus lisible pour les notifications ou les messages récents.
// Au-delà d'un jour, on bascule sur la date exacte car "il y a 47h" devient difficile à situer.
function timeAgo(d) {
  const s = d && typeof d === 'string' ? d.trim().replace(' ', 'T') : d;
  const diff = Date.now() - new Date(s).getTime();
  const m = Math.floor(diff/60000);
  if (m < 1) return 'À l\'instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m/60);
  if (h < 24) return `il y a ${h}h`;
  return formatDate(d); // Pour les vieilles notifs, la date précise est plus utile que "il y a 3 jours"
}

// ─── Photo upload to base64 ───────────────────────────
// Lit un fichier et le convertit en base64 data URL.
// C'est nécessaire quand on veut envoyer une image via JSON dans une requête API,
// car JSON ne peut pas transporter des données binaires brutes.
function readFileAsBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result); // e.target.result contient le data URL complet (avec le préfixe "data:image/...")
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// ─── Image compression (Canvas) ───────────────────────
// Réduit la taille des images avant de les envoyer au serveur.
// Sans ça, un utilisateur qui prend une photo avec son téléphone pourrait envoyer un fichier de 5+ Mo
// pour chaque plat, ce qui ralentirait tout le monde et remplirait rapidement le stockage.
function compressImage(file, maxPx = 1024, quality = 0.82) {
  return new Promise(resolve => {
    const canvas = document.createElement('canvas');
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      // On redimensionne seulement si l'image dépasse la taille max, en préservant les proportions
      if (w > maxPx || h > maxPx) {
        // On calcule selon le côté le plus long pour que l'image reste dans le cadre maxPx×maxPx
        if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
        else { w = Math.round(w * maxPx / h); h = maxPx; }
      }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      // On exporte en JPEG avec la qualité choisie — 0.82 est un bon équilibre entre poids et rendu visuel
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    // Si le canvas échoue (format non supporté, etc.), on envoie quand même l'image originale en base64
    img.onerror = () => readFileAsBase64(file).then(resolve);
    // createObjectURL est plus performant que readAsDataURL pour charger dans un <img>,
    // car il ne charge pas tout le fichier en mémoire sous forme de string
    img.src = URL.createObjectURL(file);
  });
}

// ─── Video duration check ─────────────────────────────
// Vérifie la durée d'une vidéo avant de l'uploader.
// On crée un élément <video> invisible juste pour lire les métadonnées,
// sans avoir à envoyer le fichier au serveur d'abord.
function checkVideoDuration(file) {
  return new Promise(resolve => {
    const vid = document.createElement('video');
    vid.preload = 'metadata'; // On ne charge que les métadonnées, pas toute la vidéo — bien plus rapide
    vid.onloadedmetadata = () => { URL.revokeObjectURL(vid.src); resolve(vid.duration); }; // On libère l'URL objet après usage pour éviter les fuites mémoire
    vid.onerror = () => resolve(0); // En cas d'erreur, on retourne 0 et laisse l'appelant décider quoi faire
    vid.src = URL.createObjectURL(file);
  });
}

// ─── Scroll to top ────────────────────────────────────
// IIFE (fonction immédiatement exécutée) pour créer le bouton "remonter en haut"
// sans polluer le scope global avec des variables intermédiaires.
(function() {
  const btn = document.createElement('button');
  btn.id = 'scrollTopBtn';
  btn.title = 'Remonter';
  btn.innerHTML = '↑';
  document.body.appendChild(btn);
  // Le bouton n'apparaît qu'après 300px de défilement — inutile de l'afficher en haut de page
  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 300);
  }, { passive: true }); // passive: true améliore les performances de scroll sur mobile
  // Remontée fluide plutôt qu'instantanée pour une meilleure expérience utilisateur
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
})();

// ─── Password visibility toggle ───────────────────────
// Permet de basculer les champs mot de passe entre masqué et visible.
// L'attribut data-pw-init évite de brancher l'événement deux fois si la fonction est appelée plusieurs fois.
function initPasswordToggles() {
  document.querySelectorAll('.pw-toggle:not([data-pw-init])').forEach(btn => {
    btn.setAttribute('data-pw-init', '1'); // On marque le bouton comme initialisé pour éviter les doublons d'écouteurs
    btn.addEventListener('click', () => {
      // On cherche d'abord l'élément précédent, sinon on fouille dans le wrapper .pw-wrap — flexible selon la structure HTML
      const input = btn.previousElementSibling || btn.closest('.pw-wrap').querySelector('input');
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
        // L'icône change pour refléter l'état courant : œil ouvert = mot de passe visible
        btn.textContent = input.type === 'password' ? '👁' : '🙈';
      }
    });
  });
}

// ─── Specialties list ─────────────────────────────────
// Liste fixe des spécialités culinaires proposées dans l'app.
// Centralisée ici pour que partout dans l'app (création de resto, filtres, etc.) on utilise exactement les mêmes valeurs.
const SPECIALTIES = [
  'Cuisine Burkinabè', 'Cuisine Ivoirienne', 'Cuisine Togolaise', 'Cuisine Sénégalaise',
  'Cuisine Béninoise', 'Cuisine Nigériane', 'Cuisine Marocaine', 'Cuisine Européenne',
  'Cuisine Asiatique', 'Cuisine Américaine', 'Fast-food', 'Boissons', 'Snack', 'Pizzeria', 'Grillade', 'Végétarien'
];

// Liste des spécialités ajoutées par l'utilisateur (non dans la liste par défaut)
let customSpecialties = [];

// Génère les checkboxes de spécialités dans un conteneur donné.
// On pré-coche les spécialités déjà sélectionnées pour l'édition d'un restaurant existant.
// Ajoute une option "Autre" pour permettre d'ajouter des spécialités personnalisées.
function renderSpecialties(containerId, selectedList = []) {
  const el = document.getElementById(containerId);
  if (!el) return;
  
  // Merge selectedList with custom specialties (in case custom ones were added)
  const allSelected = [...selectedList];
  customSpecialties.forEach(cs => { if (!allSelected.includes(cs)) allSelected.push(cs); });
  
  // Find any custom specialties that are selected but not in SPECIALTIES
  const customSelected = allSelected.filter(s => !SPECIALTIES.includes(s));
  const customSelectedHtml = customSelected.length > 0 
    ? customSelected.map(s => `
        <label style="display:inline-flex;align-items:center;gap:6px;background:var(--orange);border:1.5px solid var(--orange);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12.5px;margin:3px;color:white">
          <input type="checkbox" name="specialty" value="${s}" checked style="width:14px;height:14px;accent-color:white">
          ${s}
        </label>
      `).join('')
    : '';
  
  el.innerHTML = SPECIALTIES.map(s => `
    <label style="display:inline-flex;align-items:center;gap:6px;background:white;border:1.5px solid ${allSelected.includes(s)?'var(--orange)':'var(--border)'};border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12.5px;margin:3px;transition:all .2s">
      <input type="checkbox" name="specialty" value="${s}" ${allSelected.includes(s)?'checked':''} style="width:14px;height:14px;accent-color:var(--orange)">
      ${s}
    </label>
  `).join('') + customSelectedHtml + `
    <label style="display:inline-flex;align-items:center;gap:6px;background:white;border:1.5px dashed var(--border);border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12.5px;margin:3px" id="customSpecialtyLabel">
      <span style="color:var(--muted)">+ Autre</span>
    </label>
    <input type="text" id="customSpecialtyInput" placeholder="Nouvelle spécialité..." style="display:none;width:150px;padding:6px;border:1px solid var(--border);border-radius:8px;font-size:12px;margin:3px" onkeypress="if(event.key==='Enter'){addCustomSpecialty();event.preventDefault()}">
    <button type="button" id="addCustomSpecialtyBtn" style="display:none;padding:6px 10px;background:var(--orange);color:white;border:none;border-radius:6px;cursor:pointer;font-size:11px;margin:3px" onclick="addCustomSpecialty()">Ajouter</button>
  `;
  
  // Toggle custom input visibility
  const label = document.getElementById('customSpecialtyLabel');
  const input = document.getElementById('customSpecialtyInput');
  const btn = document.getElementById('addCustomSpecialtyBtn');
  if (label && input) {
    label.onclick = () => {
      input.style.display = 'inline-block';
      btn.style.display = 'inline-block';
      label.style.display = 'none';
      input.focus();
    };
  }
}

// Ajoute une spécialité personnalisée
function addCustomSpecialty() {
  const input = document.getElementById('customSpecialtyInput');
  const btn = document.getElementById('addCustomSpecialtyBtn');
  const label = document.getElementById('customSpecialtyLabel');
  if (!input) return;

  const value = input.value.trim();
  if (value && !customSpecialties.includes(value) && !SPECIALTIES.includes(value)) {
    // Capturer les sélections actuelles avant de re-rendre
    const currentSelected = [...document.querySelectorAll('input[name="specialty"]:checked')].map(i => i.value);
    customSpecialties.push(value);
    // Trouver l'ID du conteneur parent
    const containerId = document.querySelector('input[name="specialty"]')?.closest('[id]')?.id || 'profileSpecialties';
    renderSpecialties(containerId, currentSelected);
  }

  input.value = '';
  if (input) input.style.display = 'none';
  if (btn) btn.style.display = 'none';
  if (label) label.style.display = 'inline-flex';
}

// Récupère les spécialités cochées depuis le DOM sous forme de tableau de strings.
// Pratique pour sérialiser facilement vers l'API.
function getSelectedSpecialties(containerId) {
  return [...document.querySelectorAll(`#${containerId} input[name="specialty"]:checked`)].map(i => i.value);
}

// ─── Payment types ────────────────────────────────────
// Modes de paiement mobile money courants en Afrique de l'Ouest.
// Ils sont listés ici pour être cohérents entre la création et l'édition de compte resto.
const PAYMENT_TYPES = ['OrangeMoney', 'MoovMoney', 'Telecel Money', 'Compte Bancaire'];

// Génère les champs de saisie pour les modes de paiement.
// Chaque mode a une checkbox (actif/inactif) + un champ pour le numéro de compte.
// On prépare aussi une section "Autre" pour les modes non listés, afin de ne pas bloquer les cas rares.
function renderPaymentFields(containerId, existing = []) {
  const el = document.getElementById(containerId);
  if (!el) return;
  // On transforme le tableau [{type, account}] en dictionnaire pour un accès rapide par type
  const existingMap = {};
  existing.forEach(p => { existingMap[p.type] = p.account; });
  el.innerHTML = PAYMENT_TYPES.map(type => `
    <div style="display:grid;grid-template-columns:150px 1fr;gap:8px;align-items:center;margin-bottom:8px">
      <label style="display:flex;align-items:center;gap:7px;font-size:13px;font-weight:500;color:var(--text)">
        <input type="checkbox" name="paytype" value="${type}" ${existingMap[type]?'checked':''} style="accent-color:var(--orange);width:14px;height:14px">
        ${type}
      </label>
      <input type="text" name="payaccount_${type}" class="form-control" placeholder="N° compte / code" value="${existingMap[type]||''}" style="font-size:12.5px">
    </div>
  `).join('') + `
    <div style="margin-top:8px">
      <label style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:block;margin-bottom:6px">Autre mode de paiement</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <input type="text" id="customPayType" class="form-control" placeholder="Nom du mode" style="font-size:12.5px">
        <input type="text" id="customPayAccount" class="form-control" placeholder="N° / code" style="font-size:12.5px">
      </div>
    </div>
  `;
}

// Collecte les modes de paiement sélectionnés depuis le formulaire.
// On ignore les types décochés — seuls les modes activés sont envoyés à l'API.
// Le mode personnalisé n'est inclus que si un nom a été saisi.
function getPaymentTypes(containerId) {
  const result = [];
  PAYMENT_TYPES.forEach(type => {
    const cb = document.querySelector(`#${containerId} input[value="${type}"]`);
    if (cb && cb.checked) {
      const acc = document.querySelector(`#${containerId} input[name="payaccount_${type}"]`);
      result.push({ type, account: acc?.value || '' });
    }
  });
  // On récupère le mode personnalisé s'il existe — pas obligatoire d'avoir un numéro de compte
  const customType = document.getElementById('customPayType')?.value.trim();
  const customAcc = document.getElementById('customPayAccount')?.value.trim();
  if (customType) result.push({ type: customType, account: customAcc || '' });
  return result;
}

// ─── Category colors ──────────────────────────────────
// Couleurs et icônes associées aux catégories de produits.
// Les avoir en un seul endroit garantit une cohérence visuelle dans tout le site,
// et facilite l'ajout d'une nouvelle catégorie sans chercher dans tous les fichiers.
const CAT_COLORS = { plat:'#E85A2A', boisson:'#3B82F6', snack:'#F59E0B', dessert:'#8B5CF6', petit_déjeuner:'#10B981' };
const CAT_ICONS = { plat:'🍜', boisson:'🥤', snack:'🥨', dessert:'🍰', petit_déjeuner:'🥐', default:'🍽' };

// ─── Stars render ─────────────────────────────────────
// Génère une représentation visuelle d'une note avec des étoiles.
// Simple mais efficace : l'utilisateur comprend instantanément sans avoir besoin d'un chiffre.
function renderStars(score, max = 5) {
  return '⭐'.repeat(score) + '☆'.repeat(max - score); // Étoiles pleines pour la note, vides pour le reste
}

  // ─── Button ripple effect ────────────────────────────
function initRipple() {
  document.querySelectorAll('.btn-primary:not([data-ripple])').forEach(btn => {
    btn.setAttribute('data-ripple', '1');
    btn.addEventListener('click', function(e) {
      const rect = this.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const ripple = document.createElement('span');
      ripple.className = 'ripple';
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
      ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
      this.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
  });
}

// ─── Shake helper ────────────────────────────────────
function shakeEl(el) { el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 400); }

// ─── Button loading state ────────────────────────────
function setLoading(btn, label) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + label; }
function unsetLoading(btn, label) { btn.disabled = false; btn.innerHTML = label; }

// ─── Drink labels ─────────────────────────────────────
// Correspondance entre les codes stockés en base et les labels affichés à l'utilisateur.
// Évite de stocker des labels en clair en base et permet de les changer facilement.
const DRINK_LABELS = { lipton:'🍵 Lipton', cafeine:'☕ Caféine', both:'🍵☕ Les deux' };

// Ferme tous les dropdowns de notifications quand l'utilisateur clique ailleurs sur la page.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.notif-btn') && !e.target.closest('.notif-dropdown')) {
    document.querySelectorAll('.notif-dropdown').forEach(d => d.classList.remove('open'));
  }
});

// ══════════════════════════════════════════════════════
// ANIMATION UTILITIES
// ══════════════════════════════════════════════════════

// ─── Page load progress bar ──────────────────────────
// Crée et anime une barre de progression en haut de page dès que utils.js est chargé.
function initPageLoadBar() {
  if (document.getElementById('pageLoadBar')) return;
  const bar = document.createElement('div');
  bar.id = 'pageLoadBar';
  bar.style.cssText = 'width:0%;opacity:1';
  document.body.prepend(bar);
  let p = 0;
  const t = setInterval(() => { p = Math.min(p + Math.random() * 15 + 5, 88); bar.style.width = p + '%'; }, 160);
  const done = () => {
    clearInterval(t);
    bar.style.width = '100%';
    setTimeout(() => { bar.style.opacity = '0'; setTimeout(() => bar.remove(), 400); }, 200);
  };
  if (document.readyState === 'complete') done();
  else window.addEventListener('load', done, { once: true });
}

// ─── Number counter — désactivé
function countUp(el, end, onDone) {
  if (el) el.textContent = fmtCFA(end);
  if (onDone) onDone();
}
function initStatCounters() {}
// ─── Scroll reveal — désactivé (animations supprimées) ─
function initScrollReveal() {
  document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale')
    .forEach(el => el.classList.add('visible'));
}

// ─── Floating particles canvas ────────────────────────
// Génère de petites particules flottantes sur un <canvas id="particlesCanvas">.
function initParticles() {
  const canvas = document.getElementById('particlesCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  window.addEventListener('resize', resize); resize();
  const pts = Array.from({ length: 45 }, () => ({
    x: Math.random() * canvas.width, y: Math.random() * canvas.height,
    r: Math.random() * 1.8 + 0.4,
    vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
    o: Math.random() * 0.35 + 0.08
  }));
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pts.forEach(p => {
      p.x = (p.x + p.vx + canvas.width)  % canvas.width;
      p.y = (p.y + p.vy + canvas.height) % canvas.height;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(232,90,42,${p.o})`; ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
}

// ─── Mouse parallax — désactivé ──────────────────────
function initParallaxOrbs() {}

// ─── Scroll progress bar ─────────────────────────────
function initScrollProgress() {
  if (document.getElementById('scrollProgressBar')) return;
  const bar = document.createElement('div');
  bar.id = 'scrollProgressBar';
  document.body.appendChild(bar);
  const update = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 1 ? Math.min((window.scrollY / max) * 100, 100) : 0;
    bar.style.width = pct + '%';
    bar.style.opacity = pct > 0.5 ? '1' : '0';
  };
  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update, { passive: true });
}

// ─── Topbar compact + hide-on-scroll ─────────────────
function initTopbarScroll() {
  const tb = document.querySelector('.topbar');
  if (!tb) return;
  let lastY = 0;
  window.addEventListener('scroll', () => {
    const y = window.scrollY;
    tb.classList.toggle('topbar-scrolled', y > 8);
    if (y > 140) {
      if (y > lastY + 5) tb.classList.add('topbar-hidden');
      else if (y < lastY - 5) tb.classList.remove('topbar-hidden');
    } else {
      tb.classList.remove('topbar-hidden');
    }
    lastY = y;
  }, { passive: true });
}

// ─── 3D card tilt — désactivé ────────────────────────
function initCardTilt() {}

// ─── Magnetic buttons — désactivé ────────────────────
function initMagneticButtons() {}

// ─── Animated modal close ─────────────────────────────
function closeModal(overlay) {
  if (!overlay) return;
  const modal = overlay.querySelector('.modal');
  if (modal) modal.classList.add('closing');
  overlay.classList.add('closing');
  setTimeout(() => {
    overlay.classList.remove('open', 'closing');
    if (modal) modal.classList.remove('closing');
  }, 280);
}

// ─── PWA Install Prompt ───────────────────────────────────
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  showInstallBanner();
});

window.addEventListener('appinstalled', () => {
  hideInstallBanner();
  _deferredInstallPrompt = null;
  toast('FoodChooseApp installée avec succès !', 'success');
});

function showInstallBanner() {
  if (document.getElementById('pwaInstallBanner')) return;
  if (window.matchMedia('(display-mode: standalone)').matches) return;

  const banner = document.createElement('div');
  banner.id = 'pwaInstallBanner';
  banner.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
      <img src="/assets/images/icon-72.png" alt="" style="width:40px;height:40px;border-radius:10px;flex-shrink:0">
      <div style="min-width:0">
        <div style="font-weight:600;font-size:13.5px;color:#2C1810">Installer FoodChooseApp</div>
        <div style="font-size:11.5px;color:#8B6554;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Accès rapide depuis votre écran d'accueil</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button id="pwaInstallBtn" style="padding:8px 16px;background:linear-gradient(135deg,#E85A2A,#C94A1A);color:white;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Installer</button>
      <button id="pwaInstallClose" style="padding:8px 10px;background:transparent;border:1.5px solid #F0E6DE;border-radius:8px;color:#8B6554;cursor:pointer;font-size:18px;line-height:1;font-family:inherit">×</button>
    </div>`;
  banner.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;max-width:480px;margin:0 auto;background:#FFF8F3;border:1.5px solid #F0E6DE;border-radius:16px;padding:14px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(44,24,16,.18);z-index:9999;animation:pwaSlideUp .4s cubic-bezier(.16,1,.3,1) both';

  if (!document.getElementById('pwaInstallStyle')) {
    const s = document.createElement('style');
    s.id = 'pwaInstallStyle';
    s.textContent = '@keyframes pwaSlideUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}@keyframes pwaSlideDown{to{opacity:0;transform:translateY(24px)}}';
    document.head.appendChild(s);
  }

  document.body.appendChild(banner);

  document.getElementById('pwaInstallBtn').addEventListener('click', async () => {
    if (!_deferredInstallPrompt) return;
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') hideInstallBanner();
    _deferredInstallPrompt = null;
  });

  document.getElementById('pwaInstallClose').addEventListener('click', () => {
    hideInstallBanner();
    sessionStorage.setItem('pwaInstallDismissed', '1');
  });

  // Auto-hide after 12 seconds
  setTimeout(hideInstallBanner, 12000);
}

function hideInstallBanner() {
  const b = document.getElementById('pwaInstallBanner');
  if (!b) return;
  b.style.animation = 'pwaSlideDown .3s ease forwards';
  setTimeout(() => b.remove(), 320);
}

// ─── Service Worker registration with update detection ────
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner(reg);
        }
      });
    });
    // Attendre que le SW soit actif avant de s'abonner aux push
    const sw = reg.active || reg.installing || reg.waiting;
    if (sw && sw.state === 'activated') {
      subscribeToPush(reg);
    } else {
      navigator.serviceWorker.ready.then(r => subscribeToPush(r));
    }
  }).catch(() => {});
}

// Convertit une clé VAPID base64url en Uint8Array requis par l'API PushManager
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// Abonne l'utilisateur connecté aux notifications push Web et envoie l'abonnement au serveur.
// Ne fait rien si l'utilisateur n'est pas connecté, si le navigateur ne supporte pas PushManager,
// ou si la permission est refusée — aucune erreur visible pour l'utilisateur dans ces cas.
async function subscribeToPush(reg) {
  if (!('PushManager' in window)) return;
  if (!getToken()) return;
  try {
    const { key } = await apiFetch('/api/push/vapid-public-key');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key)
    });
    await apiFetch('/api/push/subscribe', { method: 'POST', body: { subscription } });
  } catch (e) {}
}

function showUpdateBanner(reg) {
  if (document.getElementById('pwaUpdateBanner')) return;
  const b = document.createElement('div');
  b.id = 'pwaUpdateBanner';
  b.innerHTML = `<span style="flex:1;font-size:13px;color:#2C1810">✨ Mise à jour disponible</span><button onclick="applyUpdate()" style="padding:7px 14px;background:linear-gradient(135deg,#E85A2A,#C94A1A);color:white;border:none;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit">Actualiser</button><button onclick="this.closest('#pwaUpdateBanner').remove()" style="padding:7px;background:transparent;border:none;color:#8B6554;cursor:pointer;font-size:18px;font-family:inherit">×</button>`;
  b.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);width:calc(100%-32px);max-width:420px;background:#FFF8F3;border:1.5px solid #F0E6DE;border-radius:12px;padding:12px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 28px rgba(44,24,16,.18);z-index:9999;animation:pwaSlideDown2 .4s cubic-bezier(.16,1,.3,1) both';
  const s2 = document.createElement('style');
  s2.textContent = '@keyframes pwaSlideDown2{from{opacity:0;transform:translateX(-50%) translateY(-16px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
  document.head.appendChild(s2);
  document.body.appendChild(b);
  window._pwaReg = reg;
}

window.applyUpdate = function() {
  if (window._pwaReg?.waiting) {
    window._pwaReg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
  window.location.reload();
};

// ─── Online/Offline indicator ─────────────────────────────
function initNetworkIndicator() {
  function update() {
    const online = navigator.onLine;
    let ind = document.getElementById('networkIndicator');
    if (online) { if (ind) ind.remove(); return; }
    if (!ind) {
      ind = document.createElement('div');
      ind.id = 'networkIndicator';
      ind.innerHTML = '📶 Hors ligne — certaines fonctionnalités sont limitées';
      ind.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#2C1810;color:#FFF8F3;text-align:center;font-size:12.5px;padding:9px 16px;z-index:9998;animation:pwaSlideUp .3s ease both';
      document.body.appendChild(ind);
    }
  }
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

// ─── Universal page init (auto-run on DOMContentLoaded) ─
document.addEventListener('DOMContentLoaded', () => {
  initStatCounters();
  initScrollReveal();
  initParticles();
  initParallaxOrbs();
  initPageLoadBar();
  initCardTilt();
  initMagneticButtons();
  initScrollProgress();
  initTopbarScroll();
  initServiceWorker();
  initNetworkIndicator();
});

