# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

This one reads the electricity and gas meters of US utilities served by
Opower (Oracle): it signs in to the utility's website, gets an Opower token,
and calls the Opower API. Electricity feeds the Gladys 5.2 energy tracking
through dated consumption (`publishEnergyConsumption`).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "PG&E"    # tests whose name matches
node scripts/probe.mjs                    # live sites, read-only (needs Internet)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: createApp + registerHandlers, then connect()
src/app.js                        the cycle (sign in, read, publish), code actions, widget, scene action
src/poller.js                     the container's 12-hour timer; the core's onPoll is a fallback
src/utilities/index.js            registry of the supported utilities (keys are config values: forever)
src/utilities/<company>.js        one sign-in flow per family (pge, coned, exelon, aep, pse, duquesne)
src/utilities/forms.js            the little HTML reading the sign-in pages need
src/opower/client.js              Opower API: accounts, GraphQL forecast, windowed reads, cost fallback
src/summary.js                    pure: hourly reads → half hours, daily reads → days, summaries, gas m³
src/meters.js                     one device per meter, feature keys, summary states
src/widgets.js                    the "energy_summary" widget content (pure)
src/http.js                       session with a cookie jar and manual redirects (fetch injected)
src/time.js, src/totp.js          zone arithmetic without a library; RFC 6238 codes (ConEd, O&R)
src/store.js                      /data/opower-state.json (0600): sign-in data, per-meter cursor
src/i18n.js, src/config.js        texts in four languages; DEFAULT_CONFIG mirrors the manifest
scripts/probe.mjs                 checks the live sign-ins read-only (made-up account, or a real one)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/{en,fr,de,es}.md             user documentation, re-hosted by Gladys, same sections
test/                             node --test, SDK fake Gladys + test/helpers/fake-web.js (no network)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device (serial, cloud id, MAC), never a label. Gladys keys
  devices, their history, scenes and dashboards on them: changing one creates a
  new device and orphans the old one. The same goes for every key users store:
  manifest `config_schema`, `actions`, widget and scene keys, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code (defaults, action, scene and widget handlers): change both sides
  together.
- **User-facing text** is in four languages (English, French, German with
  "du", Spanish with "usted"): action messages, manifest texts, widget texts,
  feature names, and `docs/en.md`, `docs/fr.md`, `docs/de.md`, `docs/es.md`
  with the same sections. `test/i18n.test.js` enforces it.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

---

# Notes du mainteneur (guim31)

Ce qui suit complète les règles du template ci-dessus. Ce sont des faits vérifiés dans le code du
cœur Gladys ou payés sur les intégrations déjà publiées par guim31. Ils ne se lisent pas dans le
code de ce dépôt. Compléter ce fichier quand un nouveau piège est découvert.

## Travailler sur ce dépôt

- Mêmes étapes que la CI, dans le même ordre : `npm ci`, `npm run format:check`, `npm run lint`,
  `npm test`. Prettier contrôle **aussi le Markdown** : lancer `npm run format` après avoir
  modifié ce fichier, le README ou la documentation, sinon la CI tombe.
- Une session de code n'a **ni instance Gladys ni appareil réel**. La suite de tests, le lint et
  le validateur du store sont les seules vérifications possibles : le test réel se fait ailleurs.
  Le dire, plutôt que de conclure que « ça marche ».
- **Tout le code de démonstration du template disparaît** : station météo, prise, lampe, caméra,
  capteur de mouvement, `src/weather.js`, leurs tests, leurs entrées du manifeste et de la
  documentation. Il ne reste que ce que l'intégration fait vraiment.
- **Publier n'est jamais le travail d'une session de code** : ni Release, ni tag, ni topic, ni
  version modifiée à la main. L'orchestrateur s'en charge une fois la PR fusionnée. Les workflows
  sont ceux du template : ne pas les modifier.
- Le dépôt est **public** : aucun secret, aucune adresse ni détail d'infrastructure privée, ni
  ici, ni dans les tests, ni dans les captures.

## Pièges du cœur Gladys

**Appareils et fonctionnalités**

