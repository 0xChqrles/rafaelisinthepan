// THE FRENCH ARTICLE LEVELS (2026-09-29): the author's article « J’ai amélioré Cémantix avec
// une IA qui ne peut pas parler » (chqrles.me/cemantix, 2026-09-25), cut into four levels with
// its story taken out — its own sentences wherever they explain, its examples, its jokes. The
// levels explain, in order: the embedding; what it lacks, the context; how a transformer reads
// one; Jev, which reads like one but judges instead of writing. The article's experiments with
// an LLM's hidden states (the plan, the causal mask's cost, tokens, the last layers, the other
// models tried) are left out: level 4 ends on what a hidden state is, level 5 opens on Jev
// (user-decided 2026-09-30). What else changed on the way, so a later edit does not undo it:
//   - the embedding is taught as the article tells it, SKIP-GRAM (from a word, guess the words
//     around it), and the game's own is said to have learned "de la même façon" — fastText's
//     CBOW is the same idea the other way round, not worth a detour (user-decided 2026-09-29);
//   - facts follow the CODE where the article and the pipeline differ: past the tournament's
//     200 the order is Jev's grade (the embedding only breaks ties), not the embedding's from
//     rank 300; a foreign word is sent down by a yes/no question to Jev, not by a frequency
//     rule; the rubric block quotes the code's own levels; a sentence's rank is Jev's order,
//     the embedding's only for a lone word;
//   - measurements are the ones the data holds: `étouffer` is 1 182nd once the consigne
//     excludes the sentence's own words (27th before; the article joined two entries), a 0,1 wobble moves a tail word by thousands of ranks, not a
//     hundred; the tournament rows are real Jev output (the spike's froidement run, whose note
//     already had `impassibilité` 6th), the static lists the game's own (gen:word's walk over
//     cc.fr.300, lemma display); `soigner` is only 18th for `traite` statically, so the level
//     names `ménager` and `dorloter` (2 037th and 2 096th);
//   - Jev's architecture stays a hedge, as in the article: TypeSafe does not publish it;
//   - the jokes about real people and parties stay in the article.
// Every example sentence is a published day's line, as in the article itself.
import type { Article } from './types';
import { frenchSpaces, typesetArticle } from './typeset';
import chat from '../scripts/fr.chat.json';

const SOURCE = {
  text: '« J’ai amélioré Cémantix avec une IA qui ne peut pas parler »',
  href: 'https://chqrles.me/cemantix/',
};

