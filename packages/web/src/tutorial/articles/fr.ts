// THE FRENCH ARTICLE LEVELS: the author's article « J’ai amélioré Cémantix avec une IA qui ne
// peut pas parler » (chqrles.me/cemantix), cut into four levels with its story taken out. The
// levels explain, in order: the embedding; what it lacks, the context; how a transformer reads
// one; Jev, which reads like one but judges instead of writing. The article's experiments with
// an LLM's hidden states are not told: level 4 ends on one paragraph that links to them.
//
// HOW IT WORKS, NEVER THE JOURNEY (user-decided): the levels say how the game works — never
// how it was tried, what did not work, or how it was made to work.
// THE ARTICLE'S OWN WORDS, NOT A COMMA CHANGED (user-decided): a paragraph the article has is
// used exactly as the article prints it, punctuation and markup included. A sentence changes
// only where the level cannot use it as it is, and every change is one of these:
//   - it tells the journey, or points into the story that was cut: the clause goes, the game
//     takes Cémantix's place, or the sentence says the rule instead of how it was found (the
//     consigne's line on the sentence's own words, the foreign-word question);
//   - the game's code or data says otherwise: `étouffer` was 27th (the article joined two
//     entries), a 0,1 wobble moves a tail word by thousands of ranks, the notes had
//     `impassibilité` 6th and `fascination` 81st, past the tournament's 200 the order is Jev's
//     note, a foreign word is sent down by a yes/no question to Jev, the embedding (not today's
//     game) answers `dorloter`, and `soigner` is only 18th for `traite` statically (so
//     `dorloter`);
//   - a joke about a real person or party, replaced.
// Level 2's first and last sentences and level 4's last paragraph are the author's own,
// written for the level. Figures redraw the article's, under its caption where it has one;
// where they show numbers they are the game's (the static lists are gen:word's walk over
// cc.fr.300, the tournament rows real Jev output). Every example sentence is a published
// day's line, as in the article itself.
import type { Article } from './types';
import { frenchSpaces, typesetArticle } from './typeset';

const SOURCE = {
  text: '« J’ai amélioré Cémantix avec une IA qui ne peut pas parler »',
  href: 'https://chqrles.me/cemantix/',
};