- **Polling** : le planificateur n'interroge un appareil que si `should_poll: true` **et**
  `poll_frequency` vaut une valeur de la liste fixe, **en millisecondes** (1000, 2000, 10000,
  15000, 30000, 60000). Le template publie `poll_frequency: 300` sans `should_poll` : c'est faux,
  le cœur répond 400 à la découverte. Pour une cadence hors liste, publier `should_poll: false` et
  pousser les états depuis le conteneur, en gardant un `onPoll` de repli.
  **Piège du 5.2.0** (GladysAssistant/Gladys#3198, correctif #3199, relevé sur gladys-ping-wol) :
  un appareil **créé sans `should_poll`** n'est jamais sondé, même après correction du cœur (valeur
  stockée à la création), et la 5.2.1 du 13/10/2026 ne le corrige pas. **Le conteneur sonde donc
  lui-même** par un minuteur, qui saute un appareil sondé il y a moins d'une demi-période, en gardant
  `onPoll` comme repli ; seuls les appareils ajoutés (`gladys.devices`) sont lus. Un test le prouve
  sans appeler `onPoll`.
- **`min` et `max` sont NOT NULL** dans `t_device_feature`, y compris pour `text/text` : sans eux,
  « Ajouter à Gladys » échoue en HTTP 422. Mettre 0/0, comme Zigbee2MQTT.
- Un état publié sur une fonctionnalité **pas encore ajoutée** dans Gladys reçoit un 200 puis est
  jeté (simple ligne de log) : republier les états dans `onDeviceCreated`.
- `level-sensor/decimal` n'existe pas côté serveur. `light-sensor/binary` n'a pas de libellé dans
  le front (pastille vide) : préférer `input/binary`. Un `text/text` reçoit `{ text }`, jamais
  vide, sinon l'état est ignoré.
- **Détecteur d'ouverture (`opening-sensor`) : 0 = ouvert, 1 = fermé** (`OPENING_SENSOR_STATE`), à
  l'inverse de l'intuition et des autres détecteurs (mouvement, fuite, fumée : 1 = détecté). Une
  porte ouverte publiée à 1 s'affiche « Fermé » et fausse scènes et historique. Le figer par un test.
- **Un `external_id` de fonctionnalité ne change jamais d'appareil** d'une version à l'autre. UniFi
  1.5.2 avait sorti les ports PoE dans un appareil dédié, la 1.6.0 les a remis dans la passerelle avec
  les mêmes identifiants : ceux qui avaient ajouté l'appareil dédié ne peuvent plus « Mettre à jour » la
  passerelle (409 `external_id must be unique`). Pour regrouper, garder l'appareil existant
  (`gladys.getDevices()`) ou changer d'identifiant.
- Les **noms de fonctionnalités sont figés à la création**. Et quand une fonctionnalité est seule
  de son type sur l'appareil, le tableau de bord affiche le libellé générique du type à la place
  du nom publié.
- **Aucune commande d'appareil ne permet un choix multiple** : un `text/select` n'a qu'un choix
  actif.
- Un changement de structure fait proposer « Mettre à jour » dans l'onglet Découverte
  (`structure_changed`). Un changement des seules `supported_options` ne le déclenche pas.
- **Jauge** : l'aiguille se place par `(value - min) / (max - min)` des bornes de la
  fonctionnalité. `gauge_min`/`gauge_max` ne pilotent que les couleurs, et le cœur n'applique
  jamais `min`/`max` en écriture : ce sont des bornes d'affichage. Une valeur signée exige des
  bornes symétriques.
- Le cœur plafonne à **300 états par minute** et réévalue les scènes à chaque état : ne publier
  que les changements.
- Une intégration `device` ne reçoit pas la langue de l'utilisateur, une action de scène non
  plus (un widget, si) : prévoir un champ de config `language` si des textes partent du
  conteneur. Le superviseur injecte `TZ`, le fuseau de Gladys. La sandbox est limitée à 256 Mo.

**Formulaires de configuration et actions**

- Les champs `number` sont rendus **sans `step`** : le navigateur n'accepte alors que `min + k`.
  Min et défaut **entiers** seulement ; une valeur décimale passe par un `select` ou par un
  `string` parsé (virgule acceptée).
- Un champ `secret` dans les `fields` d'une **action** est impossible à remplir, et une action
  n'applique **aucun `default`** tout en exigeant les champs `required` (422). Issues
  GladysAssistant/Gladys#3154 et #3155.