const distance: Article = {
  sections: [
    {
      blocks: [
        {
          p: 'Si le mot secret est `chat^0`, `chien^4` veut dire que `chien` est son quatrième plus proche voisin. Une distance, c’est une valeur numérique, donc il faut réussir à exprimer le sens des mots sous une forme numérique également. En gros, exprimer des informations complexes sous forme de nombres, ça a un nom, ça s’appelle un **embedding**. On pourrait par exemple donner des coordonnées aux mots, ce qui permettrait ensuite de mesurer facilement à quel point deux mots sont proches.',
        },
        {
          fig: {
            kind: 'plane',
            states: [
              [
                { word: 'chat', x: 1.5, y: 3.2 },
                { word: 'chien', x: 3, y: 3.6 },
                { word: 'loup', x: 4.6, y: 1.6 },
              ],
            ],
            edges: [
              [0, 1],
              [1, 2],
              [0, 2],
            ],
          },
          caption: '`chat`, `chien` et `loup` sur un plan : deux coordonnées par mot, une distance par paire.',
        },
        {
          p: 'L’idée a l’air bonne, mais plus on ajoute de mots sur le plan, plus il devient difficile de les répartir intelligemment, et deux dimensions ne suffiront pas longtemps. On va donc passer de 2 à, mettons, 300 dimensions : 300 coordonnées par mot, qui forment son **vecteur**, une flèche qui part du centre de l’espace et pointe vers le mot. C’est beaucoup plus difficile à dessiner, mais nettement plus pratique pour ranger des centaines de milliers de mots. La vraie problématique se dessine enfin : comment choisir les 300 coordonnées de chaque mot ?',
        },
      ],
    },
    {
      heading: 'Deviner les voisins',
      blocks: [
        {
          p: 'On commence par attribuer un vecteur aléatoire à chaque mot. À ce stade, nos coordonnées ne veulent absolument rien dire, et pour leur donner un sens, on demande à un réseau de neurones quelque chose d’assez simple : à partir d’un mot, prédire ceux qui ont des chances d’apparaître autour. On lui donne `chat`, et il attribue une probabilité à tous les mots qu’il connaît. Comme tout est encore plus ou moins aléatoire, ses premières réponses ressemblent à ça :',
        },
        {
          fig: {
            kind: 'bars',
            rows: [
              ['verre', 5],
              ['drôle', 4.8],
              ['moteur', 4.6],
              ['clavicule', 4.5],
              ['septembre', 4.4],
              ['gratin', 4.3],
            ],
          },
          caption: 'Les premières prédictions du réseau autour de `chat`, quand ses vecteurs ne veulent encore rien dire.',
        },
        {
          p: 'Il faut maintenant trouver un moyen de lui expliquer qu’il raconte n’importe quoi. Pour ça, on constitue un grand corpus de référence, des milliards de phrases écrites par des humains. Prenons une phrase ambitieuse de ce corpus :',
        },
        { sentence: ['Le `chat` mange une souris'] },
        {
          p: 'On choisit `chat` et on regarde ce qui apparaît autour : `le`, `mange`, `une`. Voilà ce que le réseau est censé prédire. S’il juge `moteur` beaucoup plus probable que `mange`, il s’est manifestement trompé. Reste à quantifier à quel point : on résume l’ensemble de ses erreurs dans un score qu’on appelle la **loss**. Plus elle est élevée, plus ses prédictions sont mauvaises.',
        },
        {
          p: 'On sait maintenant mesurer le problème, mais pas encore le corriger. Le réseau contient énormément de **paramètres**, des nombres qu’il peut ajuster, parmi lesquels les coordonnées de nos mots, et il faut savoir lesquels bouger et dans quel sens. Pour chacun, on calcule donc l’effet qu’aurait une toute petite modification sur la loss. En gros, on répond à la question :',
        },
        { quote: 'Si je modifie très légèrement cette coordonnée, est-ce que la loss augmente ou diminue, et de combien ?' },
        {
          p: 'Toutes ces variations forment un **gradient** : un vecteur qui indique la direction dans laquelle la loss augmenterait le plus. On fait donc quelque chose de très sophistiqué : on va dans l’autre sens. On modifie légèrement les paramètres, on refait une prédiction, on recalcule l’erreur, puis on recommence. C’est la **descente de gradient**.',
        },
        {
          fig: {
            kind: 'loop',
            steps: [
              'prédiction',
              'comparaison avec le vrai contexte',
              'calcul de la loss',
              'calcul des gradients',
              'légère modification des vecteurs',
            ],
          },
          caption: 'Et on recommence, quelques milliards de fois.',
        },
      ],
    },
    {
      heading: 'Qui se ressemble s’assemble',
      blocks: [
        {
          p: 'Après seulement quelques milliards de répétitions, la loss commence à descendre sérieusement. Mais ce qui nous intéresse surtout, c’est ce que toutes ces corrections ont fait aux coordonnées. Imaginons que le réseau rencontre régulièrement ce genre de phrases :',
        },
        {
          sentence: [
            'Le `chat` dort sur le canapé',
            'Le `chien` dort sur le tapis',
            'Je donne à manger à mon `chat`',
            'Je donne à manger à mon `chien`',
            'Le `chat` court dans le jardin',
            'Le `chien` court dans le jardin',
          ],
        },
        {
          p: '`chat` et `chien` vivent manifestement des vies assez similaires. Ils dorment, mangent, courent, donc ils apparaissent entourés de mots comparables. Pour réussir à prédire leurs contextes, le réseau finit donc par leur attribuer des vecteurs qui se ressemblent. Personne ne lui a expliqué qu’un chat et un chien étaient deux animaux domestiques relativement proches. D’ailleurs, il ne sait toujours pas ce qu’est un chat. Il a simplement constaté que `chat` traîne souvent avec les mêmes mots que `chien`, et ça suffit.',
        },
        {
          p: 'À force de corrections, les vecteurs aléatoires du départ s’organisent : les mots employés dans des contextes similaires occupent des régions similaires de l’espace à 300 dimensions. À la fin de l’entraînement, on garde ces coordonnées : on vient de créer un embedding.',
        },
      ],
    },
    {
      heading: 'Le rang',
      blocks: [
        {
          p: 'Celui du jeu a appris de la même façon, sur des milliards de mots tirés du web et de Wikipédia.',
        },
        {
          p: 'Pour mesurer la proximité de deux mots, le jeu ne regarde pas la distance entre leurs points, mais l’angle entre leurs vecteurs : deux vecteurs qui pointent dans la même direction désignent des mots très proches, peu importe leur longueur. C’est la **similarité cosinus**.',
        },
        {
          p: 'Pour chaque mot secret, le jeu mesure cet angle avec chacun des quelque 130 000 mots qu’il connaît, les trie du plus proche au plus lointain et garde les 10 000 premiers. Un mot qui n’y figure pas n’a pas de rang : c’est un MISS. Pour un mot seul, le rang, c’est la place dans cette liste. Voici le début de celle de `chat` :',
        },
        {
          fig: { kind: 'ranks', board: chat, take: 12, more: ['renard', 'souris', 'loup'] },
          caption: 'Les voisins de `chat` dans l’embedding du jeu. `loup` n’arrive qu’en 89e position : le plan du début était optimiste.',
        },
        {
          p: 'Les formes d’un même mot comptent pour un seul rang : `chien`, `chiens` et `chienne` sont tous `chien^4`. Et pas besoin de taper les accents : `felin` compte comme `félin^5`.',
        },
        { p: 'Cet embedding a pourtant un défaut de naissance que nous allons voir dans le niveau suivant.' },
      ],
    },
  ],
  source: SOURCE,
};

