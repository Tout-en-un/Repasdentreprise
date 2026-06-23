-- ============================================
-- FOODCHOOSEAPP — Schéma complet v4.1
-- Mise à jour : avril 2026
-- Changements v4.x :
--   - Suppression du rôle administrateur global
--   - L'entreprise est désormais son propre administrateur
--   - L'entreprise crée et gère les comptes employés
--   - L'entreprise gère toutes les commandes et affiliations
--   - Le restaurant peut ajouter des spécialités personnalisées (JSONB libre)
--   - Recherche de commandes par période (from/to) côté entreprise ET restaurant
--   - Filtre optionnel par client (entreprise) côté restaurant
--   - Export PDF et impression des résultats de recherche
--   - Vue budget total et top 3 clients pour le restaurant
-- ============================================


-- ============================================
-- TABLE : companies
-- Représente les entreprises clientes de la plateforme.
-- Chaque entreprise peut affilier plusieurs restaurants
-- et gérer les commandes de ses employés.
-- ============================================
CREATE TABLE IF NOT EXISTS companies (
  -- identifiant unique auto-incrémenté, on laisse PostgreSQL gérer la numérotation
  id SERIAL PRIMARY KEY,

  -- raison sociale de l'entreprise, obligatoire
  name VARCHAR(255) NOT NULL,

  -- secteur d'activité (ex: "banque", "tech", "industrie") — optionnel
  sector VARCHAR(255),

  -- numéro de téléphone du contact principal
  phone VARCHAR(50),

  -- adresse postale complète
  address TEXT,

  -- email unique servant d'identifiant de connexion
  email VARCHAR(255) UNIQUE NOT NULL,

  -- ville ou zone géographique, utile pour filtrer les restaurants à proximité
  location VARCHAR(255),

  -- mot de passe haché (bcrypt), jamais en clair en base
  password_hash VARCHAR(255) NOT NULL,

  -- URL du logo hébergé (Cloudinary ou autre CDN)
  logo_url TEXT,

  -- date d'inscription automatique à la création du compte
  created_at TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- TABLE : restaurants
-- Représente les restaurants partenaires de la plateforme.
-- Chaque restaurant peut proposer des menus et recevoir
-- des commandes de la part des entreprises affiliées.
-- ============================================
CREATE TABLE IF NOT EXISTS restaurants (
  -- identifiant unique auto-incrémenté
  id SERIAL PRIMARY KEY,

  -- nom commercial du restaurant
  name VARCHAR(255) NOT NULL,

  -- adresse physique du restaurant
  address TEXT,

  -- ville ou zone (cohérent avec la localisation des entreprises)
  location VARCHAR(255),

  -- email unique, sert également d'identifiant de connexion
  email VARCHAR(255) UNIQUE NOT NULL,

  -- numéro de téléphone du restaurant
  phone VARCHAR(50),

  -- tableau JSON des modes de paiement acceptés (ex: ["carte", "espèces", "virement"])
  payment_types JSONB DEFAULT '[]',

  -- tableau JSON des spécialités culinaires (ex: ["africain", "sushi", "pizza"])
  specialties JSONB DEFAULT '[]',

  -- mot de passe haché (bcrypt), jamais stocké en clair
  password_hash VARCHAR(255) NOT NULL,

  -- URL de la photo principale du restaurant (vitrine)
  photo_url TEXT,

  -- date d'inscription du restaurant sur la plateforme
  created_at TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- TABLE : affiliations
-- Table de liaison entre entreprises et restaurants.
-- Une affiliation signifie qu'une entreprise a choisi
-- ce restaurant comme partenaire pour les repas de ses employés.
-- La contrainte UNIQUE empêche les doublons d'affiliation.
-- ============================================
CREATE TABLE IF NOT EXISTS affiliations (
  -- identifiant de l'affiliation
  id SERIAL PRIMARY KEY,

  -- référence vers l'entreprise — supprimée si l'entreprise est supprimée
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,

  -- référence vers le restaurant — supprimée si le restaurant est supprimé
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,

  -- date de création du partenariat
  created_at TIMESTAMP DEFAULT NOW(),

  -- on ne peut pas affilier deux fois le même restaurant à la même entreprise
  UNIQUE(company_id, restaurant_id)
);


-- ============================================
-- TABLE : users
-- Représente les employés inscrits sur la plateforme.
-- Chaque employé appartient à une entreprise et peut
-- passer des commandes auprès des restaurants affiliés.
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  -- identifiant unique auto-incrémenté
  id SERIAL PRIMARY KEY,

  -- lien vers l'entreprise de l'employé — si l'entreprise est supprimée, l'employé l'est aussi
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,

  -- identifiant RH de l'employé (matricule interne), unique dans toute la plateforme
  employee_id VARCHAR(100) UNIQUE NOT NULL,

  -- prénom de l'employé
  first_name VARCHAR(100) NOT NULL,

  -- nom de famille de l'employé
  last_name VARCHAR(100) NOT NULL,

  -- email professionnel, unique pour éviter les doublons de compte
  email VARCHAR(255) UNIQUE NOT NULL,

  -- mot de passe haché — on ne stocke jamais le mot de passe en clair
  password_hash VARCHAR(255) NOT NULL,

  -- URL de la photo de profil (optionnel, hébergée sur Cloudinary)
  photo_url TEXT,

  -- préférence de boisson persistée pour pré-remplir les commandes (ex: "eau", "jus", "soda")
  drink_preference VARCHAR(20),

  -- date d'inscription de l'employé
  created_at TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- TABLE : menus
-- Représente les plats et boissons proposés par chaque restaurant.
-- Un restaurant peut avoir plusieurs entrées dans cette table,
-- une par article de son menu.
-- ============================================
CREATE TABLE IF NOT EXISTS menus (
  -- identifiant unique du plat
  id SERIAL PRIMARY KEY,

  -- le restaurant propriétaire du plat — supprimé si le restaurant disparaît
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,

  -- nom du plat (ex: "Poulet braisé", "Salade César")
  name VARCHAR(255) NOT NULL,

  -- description détaillée : ingrédients, allergènes, etc.
  description TEXT,

  -- catégorie du plat pour faciliter le tri (ex: "entrée", "plat", "dessert", "boisson")
  category VARCHAR(100) DEFAULT 'plat',

  -- prix en devise locale, avec 2 décimales
  price DECIMAL(10,2) DEFAULT 0,

  -- indique si le plat est actuellement proposé au menu ou temporairement retiré
  available BOOLEAN DEFAULT TRUE,

  -- URL de la photo du plat (hébergée sur Cloudinary ou autre CDN)
  image_url TEXT,

  -- date d'ajout du plat au catalogue
  created_at TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- TABLE : orders
-- Représente une commande individuelle passée par un employé.
-- La contrainte UNIQUE(user_id, restaurant_id, order_date) garantit
-- qu'un employé ne peut commander qu'une seule fois par jour
-- dans un restaurant donné.
-- ============================================
CREATE TABLE IF NOT EXISTS orders (
  -- identifiant de la commande
  id SERIAL PRIMARY KEY,

  -- entreprise de l'employé qui commande (dénormalisé pour faciliter les requêtes)
  company_id INTEGER REFERENCES companies(id),

  -- restaurant ciblé par la commande
  restaurant_id INTEGER REFERENCES restaurants(id),

  -- employé qui passe la commande — si l'employé est supprimé, la commande aussi
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,

  -- plat choisi dans le menu du restaurant
  menu_id INTEGER REFERENCES menus(id),

  -- date du repas commandé (pas forcément aujourd'hui)
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,

  -- boisson choisie pour ce repas précis (peut différer de la préférence par défaut)
  drink_preference VARCHAR(20),

  -- état de la commande : 'pending', 'confirmed', 'delivered', 'cancelled', etc.
  status VARCHAR(30) DEFAULT 'pending',

  -- notes libres de l'employé (allergies, demandes spéciales)
  notes TEXT,

  -- horodatage de création de la commande
  created_at TIMESTAMP DEFAULT NOW(),

  -- horodatage de dernière modification (ex: changement de statut)
  updated_at TIMESTAMP DEFAULT NOW(),

  -- un employé ne peut avoir qu'une commande par restaurant par jour
  UNIQUE(user_id, restaurant_id, order_date)
);


-- ============================================
-- TABLE : order_batches
-- Regroupe toutes les commandes d'une entreprise vers un restaurant
-- pour une journée donnée, afin de faciliter la facturation et
-- la confirmation groupée côté restaurant.
-- ============================================
CREATE TABLE IF NOT EXISTS order_batches (
  -- identifiant du lot de commandes
  id SERIAL PRIMARY KEY,

  -- entreprise concernée par ce lot
  company_id INTEGER REFERENCES companies(id),

  -- restaurant qui va recevoir et traiter ce lot
  restaurant_id INTEGER REFERENCES restaurants(id),

  -- date du repas pour lequel ce lot est constitué
  batch_date DATE NOT NULL,

  -- statut du lot : 'pending', 'confirmed', 'invoiced', 'paid', etc.
  status VARCHAR(30) DEFAULT 'pending',

  -- montant total calculé à partir de la somme des plats commandés
  total_amount DECIMAL(10,2) DEFAULT 0,

  -- date et heure à laquelle le restaurant a confirmé la réception du lot
  confirmed_at TIMESTAMP,

  -- date de création du lot (souvent en début de journée ou à la clôture des commandes)
  created_at TIMESTAMP DEFAULT NOW(),

  -- un seul lot par couple (entreprise, restaurant, date) — évite les doublons
  UNIQUE(company_id, restaurant_id, batch_date)
);


-- Pour exécuter sur Neon, exécuter ces commandes SQL:
-- ALTER TABLE invoices ADD COLUMN IF NOT EXISTS from_date DATE;
-- ALTER TABLE invoices ADD COLUMN IF NOT EXISTS to_date DATE;
-- ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent BOOLEAN DEFAULT false;
-- ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;
-- ALTER TABLE invoices ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;
CREATE TABLE IF NOT EXISTS invoices (
  -- identifiant de la facture
  id SERIAL PRIMARY KEY,

  -- entreprise qui doit régler la facture
  company_id INTEGER REFERENCES companies(id),

  -- restaurant qui a émis la facture
  restaurant_id INTEGER REFERENCES restaurants(id),

  -- lot de commandes à l'origine de cette facture
  batch_id INTEGER REFERENCES order_batches(id),

  -- date d'émission de la facture
  invoice_date DATE DEFAULT CURRENT_DATE,

  -- montant total TTC de la facture
  total_amount DECIMAL(10,2),

  -- détail des articles facturés sous forme JSON (nom plat, qté, prix unitaire)
  items JSONB DEFAULT '[]',

  -- période de la facture
  from_date DATE,
  to_date DATE,

  -- état de la facture : 'pending', 'confirmed', 'paid', 'disputed', etc.
  status VARCHAR(20) DEFAULT 'pending',

  -- facture envoyée à l'entreprise
  sent BOOLEAN DEFAULT false,
  sent_at TIMESTAMP,

  -- confirmation de réception par l'entreprise
  confirmed_at TIMESTAMP,

  -- date de création de l'enregistrement en base
  created_at TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- TABLE : order_history
-- Historique immuable des actions sur les commandes.
-- Contrairement à la table orders, on ne supprime rien ici :
-- c'est un journal d'audit permettant de tracer qui a fait quoi et quand.
-- Les données sont dénormalisées exprès pour ne pas dépendre
-- des enregistrements liés (qui pourraient être supprimés).
-- ============================================
CREATE TABLE IF NOT EXISTS order_history (
  -- identifiant de l'entrée d'historique
  id SERIAL PRIMARY KEY,

  -- référence souple vers l'employé (SET NULL si l'employé est supprimé)
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- identifiant de l'entreprise au moment de l'action
  company_id INTEGER REFERENCES companies(id),

  -- matricule de l'employé, dénormalisé pour conserver la trace même après suppression
  employee_id VARCHAR(100),

  -- nom complet de l'employé au moment de l'action (dénormalisé)
  employee_name VARCHAR(255),

  -- nom du restaurant au moment de la commande (dénormalisé)
  restaurant_name VARCHAR(255),

  -- nom du plat commandé au moment de l'action (dénormalisé)
  menu_name VARCHAR(255),

  -- date du repas concerné par cette entrée d'historique
  order_date DATE,

  -- boisson associée à la commande historisée
  drink_preference VARCHAR(20),

  -- type d'action effectuée : 'created', 'updated', 'cancelled', 'confirmed', etc.
  action VARCHAR(50),

  -- horodatage précis de l'action
  action_timestamp TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- TABLE : messages
-- Système de messagerie interne entre une entreprise et un restaurant.
-- Supporte désormais les messages texte, vocaux et fichiers.
-- Les médias (audio, fichiers) sont stockés sur Cloudinary,
-- et leurs URLs sont enregistrées ici pour un accès direct sans
-- passer par le serveur applicatif.
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
  -- identifiant unique du message
  id SERIAL PRIMARY KEY,

  -- qui envoie le message : 'company' ou 'restaurant'
  sender_type VARCHAR(20) NOT NULL,

  -- identifiant de l'expéditeur dans sa table respective (companies ou restaurants)
  sender_id INTEGER NOT NULL,

  -- entreprise partie prenante de la conversation — supprimée en cascade
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,

  -- restaurant partie prenante de la conversation — supprimé en cascade
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,

  -- contenu textuel du message (peut être vide si c'est un message purement audio ou fichier)
  content TEXT NOT NULL,

  -- type de message pour orienter l'affichage côté front : 'text', 'audio', ou 'file'
  message_type VARCHAR(10) DEFAULT 'text',

  -- données audio encodées en base64 (fallback si Cloudinary n'est pas utilisé)
  -- à éviter pour les gros fichiers : préférer audio_url dans ce cas
  audio_data TEXT,

  -- données de fichier encodées en base64 (fallback local, déconseillé pour les gros fichiers)
  file_data TEXT,

  -- nom original du fichier envoyé (ex: "devis_avril.pdf") — pour l'affichage et le téléchargement
  file_name VARCHAR(255),

  -- type MIME du fichier (ex: "application/pdf", "image/png") — pour le rendu côté client
  file_mime VARCHAR(100),

  -- URL publique Cloudinary du fichier audio (prioritaire sur audio_data si présent)
  -- permet de lire le son directement depuis le CDN sans surcharger la base
  audio_url VARCHAR(500),

  -- URL publique Cloudinary du fichier joint (prioritaire sur file_data si présent)
  -- permet de télécharger ou prévisualiser le fichier depuis le CDN
  file_url VARCHAR(500),

  -- indique si l'entreprise a déjà lu ce message
  read_by_company BOOLEAN DEFAULT FALSE,

  -- indique si le restaurant a déjà lu ce message
  read_by_restaurant BOOLEAN DEFAULT FALSE,

  -- horodatage d'envoi du message
  created_at TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- TABLE : notifications
-- Stocke les notifications push ou in-app destinées aux utilisateurs.
-- Peut cibler une entreprise, un restaurant, ou un employé,
-- selon les valeurs de target_type et target_id.
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
  -- identifiant unique de la notification
  id SERIAL PRIMARY KEY,

  -- type de destinataire : 'company', 'restaurant', ou 'user'
  target_type VARCHAR(20) NOT NULL,

  -- identifiant du destinataire dans sa table respective
  target_id INTEGER NOT NULL,

  -- titre court de la notification (affiché en gras dans l'UI)
  title VARCHAR(255),

  -- corps du message de la notification
  message TEXT,

  -- catégorie de notification pour personnaliser l'icône ou le comportement (ex: 'order', 'message', 'invoice')
  type VARCHAR(50),

  -- indique si la notification a été vue et acquittée par le destinataire
  read BOOLEAN DEFAULT FALSE,

  -- données arbitraires en JSON pour enrichir la notification (ex: ID de commande à ouvrir au clic)
  data JSONB DEFAULT '{}',

  -- date et heure d'émission de la notification
  created_at TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- TABLE : push_subscriptions
-- Stocke les abonnements Web Push par utilisateur pour envoyer
-- des notifications mobiles même quand l'app est fermée.
-- ============================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  target_type VARCHAR(20) NOT NULL,
  target_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_subs_target ON push_subscriptions(target_type, target_id);


-- ============================================
-- TABLE : ratings
-- Permet aux employés d'évaluer les plats qu'ils ont commandés.
-- La contrainte UNIQUE(user_id, menu_id, order_date) empêche
-- de noter plusieurs fois le même plat pour le même jour.
-- ============================================
CREATE TABLE IF NOT EXISTS ratings (
  -- identifiant de l'évaluation
  id SERIAL PRIMARY KEY,

  -- employé qui donne son avis
  user_id INTEGER REFERENCES users(id),

  -- plat évalué
  menu_id INTEGER REFERENCES menus(id),

  -- restaurant propriétaire du plat (dénormalisé pour faciliter les requêtes d'agrégation)
  restaurant_id INTEGER REFERENCES restaurants(id),

  -- note de 1 à 5 étoiles — la contrainte CHECK empêche les valeurs hors plage
  score INTEGER CHECK (score BETWEEN 1 AND 5),

  -- commentaire libre optionnel de l'employé
  comment TEXT,

  -- date du repas évalué (permet de relier l'avis à la commande correspondante)
  order_date DATE,

  -- date de soumission de l'évaluation
  created_at TIMESTAMP DEFAULT NOW(),

  -- un employé ne peut laisser qu'un avis par plat par jour
  UNIQUE(user_id, menu_id, order_date)
);


-- ============================================
-- TABLE : deletion_feedback
-- Collecte les raisons de suppression de compte restaurant.
-- Sert d'outil de rétention et d'analyse produit pour comprendre
-- pourquoi les restaurants quittent la plateforme.
-- ============================================
CREATE TABLE IF NOT EXISTS deletion_feedback (
  -- identifiant du retour de suppression
  id SERIAL PRIMARY KEY,

  -- identifiant du restaurant qui part (pas de clé étrangère car il peut déjà être supprimé)
  restaurant_id INTEGER,

  -- raison principale de la résiliation (texte libre)
  reason TEXT,

  -- niveau de satisfaction global exprimé par le restaurant sortant
  experience VARCHAR(100),

  -- problème technique ou fonctionnel éventuellement signalé
  issue TEXT,

  -- indique si le restaurant a finalement confirmé la suppression ou s'est ravisé
  confirmed BOOLEAN DEFAULT FALSE,

  -- date et heure du retour
  created_at TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- TABLE : password_resets
-- Gère les demandes de réinitialisation de mot de passe
-- via un code OTP à 6 chiffres envoyé par email.
-- Une entrée par demande, expirée après un délai configuré côté serveur.
-- ============================================
CREATE TABLE IF NOT EXISTS password_resets (
  -- identifiant de la demande de réinitialisation
  id SERIAL PRIMARY KEY,

  -- email du compte qui demande la réinitialisation
  email VARCHAR(255) NOT NULL,

  -- type de compte concerné : 'company', 'restaurant', ou 'user'
  user_type VARCHAR(20) NOT NULL,

  -- code OTP à 6 chiffres envoyé par email, à valider avant expiration
  otp_code VARCHAR(6) NOT NULL,

  -- date et heure d'expiration du code (généralement NOW() + 15 minutes côté serveur)
  expires_at TIMESTAMP NOT NULL,

  -- indique si le code a déjà été utilisé (empêche la réutilisation)
  used BOOLEAN DEFAULT FALSE,

  -- date de création de la demande
  created_at TIMESTAMP DEFAULT NOW()
);


-- ============================================
-- INDEX DE PERFORMANCE
-- Ces index accélèrent les requêtes les plus fréquentes
-- dans l'application. Ils sont créés séparément des tables
-- pour une meilleure lisibilité et peuvent être ajoutés
-- à chaud sans recréer les tables.
-- ============================================

-- accélère le filtrage des commandes par entreprise (tableau de bord RH)
CREATE INDEX IF NOT EXISTS idx_orders_company ON orders(company_id);

-- accélère le filtrage des commandes par date (vue journalière)
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);

-- accélère la récupération des plats d'un restaurant (affichage du menu)
CREATE INDEX IF NOT EXISTS idx_menus_restaurant ON menus(restaurant_id);

-- accélère le chargement d'une conversation entre une entreprise et un restaurant
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(company_id, restaurant_id);

-- accélère la récupération des notifications d'un destinataire donné
CREATE INDEX IF NOT EXISTS idx_notif_target ON notifications(target_type, target_id);

-- accélère les requêtes sur l'historique des commandes par date (rapports, exports)
CREATE INDEX IF NOT EXISTS idx_history_date ON order_history(order_date);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS from_date DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS to_date DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent BOOLEAN DEFAULT false;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at TIMESTAMP;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;

-- ============================================
-- FONCTIONNALITÉS v5.0 — Juin 2026
-- Composition personnalisée + Négociations + Confidentialité
-- ============================================

CREATE TABLE IF NOT EXISTS custom_weekly_compositions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL DEFAULT 'Ma composition',
  week_start DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'draft',
  company_proposed_price DECIMAL(10,2),
  restaurant_counter_price DECIMAL(10,2),
  final_price DECIMAL(10,2),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS custom_composition_dishes (
  id SERIAL PRIMARY KEY,
  composition_id INTEGER REFERENCES custom_weekly_compositions(id) ON DELETE CASCADE,
  dish_id INTEGER REFERENCES weekly_day_dishes(id) ON DELETE CASCADE,
  dish_name VARCHAR(255) NOT NULL,
  pack_name VARCHAR(255),
  day_of_week INTEGER NOT NULL,
  quantity INTEGER DEFAULT 1,
  unit_price DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_negotiations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  entity_type VARCHAR(30) NOT NULL,
  entity_id INTEGER NOT NULL,
  entity_name VARCHAR(255),
  status VARCHAR(20) DEFAULT 'pending',
  original_price DECIMAL(10,2),
  final_agreed_price DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS negotiation_messages (
  id SERIAL PRIMARY KEY,
  negotiation_id INTEGER REFERENCES price_negotiations(id) ON DELETE CASCADE,
  sent_by VARCHAR(20) NOT NULL,
  sender_id INTEGER NOT NULL,
  proposed_price DECIMAL(10,2),
  message TEXT,
  action VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurant_client_privacy (
  id SERIAL PRIMARY KEY,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  is_confidential BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(restaurant_id, company_id)
);

-- Heure de livraison souhaitée pour les abonnements et compositions
ALTER TABLE company_weekly_selections ADD COLUMN IF NOT EXISTS delivery_time TIME DEFAULT '12:00:00';
ALTER TABLE custom_weekly_compositions ADD COLUMN IF NOT EXISTS delivery_time TIME DEFAULT '12:00:00';
);