const distance: Article = {
  sections: [
    {
      blocks: [
        {
          p: 'Comment le jeu peut calculer la distance entre le sens des mots? Une distance, c’est une valeur numérique, donc il faut réussir à exprimer le sens des mots sous une forme numérique également. En gros, exprimer des informations complexes sous forme de nombres, ça a un nom, ça s’appelle un **embedding**. On pourrait par exemple donner des coordonnées aux mots, ce qui permettrait ensuite de mesurer facilement à quel point deux mots sont proches.',
        },
        {
          fig: {
            kind: 'plane',
            states: [
              [
                { word: 'chat', x: 1.5, y: 3.2 },
                { word: 'chien', x: 3, y: 3.6 },
                { word: 'loup', x: 4.6, y: 1.6, label: 'below' },
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
          p: 'L’idée a l’air bonne, mais plus on ajoute de mots sur notre plan, plus il devient difficile de les répartir intelligemment, et deux dimensions ne suffiront pas longtemps. On va donc passer de 2 à, mettons, 300 dimensions. C’est beaucoup plus difficile à dessiner, mais nettement plus pratique pour ranger des centaines de milliers de mots. La vraie problématique se dessine enfin. Comment choisir les 300 coordonnées de chaque mot ?',
        },
      ],
    },
    {
      heading: 'Skip-gram / word2vec',
      blocks: [
        {
          p: 'On commence par attribuer un vecteur aléatoire à chaque mot. À ce stade, nos coordonnées ne veulent absolument rien dire, et pour leur donner un sens on va demander au réseau de faire quelque chose d’assez simple : à partir d’un mot, prédire ceux qui ont des chances d’apparaître autour. On lui donne `chat` et il attribue une probabilité à tous les mots qu’il connaît. Comme tout est encore plus ou moins aléatoire, ses premières réponses ressemblent à ça :',
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
          p: 'Il faut maintenant trouver un moyen de lui expliquer qu’il raconte n’importe quoi. Pour ça, on constitue un grand corpus de référence à partir de textes soigneusement sélectionnés : des livres, des pages Wikipédia, des articles universitaires, par exemple.\nMaintenant prenons une phrase ambitieuse de notre corpus :',
        },
        { sentence: ['Le `chat` mange une souris'] },
        {
          p: 'On choisit `chat` et on regarde ce qui apparaît autour : `le`, `mange`, `une`. Voilà ce que le réseau est censé prédire. S’il considère `moteur` comme beaucoup plus probable que `mange`, il s’est manifestement trompé. Reste à quantifier à quel point, alors on résume l’ensemble de ses erreurs dans un score qu’on appelle la **loss** : plus elle est élevée, plus ses prédictions sont mauvaises.',
        },
        {
          p: 'On sait maintenant mesurer le problème, mais pas encore le corriger. Le réseau contient énormément de paramètres, parmi lesquels les coordonnées de nos vecteurs, et il faut savoir lesquels bouger et dans quel sens. Pour chacun, on calcule donc l’effet qu’aurait une toute petite modification sur la loss. En gros pour chaque vecteur on répond à la question :',
        },
        {
          quote:
            'Si je modifie très légèrement cette coordonnée, est-ce que la loss augmente ou diminue, et de combien ?',
        },
        {
          p: 'L’ensemble de ces variations forme le **gradient**, un vecteur qui indique la direction dans laquelle la loss augmenterait le plus, donc on fait quelque chose de très sophistiqué : on va dans l’autre sens. On modifie légèrement les paramètres, on refait une prédiction, on recalcule l’erreur, puis on recommence. C’est la **descente de gradient**.',
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
        {
          p: 'Après "seulement" quelques milliards de répétitions, la loss commence à descendre sérieusement. Mais ce qui nous intéresse surtout, c’est ce que toutes ces corrections ont fait à nos vecteurs. Imaginons que le réseau rencontre régulièrement ce genre de phrases :',
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
          p: '`chat` et `chien` vivent manifestement des vies assez similaires. Ils `dorment`, `mangent`, `courent` donc ils apparaissent entourés de mots comparables. Pour réussir à prédire leurs contextes, le réseau finit donc par leur attribuer des représentations qui se ressemblent. Personne ne lui a expliqué qu’un chat et un chien étaient deux animaux domestiques relativement proches. D’ailleurs, il ne sait toujours pas ce qu’est un chat. Il a simplement constaté que `chat` traîne souvent avec les mêmes mots que `chien`, et ça suffit.',
        },
        {
          p: 'À force de corriger ses prédictions, les vecteurs complètement aléatoires du départ finissent ainsi par s’organiser. Les mots utilisés dans des contextes similaires occupent des régions similaires de notre espace à 300 dimensions. À la fin de l’entraînement, on récupère ces vecteurs et on les utilise directement comme coordonnées sémantiques de nos mots : on vient de créer un **embedding**.',
        },
        {
          p: 'Cet embedding a pourtant un défaut de naissance que nous allons voir dans le niveau suivant.',
        },
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
          p: 'Notre embedding a un défaut de naissance, il est **statique** : il attribue un seul vecteur à chaque mot, quelle que soit la phrase. Or un mot n’a pas qu’un seul sens. Pendant l’entraînement, `voler` a traîné aussi souvent avec des avions qu’avec des cambrioleurs, et son vecteur a fini quelque part entre les deux, dans un endroit qui n’est ni tout à fait le ciel ni tout à fait la roue avant de mon vélo.',
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
                { word: 'chaparder', x: 5.0, y: 0.9, label: 'below' },
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
          p: 'Tant qu’on devine un mot sans contexte, ce flou n’est pas vraiment un problème, puisque le mot à trouver n’a lui-même aucun sens précis. Mais prenons cette phrase :',
        },
        { sentence: ['Ne crains plus jamais le vide, c’est le refuge de ceux qui `volent`'] },
        {
          p: 'Ici, aucun cambrioleur. Pourtant, voici les voisins de `volent^0` selon l’embedding :',
        },
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
          caption: 'Les dix plus proches voisins de `volent^0` selon l’embedding. En couleur, ceux qui n’ont rien à faire dans le ciel.',
        },
        {
          p: 'La moitié de la liste dans le ciel, l’autre moitié dans la rubrique faits divers. Mais prenons un autre exemple, plus subtil :',
        },
        {
          fig: {
            kind: 'words',
            sentence: 'On me `traite` avec une douceur d’infirmière',
            lists: [{ words: ['aborder', 'documenter', 'consacrer', 'examiner', 'disséquer', 'disserter'] }],
          },
          caption: 'Parmi les plus proches voisins de `traite^0` selon l’embedding.',
        },
        {
          p: 'L’embedding a compris « traiter un sujet ». La phrase, elle, parle de traiter quelqu’un. Le joueur qui tape `dorloter` ou `ménager` a parfaitement compris la phrase, pourtant l’embedding lui répond qu’il en est loin. De cette injustice naît la frustration, et la frustration, ça mène à la guerre. Alors donner une phrase au joueur ne suffit pas. Il faut que l’embedding, lui aussi, lise la phrase.',
        },
      ],
    },
  ],
  source: SOURCE,
};

const attention: Article = {
  sections: [
    {
      blocks: [
        {
          p: 'Malgré l’immensité de l’univers, il n’y a à notre connaissance que deux types d’êtres capables de comprendre le langage humain. Les humains eux-mêmes, et depuis peu, GPT et ses confrères, les LLM. Le second présente également l’avantage de mieux manipuler les vecteurs à 300 dimensions, on va donc se tourner vers lui.',
        },
      ],
    },
    {
      heading: 'Transformers',
      blocks: [
        {
          p: 'Avant de parler d’un LLM complet, commençons par la brique dont il est principalement constitué, le **Transformer**. On a vu comment représenter des mots sous la forme de vecteurs. Un Transformer reçoit plusieurs de ces vecteurs et les transforme pour que chacun puisse intégrer des informations provenant des autres mots de la phrase. Il suffit alors de faire passer une phrase à travers plusieurs couches de Transformers pour obtenir des vecteurs qui ne représentent plus seulement les mots eux-mêmes, mais les mots dans leur contexte. Sur le papier, les Transformers semblent être l’outil idéal pour résoudre notre problème.',
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
        { p: 'Prenons la phrase suivante et intéressons-nous au mot `vole` :' },
        { sentence: ['Le pigeon `vole` dans le ciel'] },
        {
          p: 'Le Transformer reçoit son vecteur et en calcule la **Q (query)**. On peut imaginer qu’elle exprime quelque chose comme :',
        },
        { quote: 'Quelles informations du contexte sont importantes pour comprendre mon rôle ici ?' },
        {
          p: 'Les autres mots possèdent de leur côté une **K (key)**, et pour déterminer lesquels sont intéressants, le Transformer compare la query de `vole` aux différentes keys grâce à un **produit scalaire**. Le produit scalaire dépend à la fois de la longueur des deux vecteurs et de l’angle qui les sépare. À longueur égale, plus ils pointent dans la même direction, plus le résultat est grand, perpendiculaires, on obtient zéro et dans des directions opposées, on passe dans le négatif. On peut donc l’utiliser comme un score de compatibilité entre une **Q (query)** et une **K (key)**, et ces scores sont ensuite ramenés à des pourcentages dont la somme fait 100 % (grâce à un softmax pour les experts).',
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
          p: 'Ces pourcentages servent à pondérer les **values** correspondantes, qui viennent enrichir le vecteur de `vole`.',
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
          p: 'Le modèle a simplement appris que, dans ce genre de contexte, les informations contenues dans `pigeon` sont très utiles pour représenter correctement `vole`. Les matrices qui fabriquent Q, K et V sont elles-mêmes des paramètres du réseau. Au début de l’entraînement, elles produisent essentiellement n’importe quoi, puis elles sont progressivement ajustées par **descente de gradient**, comme nos **embeddings**.',
        },
        {
          p: 'Une fois l’attention terminée, chaque mot possède une nouvelle représentation, enrichie par ce qu’il a récupéré dans son contexte. Elle passe ensuite par un réseau de neurones plus classique, puis devient l’entrée de la couche Transformer suivante. Et on recommence quelques dizaines de fois. À chaque couche, de nouveaux Q, K et V sont calculés à partir des représentations produites par la précédente. Une première couche peut apprendre une relation relativement simple entre `pigeon` et `vole`, puis les suivantes travaillent à partir de cette information déjà intégrée et construisent progressivement des représentations plus riches.',
        },
        {
          p: 'Pour entraîner un modèle comme GPT, on lui donne une tâche assez proche de celle qu’on a utilisée pour les embeddings, prédire la suite d’un texte. On lui montre par exemple `Le pigeon` et il doit prédire `vole`, puis `Le pigeon vole` et il doit prédire `dans`, et ainsi de suite sur des milliards de morceaux de texte. À chaque prédiction, on calcule la **loss**, puis les **gradients**, et on modifie légèrement tous les paramètres. À force de prédire la suite de milliards de phrases, le modèle apprend progressivement quels mots doivent s’écouter et quelles informations doivent circuler entre eux. C’est ainsi qu’un immense empilement de couches Transformer, entraîné avec l’objectif assez basique de deviner le mot suivant, finit par construire quelque chose qui ressemble dangereusement à une compréhension fine du contexte.',
        },
        {
          p: 'On pourrait alors utiliser les Transformers d’un LLM pour modifier les vecteurs de nos mots en fonction de leur contexte. Mais en pratique ça ne marche pas très bien pour plusieurs raisons détaillées dans [cet article](https://chqrles.me/cemantix/#ouvrir-le-capot). Pour résoudre notre problème on va effectivement utiliser des Transformers mais pas de LLM.',
        },
      ],
    },
  ],
  source: SOURCE,
};

const judge: Article = {
  sections: [
    {
      heading: 'La solution : arrêter de mesurer, poser la question',
      blocks: [
        {
          p: 'Le jeu utilise **Jev**, un modèle de décision sorti en septembre 2026 par TypeSafe. Alors de quoi est fait ce fameux modèle ? On ne sait pas exactement, TypeSafe parle d’une nouvelle architecture sans en publier les détails. Mais on peut quand même se faire une assez bonne idée du principe. Prendre un modèle capable de comprendre du texte, puis remplacer sa vocation d’écrivain par celle de juge. Un LLM classique termine son calcul en essayant de répondre à cette question :',
        },
        { quote: 'Quel mot dois-je écrire ensuite ?' },
        {
          p: 'Un modèle de décision peut utiliser une représentation du même genre, mais terminer par une petite couche spécialisée, un **classifier**, qui répond plutôt à :',
        },
        { quote: 'Parmi ces réponses, laquelle semble correcte, et avec quelle probabilité ?' },
        { p: 'En simplifiant énormément, ça donne quelque chose comme :' },
        {
          fig: {
            kind: 'flow',
            rows: [
              { name: 'LLM', steps: ['texte', 'représentation', 'probabilités sur le prochain mot', 'texte'] },
              {
                name: 'Modèle de décision',
                steps: ['texte + question', 'représentation', 'classifier', 'probabilités sur les réponses proposées'],
                marked: [0, 2],
              },
            ],
          },
          caption: 'Le même travail de lecture, une fin différente.',
        },
        {
          p: 'Le gros du travail reste le même : lire le langage, comprendre les relations entre les mots et construire une représentation du contexte. C’est seulement à la fin qu’on lui demande autre chose, et c’est précisément ce dont on a besoin. On peut simplement poser la question :',
        },
        { quote: 'Dans cette phrase, à quel point ce mot est-il proche de celui-là ?' },
      ],
    },
    {
      heading: 'Une note pour chaque candidat',
      blocks: [
        {
          p: 'L’embedding garde son rôle de rabatteur. Il fournit les 10 000 voisins du mot caché, sans se soucier du contexte, et chacun reçoit ensuite une note de Jev :',
        },
        {
          code: [
            '0 : aucun rapport de sens avec le mot secret tel qu’employé dans la phrase',
            '1 : rapport lointain, même domaine très général',
            '2 : lié, même champ lexical ou idée voisine',
            '3 : très proche, quasi-synonyme',
            '4 : même sens, synonyme direct dans ce contexte',
          ],
        },
        {
          p: 'La consigne est écrite en français ordinaire : seul le sens compte, pas la grammaire, pas l’orthographe, pas le fait que le candidat puisse remplacer le mot dans la phrase. Prenons `nerfs^0` :',
        },
        {
          fig: {
            kind: 'words',
            sentence: 'C’étaient donc des `nerfs` parfaits',
            tabs: true,
            lists: [
              { label: 'Embedding', words: ['muscles', 'neurones', 'nerveux', 'intestins', 'reins'] },
              {
                label: 'Jev',
                words: ['nervosité', 'excitabilité', 'nerveux', 'énervement', 'irritable'],
                marked: ['nervosité', 'excitabilité', 'nerveux', 'énervement', 'irritable'],
                tone: 'right',
              },
            ],
          },
          caption: 'Parmi les plus proches voisins de `nerfs^0` selon l’embedding seul, puis selon Jev dans sa phrase.',
        },
        {
          p: 'Jev a compris qu’on parlait de tempérament et pas de neurologie. Prenons une nouvelle phrase :',
        },
        { sentence: ['la force d’étouffer mes `émotions`'] },
        {
          p: '`étouffer` n’est pas un mot proche d’`émotions^0`, c’est un mot de la phrase. Jev le classerait pourtant 27e sans cette ligne de la consigne :',
        },
        {
          quote:
            'Un candidat qui figure dans la phrase, ou qui décrit ce que la phrase fait du mot secret, n’est pas plus proche pour autant.',
        },
        {
          p: 'Avec elle, il tombe à la 1 182e place. Si Jev se trompe pour une raison que je peux formuler, je peux simplement lui dire.',
        },
        {
          p: 'Les mots étrangers, eux, passent par une autre question, posée à part pour chacun des 200 premiers : est-ce bien un mot français ? Un mot qui échoue est renvoyé tout en bas, sans quoi `retirement` serait le premier voisin de `retraite^0`.',
        },
      ],
    },
    {
      heading: 'Un tournoi pour départager les vainqueurs',
      blocks: [
        {
          p: 'Jev n’est pas parfaitement stable. Si je lui demande plusieurs fois de noter le même candidat, sa réponse peut varier d’environ 0,1 point. Au fond du classement, ça ne change pas grand-chose. Le 7 400e mot peut devenir le 5 000e, ça ne bouleversera pas le jeu. En haut du classement, c’est différent. C’est là que l’ordre compte le plus, et si les mots classés 50e et 150e ont des notes presque identiques, une telle variation suffit à les rendre interchangeables. Jev sait donc assez bien quels mots méritent d’entrer dans les 200 premiers, mais beaucoup moins bien dans quel ordre les ranger.',
        },
        {
          p: 'Alors on va organiser un tournoi. Les 200 meilleurs candidats s’affrontent tous deux à deux, soit 19 900 duels, avec une seule question :',
        },
        { quote: 'Lequel de ces deux mots est le plus proche du mot secret dans cette phrase ?' },
        {
          p: 'Pour chaque duel, Jev donne une probabilité de victoire aux deux candidats, et le score final d’un mot est simplement sa probabilité moyenne de victoire sur l’ensemble de ses confrontations. Un algorithme de tri classique demanderait beaucoup moins de comparaisons. Mais un tri suppose qu’on puisse faire confiance à la fonction qui compare deux éléments. Si `A > B` et `B > C`, on aimerait raisonnablement pouvoir en déduire que `A > C`. Jev, lui, peut très bien répondre que `A < C`, il n’est ni parfaitement déterministe, ni parfaitement transitif. Dans un tri classique, une mauvaise comparaison pourrait envoyer un mot au mauvais endroit et influencer toute la suite. Dans un tournoi complet, chaque candidat affronte les 199 autres, et s’il prend une décision étrange, elle se retrouve diluée parmi 198 autres confrontations.',
        },
        {
          p: 'Pour le mot secret `froidement^0`, `impassibilité` passe de la 6e à la 2e place. Pour `beauté^0`, `fascination` remonte de la 81e à la 13e.',
        },
        {
          fig: {
            kind: 'tournament',
            labels: ['rang à la note', 'victoire moyenne', 'rang au tournoi'],
            rows: [
              { word: 'impassiblement', from: 1, win: 0.99 },
              { word: 'impassibilité', from: 6, win: 0.977 },
              { word: 'sang-froid', from: 2, win: 0.976 },
              { word: 'imperturbablement', from: 3, win: 0.976 },
              { word: 'impassible', from: 4, win: 0.968 },
              { word: 'impavide', from: 7, win: 0.956 },
            ],
          },
          caption: 'Le haut du tournoi pour `froidement^0`.',
        },
        {
          p: 'Enfin, au-delà du 200e rang, je conserve simplement l’ordre des notes de Jev. Personne ne s’en rendra compte, mais maintenant vous le savez.',
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