**SDK 0.15 et journaux**

- SDK `@gladysassistant/integration-sdk` **^0.15.0** (12/10/2026) : `DEVICE_POLL_FREQUENCIES`, faux
  Gladys de test (`@gladysassistant/integration-sdk/testing`, à préférer à un faux maison),
  déduplication des états, `parseMdnsTxt`. Lire son README et son CHANGELOG.
- **Journaux calmes** (demande de Guilhem, 13/10/2026) : rien au niveau info pour un cycle normal de
  lecture, un état publié ou un message reçu. L'info ne garde que le cycle de vie : démarrage,
  connexion, perte et retour d'un appareil ou d'un service, erreurs utiles, une ligne par action de
  l'utilisateur. Le reste passe en debug (`LOG_LEVEL=debug`). Une erreur qui se répète écrit une ligne
  au premier échec et une au rétablissement, pas une par tentative. Jamais de secret ni d'adresse
  avec identifiants. Un test vérifie qu'un cycle normal n'écrit rien en info.
- **Heartbeat** : republier au moins toutes les 12 h une valeur qui ne change pas, sinon le front
  affiche « Pas de valeur récente » au-delà de 48 h.

**Widgets, déclencheurs, actions de scène (SDK ≥ 0.14, Gladys ≥ 5.1)**

- **Cibler la dernière version publiée du cœur, pas `master`** : la spec de `master` décrit des
  fonctions non publiées. Les boutons de widget qui ouvrent un formulaire (#3168, commit 3feb2cf8)
  sont absents de la 5.1.4 mais **livrés dans la 5.2.0** (sortie le 12/10/2026) : `gladys_version`
  `>=5.2.0` si on s'en sert, ou un bouton direct en repli. Vérifier par `git tag --contains`.

- Un réglage de widget ne propose en liste que les **appareils** de l'intégration
  (`source: "devices"`, seule source dynamique).
- Budget du cœur : **8 composants par widget, dont 2 textes au plus**, appliqué **avant** la
  résolution des références ; un contenu amputé reste en cache jusqu'au TTL. Appeler
  `requestWidgetRefresh` à la création d'un appareil. `validateWidgetContent` est exporté pour les
  tests, mais ne vérifie pas que les `external_id` liés existent : les croiser avec `buildDevice`.
- Une ligne de `status` exige un `value` (nombre ou texte ≤ 40).
- Le cœur **jette un bouton dont la clé d'action est déjà prise** : clés numérotées.
- Le vocabulaire des widgets n'a ni liste ni curseur, **par choix** du cœur. Seul un bouton
  `device_feature` numérique a un état actif natif.
- **En mode sombre, le style `primary` d'un bouton de widget ne se voit pas** (#3153) : signaler
  un choix courant par l'icône (`check-circle`), jamais par le style.
- Dans une grille `card-list`, la `date` s'affiche **à la place** du sous-titre.
- `onWidgetAction` fait recharger le widget dès la résolution, alors que `requestWidgetRefresh`
  est plafonné à un appel toutes les 10 s. Un toast d'action est tronqué à 200 caractères.
- Le cœur met le contenu d'un widget en cache par (réglages, langue, unités) : pré-localiser
  d'après `language` est correct.
- Les filtres de scène ne font qu'égalité et appartenance : un seuil reste le travail d'un capteur.
- **Les clés de widgets, de déclencheurs et d'actions sont figées une fois publiées.**
- `gladys_version` `>=5.1.0` dès qu'il y a widgets, déclencheurs ou actions de scène.

## Intégration Opower : API et pièges (vérifiés dans le code)

**Sources.** Les connexions et l'API sont portées de `tronikos/opower` (Apache-2.0) : un module par
famille (`src/utilities/`), seulement ce que l'intégration utilise (`src/opower/client.js` : comptes,
prévision GraphQL, lectures `DataBrowser-v1`). Les fournisseurs non portés sont listés dans `NOT_YET`
et dans les quatre docs (le test i18n le vérifie). Les hôtes des fournisseurs et `*.opower.com` sont
refusés par le proxy des sessions de code : `scripts/probe.mjs` éprouve les vrais sites depuis une
machine qui a le réseau (faux compte → refus propre attendu ; vrai compte → comptage, rien de
personnel affiché).