const meanings: Article = {
  sections: [
    {
      blocks: [
        {
          p: 'Le jeu prend une jolie phrase dans un livre ou une chanson, cache trois mots, et il faut les retrouver. Sauf que l’embedding a un défaut de naissance : il est **statique**. Il attribue un seul vecteur à chaque mot, quelle que soit la phrase. Or un mot n’a pas qu’un seul sens.',
        },
        {
          p: 'Pendant l’entraînement, `voler` a traîné aussi souvent avec des avions qu’avec des cambrioleurs, et son vecteur a fini quelque part entre les deux, dans un endroit qui n’est ni tout à fait le ciel ni tout à fait la poche des autres.',
        },
        {
          fig: {
            kind: 'plane',
            states: [
              [
                { word: 'planer', x: 0.7, y: 4.9 },
                { word: 'envoler', x: 1.2, y: 3.9 },
                { word: 'voler', x: 3, y: 3, focus: true },
                { word: 'dérober', x: 4.8, y: 2.1, label: 'below' },
                { word: 'chaparder', x: 5.3, y: 0.9, label: 'below' },
              ],
            ],
            edges: [
              [1, 2],
              [2, 3],
            ],
          },
          caption: 'Un seul point pour deux sens : `voler`, à mi-chemin entre le ciel et les cambrioleurs.',
        },
        {
          p: 'Tant qu’on devine un mot seul, sans phrase, comme dans Cémantix ou au premier niveau de ce tutoriel, ce flou n’est pas vraiment un problème : le mot à trouver n’a lui-même aucun sens précis.',
        },
      ],
    },
    {
      heading: 'Ceux qui volent',
      blocks: [
        { p: 'Mais prenons cette phrase :' },
        { sentence: ['Ne crains plus jamais le vide, c’est le refuge de ceux qui `volent`'] },
        { p: 'Ici, aucun cambrioleur. Pourtant, voici les voisins de `volent` selon l’embedding :' },
        {
          fig: {
            kind: 'words',
            lists: [
              {
                words: [
                  'tournoyer',
                  'tuer',
                  'virevolter',
                  'tomber',
                  'survoler',
                  'envoler',
                  'planquer',
                  'perdre',
                  'détruire',
                  'écraser',
                ],
                marked: ['tuer', 'planquer', 'perdre', 'détruire', 'écraser'],
                tone: 'wrong',
              },
            ],
          },
          caption: 'Les dix plus proches voisins de `volent` selon l’embedding. En couleur, ceux qui n’ont rien à faire dans le ciel.',
        },
        {
          p: 'La moitié de la liste dans le ciel, l’autre moitié dans la rubrique faits divers. Prenons un autre exemple, plus subtil :',
        },
        {
          fig: {
            kind: 'words',
            sentence: 'On me `traite` avec une douceur d’infirmière',
            lists: [{ words: ['aborder', 'documenter', 'consacrer', 'examiner', 'disséquer', 'disserter'] }],
          },
          caption: 'Parmi les plus proches voisins de `traite` selon l’embedding.',
        },
        {
          p: 'L’embedding a compris « traiter un sujet ». La phrase, elle, parle de traiter quelqu’un. Le joueur qui tape `ménager` ou `dorloter` a parfaitement compris la phrase. Pourtant, avec l’embedding seul, le jeu lui répondrait `ménager^2037` et `dorloter^2096`. De cette injustice naît la frustration, et la frustration, ça mène à la guerre.',
        },
        {
          p: 'Donner une phrase au joueur ne suffit donc pas. Il faut que le classement, lui aussi, lise la phrase. Reste à comprendre comment une machine peut lire une phrase : c’est l’objet du niveau suivant.',
        },
      ],
    },
  ],
  source: SOURCE,
};

