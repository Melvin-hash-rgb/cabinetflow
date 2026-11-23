# CabinetFlow — version publique (multi-cabinets)

Application web publique de CabinetFlow, le SaaS de Melvin pour les cabinets
comptables du Cameroun. Chaque cabinet crée **son** compte, ouvre **son**
espace privé, et travaille seul : les données sont cloisonnées par cabinet
(règles RLS dans Supabase).

Même modèle technique que WorldLink public : HTML/CSS/JS statique +
Supabase (authentification + base de données), librairie Supabase
auto-hébergée (`supabase.js`), cache-busting `?v=1`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Porte d'entrée, création de cabinet, application, console propriétaire |
| `styles.css` | Design premium marine et or |
| `app.js` | Toute la logique (auth, CRUD, calendrier fiscal, abonnement, export, console) |
| `config.js` | URL + clé anon Supabase (publique par conception) + `OWNER_USER_ID` |
| `supabase.js` | Librairie Supabase auto-hébergée (copie de celle de WorldLink) |
| `supabase-schema.sql` | Tables `cf_*`, règles RLS, droits (GRANTS) — à appliquer dans Supabase |

## Ce que fait l'application

- **Porte d'entrée** : création de compte (courriel + mot de passe, Supabase
  Auth), connexion à chaque visite. Personne n'entre dans le cabinet d'un autre.
- **Création de cabinet** : nom, ville, contacts → l'**essai gratuit de
  14 jours** démarre. Le créateur devient « responsable ».
- **Équipe** : le responsable ajoute des membres par le courriel de leur
  compte CabinetFlow (rôle responsable / employé).
- **Tableau de bord** : alertes documents manquants, échéances en retard,
  échéances des 7 prochains jours ; compteurs clients / dossiers.
- **Clients** : fiche complète camerounaise (NIU, régime fiscal, centre des
  impôts, n° CNPS, système SYSCOHADA).
- **Dossiers** : création libre ou depuis les modèles (tenue mensuelle,
  paie/DIPE, DSF annuelle, création d'entreprise).
- **Documents** : statuts reçu / manquant / demandé / validé, fichier joint
  depuis le téléphone (data URL, images redimensionnées).
- **Échéances** : génération automatique du calendrier fiscal camerounais
  par client et par année (TVA et DIPE/CNPS le 15 du mois suivant, patente
  le 28 février, DSF selon le centre : DGE 15 mars / CIME 15 avril /
  CDI 15 mai) + échéances manuelles. Aucun doublon.
- **Abonnement** : catalogue fixé par le propriétaire — Essentiel
  10 000 / Pro 25 000 / Premium 45 000 FCFA par mois. Le cabinet paie
  (MTN MoMo / Orange Money / virement / carte), déclare le paiement avec
  sa référence ; le propriétaire valide ; la période d'un mois démarre.
  Cycle : essai 14 jours → actif → grâce 7 jours → lecture seule
  (données conservées, écriture bloquée, déclaration de paiement
  toujours possible).
- **Export** : toutes les données du cabinet en CSV (clients, dossiers,
  documents, échéances), à tout moment.
- **Confidentialité** : page dédiée (données propriété du cabinet, ni
  vendues ni partagées, suppression sur demande, lois camerounaises
  2010/2024).
- **Console propriétaire** (Melvin seulement) : paiements déclarés à
  valider/refuser, liste de tous les cabinets, revenu mensuel récurrent.

## Déploiement — étapes restantes (à faire une fois)

1. **Appliquer le SQL** : dans le projet Supabase (le même que WorldLink),
   ouvrir « SQL Editor » → « New query », d'abord **remplacer** dans
   `supabase-schema.sql` la valeur `00000000-0000-0000-0000-000000000000`
   (un seul endroit : la fonction `cf_is_owner`) par l'UUID du compte
   Supabase Auth de Melvin, puis coller tout le fichier et cliquer « Run ».
2. **Renseigner `OWNER_USER_ID`** dans `config.js` avec le même UUID :
   c'est lui qui fait apparaître le bouton « Console propriétaire ».
   (Melvin doit d'abord créer son propre compte CabinetFlow sur le site
   déployé ; son UUID se lit dans Supabase → Authentication → Users.)
3. **Vérifier la configuration Auth** du projet Supabase : Site URL =
   l'adresse publique du site, Redirect URLs avec l'adresse du site
   (comme déjà fait pour WorldLink).
4. **Héberger le dossier** : même méthode que WorldLink (dépôt GitHub +
   Netlify, publication à la racine, aucun build). Penser à augmenter
   `?v=` dans `index.html` à chaque déploiement suivant.
5. **Test complet** : créer un compte, créer un cabinet, ajouter un
   client, générer son calendrier, déclarer un paiement, le valider
   depuis la console propriétaire, vérifier le passage en période active.