**Suivi d'énergie (cœur 5.2.0+).**

- Données en retard de 24-48 h : **aucun index cumulé** (`energy-sensor/index` ou `energy`, que le
  cœur transforme en consommation au fil de l'eau : un jour tardif tomberait dans une demi-heure).
  L'électricité publie une consommation datée par `publishEnergyConsumption` (POST
  `/energy/consumption`, présent depuis v5.2.0) sur `energy-sensor/thirty-minutes-consumption`
  (lectures horaires coupées en deux moitiés, pratique recommandée par le cœur) ou
  `daily-consumption` (compteur lu au jour). Contraintes du cœur : créneau aligné sur le fuseau de
  Gladys, intervalle écoulé, `kwh ≥ 0`, 2 000 par appel, 5 ans au plus, **404 tant que l'appareil
  n'est pas créé** : republier dans `onDeviceCreated`. Upsert par instant : renvoyer les 3 derniers
  jours à chaque cycle est sans coût (le cœur n'écrit que ce qui change).
- Le cœur dérive la fonctionnalité de coût (`<external_id>_cost`) et **rattache la consommation au
  compteur électrique principal** si elle n'a pas de parent : une consommation de gaz s'ajouterait
  à l'électricité, et les contrats 5.2.1 ne valorisent que l'électricité. Le gaz n'a donc pas de
  fonctionnalité de consommation.
- Les bilans (dernier jour, mois, prévision) ne doivent **pas** être d'un type consommation
  (`daily-consumption` serait compté deux fois) ni index : `energy-sensor/index-yesterday` (kWh,
  ignoré par la logique du cœur, libellé « Index hier » seulement quand il est seul de son type ;
  ici ils sont trois, les noms publiés s'affichent), `volume-sensor/decimal` en m³ pour le gaz,
  `currency/decimal` en `dollar` pour les coûts.
- Gladys n'a **ni therm ni CCF** : CCF → m³ exact (× 2,8317), therm → m³ par le pouvoir
  calorifique moyen américain (1 037 Btu/pi³, EIA, × 2,7307). Le dire dans les docs.
- Net metering : une heure d'injection est négative chez Opower, refusée par le cœur → publiée à 0
  dans le suivi d'énergie ; les bilans gardent le net.
- Le faux Gladys du SDK tourne en UTC : une `date` journalière y est lue comme minuit UTC.

**Connexions.**

- PG&E : actions Apex « Aura » ; `verifymfa :` demande un code (options e-mail/SMS, parfois aucune :
  le code est déjà parti). Le code validé rend deux cookies qui évitent le code ensuite (`/data`).
- Exelon (ComEd, PECO, BGE, Pepco, Delmarva, ACE) : flux Azure B2C de l'appli mobile, **code
  toujours demandé la première fois**, puis jetons de rafraîchissement. Azure fait tourner le jeton
  à chaque usage : on sauve le nouveau à chaque connexion (la bibliothèque Python garde l'ancien).
  Pepco/Delmarva : sous-domaine Opower `pep`/`dpl` pour un logement du Maryland, `pepd`/`dpld`
  sinon. Les `SETTINGS`/`SA_FIELDS` se lisent par une regex **sur une ligne** (`var X = {...};`) :
  dans les fausses pages des tests, une balise par ligne.
- ConEd / O&R : cookies **non quotés** (coned.com refuse un `CE_DEVICE_ID` quoté), cookie
  d'appareil gardé dans `/data` ; double authentification par **clé TOTP** (champ `secret` de la
  config, jamais d'action : #3154), codes calculés par `src/totp.js` (vecteurs RFC 6238 testés).
- AEP : formulaire ASP.NET aux noms générés, tous les `<input>` renvoyés ; vider les cookies
  `opower.com` avant une nouvelle connexion. PSE : jeton anti-falsification puis jeton dans un
  `<script>`. Duquesne : derrière Incapsula, en-têtes de navigation.
- **Sonde réelle du 14/10/2026** (faux comptes) : PG&E, ConEd et ComEd refusent proprement.
  AEP Ohio est **lent** (en-têtes en ~7 s, page de 215 Ko en ~22 s) : `src/http.js` a deux délais,
  60 s pour les en-têtes puis 90 s pour le corps, et dit lequel a expiré. PSE a fini sur
  `/servererrorpage` (HTTP 500) : après les identifiants ou au sélecteur de compte, c'est lu comme un
  refus ; PSE reste « expérimental » dans les docs tant qu'un vrai compte ne l'a pas validé.
  `node scripts/probe.mjs --trace` liste chaque requête (sans query, cookies et jetons masqués)
  pour situer l'étape qui échoue.
- Un nouveau login **annule le code envoyé** : le cycle de 12 h saute la connexion tant qu'un code
  est attendu (10 min). Les actions « Envoyer le code » / « Saisir le code » portent le défi en
  mémoire (même session HTTP).
- API Opower : fenêtres de 363 jours (jour), 26 (heure), 6 (demi/quart d'heure), du plus récent au
  plus ancien ; `endDate` servi comme un jour entier ; l'endpoint de coût peut répondre 500 (ConEd)
  ou vide (PG&E) → repli sur l'endpoint d'usage, sans coût. Supprimer les lectures nulles finales
  (heures pas encore relevées).

**SDK.** Le faux Gladys acquitte une action par `{ message }` et une action de scène par
`{ outputs }` : les tests lisent `ack.data.message` / `ack.data.outputs`.

## Store

- Validateur officiel, depuis la racine : `npx -y github:GladysAssistant/integration-store .`
  (schéma, `description` **100 caractères au plus par langue**, documentation de 300 caractères
  au moins, image Docker, cover de **150 Ko au plus**). Il demande Node ≥ 24 mais tourne sous
  Node 22 avec un avertissement.
- L'indexeur lit le manifeste de la **dernière release**, pas celui de `main` : une correction du
  manifeste (catégorie, description…) n'atteint le store qu'avec une release.
- L'indexeur rejette **en silence** : la raison n'apparaît que dans `rejected.json`, à côté de
  `https://integration-store-storage.gladysassistant.com/index.json`.
- **Image de base** : `FROM public.ecr.aws/docker/library/node:…` (miroir officiel ECR Public, même
  empreinte) et non `node:…` de Docker Hub, qui refuse en 429 les pulls anonymes des runners GitHub
  dès qu'il y a plusieurs builds à la fois. Un échec 429 dans le job « Docker build » n'est pas un bug
  du code. Même parade dans `.github/workflows/build.yml` (posée par l'orchestrateur, ne pas la
  retirer) : QEMU et BuildKit tirés de `mirror.gcr.io`.
- La règle `data/` du `.gitignore` du template (pour le volume `/data`) exclut aussi `src/data/` :
  l'ancrer en `/data/`, dans `.prettierignore` aussi.

### Langues (depuis le 11/10/2026)

Tout texte montré à l'utilisateur existe en **`en`, `fr`, `de` et `es`** : manifeste, contenu des widgets, messages,
noms de fonctionnalités. L'allemand **tutoie** (« du »), l'espagnol **vouvoie** (« usted ») : décision de Guilhem,
appliquée à ses 21 intégrations. `test/i18n.test.js` doit échouer sur une langue manquante, un texte vide ou trop
long, et sur un « Sie »/« Ihr… » de politesse en allemand. Le store exige `docs/en.md` et `docs/fr.md`
(`DOCS_LANGUAGES`) et publie aussi `docs/de.md` et `docs/es.md` quand ils existent
(`DOCS_OPTIONAL_LANGUAGES` d'integration-store) : écrire les quatre, avec les mêmes sections.

## Choix par défaut de Guilhem (12/10/2026)

- Langue par défaut des noms de fonctionnalités et des textes produits par le conteneur : **`fr`**.
- Fichier `LICENSE` Apache-2.0 (texte complet) à la racine.
- `transports` : `local` seul quand le cloud n'est qu'une option annexe.
- Docs `en`, `fr`, `de`, `es` avec les mêmes sections.
- Chauffe, ouverture, sécurité : ne rien rendre pilotable « comme un thermostat » ou par un assistant
  vocal quand une erreur serait dangereuse (leçon d'OctoPrint).