const attention: Article = {
  sections: [
    {
      heading: 'Transformers',
      blocks: [
        {
          p: 'GPT et ses confrères, les grands modèles de langage ou **LLM**, sont principalement constitués d’une brique : le **Transformer**. Un Transformer reçoit les vecteurs des mots d’une phrase et les transforme, pour que chacun intègre des informations provenant des autres mots. Il suffit alors de faire passer la phrase à travers plusieurs couches de Transformers pour obtenir des vecteurs qui ne représentent plus seulement les mots eux-mêmes, mais les mots dans leur contexte.',
        },
        {
          p: 'Le mécanisme qui permet aux mots de récupérer de l’information les uns chez les autres s’appelle l’**attention**. Pour chaque mot, le Transformer fabrique trois nouveaux vecteurs à partir de sa représentation actuelle :',
        },
        {
          terms: [
            ['Q (query)', 'ce que je cherche'],
            ['K (key)', 'dans quels cas je peux être pertinent'],
            ['V (value)', 'l’information que je transmets si on m’écoute'],
          ],
        },
      ],
    },
    {
      heading: 'Le pigeon',
      blocks: [
        { p: 'Prenons la phrase suivante et intéressons-nous au mot `vole` :' },
        { sentence: ['Le pigeon `vole` dans le ciel'] },
        {
          p: 'Le Transformer reçoit son vecteur et en calcule la query. On peut imaginer qu’elle exprime quelque chose comme :',
        },
        { quote: 'Quelles informations du contexte sont importantes pour comprendre mon rôle ici ?' },
        {
          p: 'Les autres mots possèdent chacun une key. Pour savoir lesquels sont intéressants, le Transformer compare la query de `vole` à chaque key grâce à un **produit scalaire**. On l’a déjà croisé sans le dire : la similarité cosinus du niveau 2, c’est un produit scalaire entre deux vecteurs ramenés à une longueur de 1.',
        },
        {
          p: 'Ici, la longueur compte aussi. Mais à longueur égale, plus deux vecteurs pointent dans la même direction, plus le résultat est grand ; perpendiculaires, il vaut zéro ; opposés, il devient négatif. On s’en sert donc comme d’un score de compatibilité entre une query et une key, et ces scores sont ensuite ramenés à des pourcentages dont la somme fait 100 % (grâce à un softmax, pour les experts).',
        },
        {
          fig: {
            kind: 'arcs',
            tokens: ['Le', 'pigeon', 'vole', 'dans', 'le', 'ciel'],
            focus: 2,
            weights: [0.1, 0.9, null, null, null, null],
          },
          caption: 'La query de `vole` comparée aux keys de `Le` et de `pigeon` : `pigeon` l’emporte.',
        },
        {
          p: 'Et `ciel` ? Pendant l’attention, un mot ne peut écouter que ce qui le précède. On appelle ça le **masque causal**, et c’est logique : le modèle est entraîné à deviner la suite, on ne va pas la lui montrer.',
        },
        {
          p: 'Ces pourcentages servent à pondérer les values correspondantes, qui viennent enrichir le vecteur de `vole`.',
        },
        {
          fig: {
            kind: 'plane',
            tabs: ['Avant', 'Après'],
            states: [
              [
                { word: 'planer', x: 0.9, y: 4.2 },
                { word: 'vole', x: 2.6, y: 3.4, focus: true, label: 'below' },
                { word: 'dérober', x: 4.5, y: 2.9, label: 'below' },
              ],
              [
                { word: 'planer', x: 0.9, y: 4.2 },
                { word: 'vole', x: 1.5, y: 3.4, focus: true, label: 'below' },
                { word: 'dérober', x: 4.5, y: 2.9, label: 'below' },
              ],
            ],
            edges: [
              [0, 1],
              [1, 2],
            ],
          },
          caption: '`vole` avant et après l’attention : la value de `pigeon` le rapproche de `planer` et l’éloigne de `dérober`.',
        },
        {
          p: '`vole` vient ainsi d’intégrer beaucoup d’information provenant de `pigeon`, sans que le modèle ait reçu une règle écrite à la main disant :',
        },
        { quote: 'Si le sujet est un pigeon, alors vole signifie probablement se déplacer dans les airs.' },
        {
          p: 'Le modèle a simplement appris que, dans ce genre de contexte, ce que contient `pigeon` est très utile pour représenter correctement `vole`. Les matrices qui fabriquent Q, K et V, de grands tableaux de nombres, font elles-mêmes partie des paramètres du réseau : au début de l’entraînement, elles produisent n’importe quoi, puis elles sont ajustées par descente de gradient, comme les coordonnées de l’embedding.',
        },
      ],
    },
    {
      heading: 'Des dizaines de couches',
      blocks: [
        {
          p: 'Une fois l’attention terminée, chaque mot possède une nouvelle représentation, enrichie de ce qu’il a récupéré dans son contexte. Elle passe par un réseau de neurones plus classique, puis devient l’entrée de la couche suivante. Et on recommence quelques dizaines de fois. Une première couche peut apprendre une relation simple entre `pigeon` et `vole`, puis les suivantes partent de cette information déjà intégrée et construisent des représentations de plus en plus riches.',
        },
        {
          p: 'Pour entraîner un modèle comme GPT, on lui donne une tâche proche de celle de l’embedding : prédire la suite d’un texte. On lui montre « Le pigeon » et il doit prédire `vole`, puis « Le pigeon vole » et il doit prédire `dans`, et ainsi de suite sur des milliers de milliards de morceaux de texte. À chaque prédiction, on calcule la loss, puis les gradients, et on modifie légèrement tous les paramètres.',
        },
        {
          p: 'Depuis le début, on fait comme si un LLM lisait des mots. C’est faux. Il lit des **tokens**, des morceaux de texte choisis pour être réutilisables : un mot courant tient dans un seul token, un mot plus rare est découpé en plusieurs. Ce qu’il apprend à prédire, c’est donc le token suivant.',
        },
        {
          p: 'À force de prédire la suite de milliards de phrases, le modèle apprend quels mots doivent s’écouter et quelles informations doivent circuler entre eux. C’est ainsi qu’un immense empilement de Transformers, entraîné avec l’objectif assez basique de deviner le mot suivant, finit par construire quelque chose qui ressemble dangereusement à une compréhension fine du contexte.',
        },
      ],
    },
    {
      heading: 'Ouvrir le capot',
      blocks: [
        {
          p: 'À chaque couche, chaque mot possède donc un vecteur qui a écouté son contexte : son **hidden state**, son « état caché ». C’est exactement ce qui manquait à l’embedding statique : un vecteur qui a lu la phrase et qui fait la différence entre le vol du pigeon et le vol à l’étalage.',
        },
        {
          p: 'Dans l’utilisation normale d’un LLM, on ne regarde pas ces vecteurs : on laisse le modèle aller jusqu’au bout et on lit le texte qu’il produit. Toute cette lecture ne sert alors qu’à une chose : choisir le prochain token.',
        },
        {
          p: 'Le jeu, lui, n’a rien à écrire. Il lui faut un modèle qui lise aussi bien, mais qui réponde à une autre question : c’est l’objet du niveau suivant.',
        },
      ],
    },
  ],
  source: SOURCE,
};

const judge: Article = {
  sections: [
    {
      heading: 'Poser la question',
      blocks: [
        {
          p: 'Le jeu utilise **Jev**, un modèle de décision sorti en septembre 2026 par TypeSafe. TypeSafe n’en publie pas l’architecture, mais on peut se faire une assez bonne idée du principe : prendre un modèle capable de comprendre du texte, puis remplacer sa vocation d’écrivain par celle de juge. Un LLM classique termine son calcul en essayant de répondre à cette question :',
        },
        { quote: 'Quel token dois-je écrire ensuite ?' },
        {
          p: 'Un modèle de décision peut utiliser une représentation du même genre, mais terminer par une petite couche spécialisée, un **classifier**, qui répond plutôt à :',
        },
        { quote: 'Parmi ces réponses, laquelle semble correcte, et avec quelle probabilité ?' },
        {
          fig: {
            kind: 'flow',
            rows: [
              { name: 'LLM', steps: ['texte', 'représentation', 'probabilités sur le prochain token', 'texte'] },
              {
                name: 'Modèle de décision',
                steps: ['texte + question', 'représentation', 'classifier', 'probabilités sur les réponses proposées'],
                marked: [0, 2],
              },
            ],
          },
          caption: 'En simplifiant énormément : le même travail de lecture, une fin différente.',
        },
        {
          p: 'Le gros du travail reste le même : lire le langage, comprendre les relations entre les mots, construire une représentation du contexte. C’est seulement à la fin qu’on lui demande autre chose, et c’est précisément ce dont le jeu a besoin. Plutôt que d’espérer que des angles entre vecteurs répondent à notre question, on peut simplement la poser :',
        },
        { quote: 'Dans cette phrase, à quel point ce mot est-il proche de celui-là ?' },
      ],
    },
    {
      heading: 'Une note pour chaque candidat',
      blocks: [
        {
          p: 'L’embedding garde son rôle de rabatteur. Il fournit les 10 000 voisins du mot caché, sans se soucier du contexte, et chacun reçoit ensuite une note de Jev, de 0 à 4 :',
        },
        {
          code: [
            '0 : Aucun rapport de sens avec le mot secret tel qu’employé dans la phrase',
            '1 : Rapport lointain : même domaine très général, ou association vague',
            '2 : Lié : même champ lexical, idée voisine, ou souvent associé au mot secret dans ce sens',
            '3 : Très proche : quasi-synonyme, ou la même notion à une nuance près',
            '4 : Même sens : synonyme direct du mot secret dans ce contexte',
          ],
        },
        {
          p: 'Jev répond avec des décimales : un candidat obtient 3,26 plutôt que 3. La consigne est écrite en français ordinaire : seul le sens compte, pas la grammaire, pas l’orthographe, pas le fait que le candidat puisse remplacer le mot dans la phrase. Pour jouer, ça veut dire qu’il ne faut pas chercher ce qui irait bien dans le trou, mais ce qui veut dire la même chose. Par exemple :',
        },
        {
          fig: {
            kind: 'words',
            sentence: 'C’étaient donc des `nerfs` parfaits',
            tabs: true,
            lists: [
              { label: 'Seul', words: ['muscles', 'neurones', 'nerveux', 'intestins', 'reins'] },
              {
                label: 'Dans la phrase',
                words: ['nervosité', 'excitabilité', 'nerveux', 'énervement', 'irritable'],
                marked: ['nervosité', 'excitabilité', 'nerveux', 'énervement', 'irritable'],
                tone: 'right',
              },
            ],
          },
          caption: 'Les plus proches voisins de `nerfs` selon l’embedding seul, puis selon Jev dans sa phrase.',
        },
        {
          p: 'Jev a compris qu’on parlait de tempérament et pas de neurologie. La consigne dit aussi ce qui ne doit pas compter :',
        },
        {
          quote:
            'Un candidat qui figure dans la phrase, ou qui décrit ce que la phrase fait du mot secret (par exemple l’étouffer, le cacher, le perdre), n’est pas plus proche pour autant.',
        },
        {
          p: 'Dans « la force de fixer froidement le malheur, d’étouffer mes émotions », `étouffer` n’est pas un mot proche d’`émotions`, c’est un mot de la phrase : il n’arrive qu’au 1 182e rang. Avec un vecteur, on peut constater qu’un résultat est mauvais, mais pas lui expliquer pourquoi. Ici, si Jev se trompe pour une raison qu’on peut formuler, il suffit de le lui dire.',
        },
        {
          p: 'Tout ne se règle pas avec des mots pour autant. La consigne a beau donner la note la plus basse à un candidat qui n’est pas français, Jev l’ignore superbement : `retirement` restait premier voisin de `retraite`. Alors on lui pose une question à part pour chacun des 200 premiers : est-ce bien un mot français ? Un mot étranger, un nom propre ou une marque est envoyé tout en bas.',
        },
      ],
    },
    {
      heading: 'Un tournoi',
      blocks: [
        {
          p: 'Jev n’est pas parfaitement stable. Si on lui demande plusieurs fois de noter le même candidat, sa réponse varie d’environ 0,1 point. Au fond du classement, ça ne change pas grand-chose : le 7 400e mot peut devenir le 5 000e, et personne ne joue là-bas. En haut, c’est différent : c’est là que se joue la partie. Les notes y sont si serrées qu’une telle variation suffit à envoyer le 150e mot au 100e rang, ou au 200e. Jev sait donc assez bien quels mots méritent d’entrer dans les 200 premiers, mais beaucoup moins bien dans quel ordre les ranger.',
        },
        {
          p: 'Alors on organise un tournoi. Les 200 meilleurs candidats s’affrontent tous deux à deux, soit 19 900 duels, avec une seule question :',
        },
        { quote: 'Lequel de ces deux mots est le plus proche du mot secret dans cette phrase ?' },
        {
          p: 'Pour chaque duel, Jev donne une probabilité de victoire aux deux candidats. Le score d’un mot, c’est sa probabilité moyenne de victoire sur ses 199 duels.',
        },
        {
          p: 'Trier les mots demanderait beaucoup moins de comparaisons. Mais un tri suppose qu’on puisse faire confiance à la comparaison : si A bat B et B bat C, A doit battre C. Jev, lui, peut très bien répondre que C bat A. Dans un tri, une mauvaise comparaison peut envoyer un mot au mauvais endroit ; dans un tournoi complet, elle se retrouve diluée parmi 198 autres.',
        },
        {
          fig: {
            kind: 'tournament',
            labels: ['embedding', 'duels gagnés', 'rang'],
            rows: [
              { word: 'impassiblement', from: 271, win: 0.99 },
              { word: 'impassibilité', from: 2476, win: 0.977 },
              { word: 'sang-froid', from: 329, win: 0.976 },
              { word: 'imperturbablement', from: 755, win: 0.976 },
              { word: 'impassible', from: 668, win: 0.968 },
              { word: 'impavide', from: 790, win: 0.956 },
            ],
          },
          caption:
            'Le haut du tournoi pour `froidement`, dans la même phrase. L’embedding plaçait `impassibilité` au 2 476e rang, la note de Jev au 6e, le tournoi le met 2e.',
        },
      ],
    },
    {
      heading: 'Le rang, dans une phrase',
      blocks: [
        { p: 'Quand on tape un mot dans une phrase du jour, son rang sort donc de cette chaîne :' },
        {
          steps: [
            'l’embedding rabat les 10 000 plus proches voisins du mot caché ; hors de cette liste, c’est un MISS, même si la phrase rend le mot proche ;',
            'Jev note chacun d’eux selon le sens que la phrase donne au mot caché ;',
            'les 200 mieux notés s’affrontent en tournoi, qui fixe les rangs 1 à 200 ;',
            'un mot étranger qui s’est glissé parmi eux est envoyé tout en bas ;',
            'au-delà du 200e, c’est la note qui range les mots, et l’embedding départage les ex æquo ;',
            'les mots de départ affichés dans les trous sont choisis entre le 100e et le 200e rang.',
          ],
        },
        {
          p: 'Tout ça une fois pour toutes, avant la sortie de la phrase : pendant la partie, les rangs sont déjà écrits. Personne ne s’en rendra compte, mais maintenant vous le savez.',
        },
      ],
    },
    {
      heading: 'Pourquoi ça marche ?',
      blocks: [
        {
          p: 'Il faut quand même rendre justice aux LLM : rien de tout ça ne semble hors de leur portée. On pourrait prendre un bon modèle, lui montrer la phrase et deux candidats, puis lui demander lequel est le plus proche du mot secret : il répondrait probablement très bien. Le problème, c’est qu’il faudrait lui poser la question des dizaines de milliers de fois, et une idée parfaitement raisonnable sur le papier devient beaucoup moins séduisante quand chaque petite décision coûte quelques secondes et une requête à un gros modèle.',
        },
        {
          p: 'Jev ne sait rien faire qu’un LLM serait incapable de faire, mais il prend une petite décision de sens extrêmement vite et pour presque rien : pour un mot secret, tout ça coûte à peu près 0,13 $. On peut donc se permettre une stratégie d’une brutalité remarquable : faire noter 10 000 candidats un par un, garder les 200 meilleurs, puis organiser 19 900 duels supplémentaires juste pour mieux les ranger. Jev est suffisamment bon marché pour qu’on lui pose trente mille fois la question.',
        },
      ],
    },
  ],
  source: SOURCE,
};

const fr = (article: Article) => typesetArticle(article, frenchSpaces);

export const FR_ARTICLES: Record<number, Article> = {
  2: fr(distance),
  3: fr(meanings),
  4: fr(attention),
  5: fr(judge),
};
