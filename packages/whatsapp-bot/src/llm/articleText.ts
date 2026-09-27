// THE ARTICLE, VERBATIM (user-decided 2026-09-27): the text published at ARTICLE_URL, its
// interactive figures written out as one bracketed line each and the one paragraph the page
// prints twice kept once. Nothing else is edited. When the article changes, this copy is
// taken again from the page — the bot's bible is the published text, not a summary of it.
export const ARTICLE_TEXT = `J’ai amélioré Cémantix avec une IA qui ne peut pas parler

25 septembre 2026

Parmi les différentes manières que j’ai trouvées de perdre du temps devant un écran, il y a les jeux daily. L’un d’entre eux s’appelle Cémantix.

Chaque jour, un mot est tiré au hasard et il faut le deviner à l’aide d’un chaud-froid sémantique. Au début, on tape des mots aléatoires, puis on finit par avoir de la chance et tomber sur un mot plus proche que les autres. Alors on remonte la piste en testant des mots similaires jusqu’à retrouver le mot du jour. Le jeu est amusant mais répétitif, et trouver le bon mot demande parfois des centaines d’essais avec, à la clé, une récompense pas toujours à la hauteur de l’effort. « Bravo, vous avez trouvé le mot vestiaire en 245 essais, à demain. » J’étais censé me divertir et oublier ma condition de mortel. Au final, Cémantix a surtout amplifié ma perception du temps perdu et de la vacuité de mon existence. Merci Cémantix.

À la manière de l’électron qui se trouve partout à la fois tant qu’on ne le mesure pas, un mot seul porte tous ses sens tant qu’on ne l’utilise pas. La valeur sémantique d’un mot seul ne suffit pas à comprendre ce qu’il exprime, c’est peut-être ce qui manque à Cémantix. Reste à trouver comment mesurer la distance sémantique entre les mots en fonction de leur contexte.

## 1. Embedding

Étudions déjà comment Cémantix calcule la distance entre les mots. Une distance, c’est une valeur numérique, donc il faut réussir à exprimer le sens des mots sous une forme numérique également. En gros, exprimer des informations complexes sous forme de nombres, ça a un nom, ça s’appelle un embedding. On pourrait par exemple donner des coordonnées aux mots, ce qui permettrait ensuite de mesurer facilement à quel point deux mots sont proches.

[Figure : chat, chien et loup sur un plan : deux coordonnées par mot, une distance par paire.]

L’idée a l’air bonne, mais plus on ajoute de mots sur notre plan, plus il devient difficile de les répartir intelligemment, et deux dimensions ne suffiront pas longtemps. On va donc passer de 2 à, mettons, 300 dimensions. C’est beaucoup plus difficile à dessiner, mais nettement plus pratique pour ranger des centaines de milliers de mots. La vraie problématique se dessine enfin. Comment choisir les 300 coordonnées de chaque mot ?

### Skip-gram / word2vec

On commence par attribuer un vecteur aléatoire à chaque mot. À ce stade, nos coordonnées ne veulent absolument rien dire, et pour leur donner un sens on va demander au réseau de faire quelque chose d’assez simple : à partir d’un mot, prédire ceux qui ont des chances d’apparaître autour. On lui donne chat et il attribue une probabilité à tous les mots qu’il connaît. Comme tout est encore plus ou moins aléatoire, ses premières réponses ressemblent à ça :

[Figure : les premières prédictions du réseau autour de « chat », quand ses vecteurs ne veulent encore rien dire : verre 5,0 %, drôle 4,8 %, moteur 4,6 %, clavicule 4,5 %, septembre 4,4 %, gratin 4,3 %.]

Il faut maintenant trouver un moyen de lui expliquer qu’il raconte n’importe quoi. Pour ça, on constitue un grand corpus de référence à partir de textes soigneusement sélectionnés : des livres, des pages Wikipédia, des articles universitaires, par exemple.
Maintenant prenons une phrase ambitieuse de notre corpus :

Le chat mange une souris

On choisit chat et on regarde ce qui apparaît autour : le, mange, une. Voilà ce que le réseau est censé prédire. S’il considère moteur comme beaucoup plus probable que mange, il s’est manifestement trompé. Reste à quantifier à quel point, alors on résume l’ensemble de ses erreurs dans un score qu’on appelle la loss : plus elle est élevée, plus ses prédictions sont mauvaises.

On sait maintenant mesurer le problème, mais pas encore le corriger. Le réseau contient énormément de paramètres, parmi lesquels les coordonnées de nos vecteurs, et il faut savoir lesquels bouger et dans quel sens. Pour chacun, on calcule donc l’effet qu’aurait une toute petite modification sur la loss. En gros pour chaque vecteur on répond à la question :

> Si je modifie très légèrement cette coordonnée, est-ce que la loss augmente ou diminue, et de combien ?

Chacune de ces variations forme un gradient. Un vecteur qui indique la direction dans laquelle la loss augmenterait le plus, donc on fait quelque chose de très sophistiqué : on va dans l’autre sens. On modifie légèrement les paramètres, on refait une prédiction, on recalcule l’erreur, puis on recommence. C’est la descente de gradient.

[Figure : prédiction → comparaison avec le vrai contexte → calcul de la loss → calcul des gradients → légère modification des vecteurs, et on recommence.]

Après seulement quelques milliards de répétitions, la loss commence à descendre sérieusement. Mais ce qui nous intéresse surtout, c’est ce que toutes ces corrections ont fait à nos vecteurs. Imaginons que le réseau rencontre régulièrement ce genre de phrases :

Le chat dort sur le canapé
Le chien dort sur le tapis

Je donne à manger à mon chat
Je donne à manger à mon chien

Le chat court dans le jardin
Le chien court dans le jardin

chat et chien vivent manifestement des vies assez similaires. Ils dorment, mangent, courent donc ils apparaissent entourés de mots comparables. Pour réussir à prédire leurs contextes, le réseau finit donc par leur attribuer des représentations qui se ressemblent. Personne ne lui a expliqué qu’un chat et un chien étaient deux animaux domestiques relativement proches. D’ailleurs, il ne sait toujours pas ce qu’est un chat. Il a simplement constaté que chat traîne souvent avec les mêmes mots que chien, et ça suffit.

À force de corriger ses prédictions, les vecteurs complètement aléatoires du départ finissent ainsi par s’organiser. Les mots utilisés dans des contextes similaires occupent des régions similaires de notre espace à 300 dimensions. À la fin de l’entraînement, on récupère ces vecteurs et on les utilise directement comme coordonnées sémantiques de nos mots : on vient de créer un embedding.

## 2. Un mot, un seul vecteur

Maintenant qu’on a la recette de Cémantix, pour en faire une version avec du contexte et proposer un divertissement pascalien digne de ce nom, on prend une jolie phrase dans un livre ou une chanson, on cache quelques mots, et le joueur doit les retrouver. Et voilà, on a créé Cémantix avec du contexte.

Sauf que notre embedding a un défaut de naissance, il est statique : il attribue un seul vecteur à chaque mot, quelle que soit la phrase. Or un mot n’a pas qu’un seul sens. Pendant l’entraînement, voler a traîné aussi souvent avec des avions qu’avec des membres du Rassemblement national, et son vecteur a fini quelque part entre les deux, dans un endroit qui n’est ni tout à fait le ciel ni tout à fait les caisses du Parlement européen.

Tant qu’on devine un mot sans contexte, ce flou n’est pas vraiment un problème, puisque le mot du jour n’a lui-même aucun sens précis. Mais prenons cette phrase :

Ne crains plus jamais le vide, c’est le refuge de ceux qui volent

Ici, aucun cambrioleur. Pourtant, voici les voisins de volent selon l’embedding :

[Voisins de « volent » selon l’embedding : tournoyer, tuer, virevolter, tomber, survoler, planquer, perdre, détruire, écraser, attaquer.]

La moitié de la liste dans le ciel, l’autre moitié dans la biographie de Xavier Dupont de Ligonnès. Mais prenons un autre exemple, plus subtil :

[« On me traite avec une douceur d’infirmière » — voisins de « traite » selon l’embedding : aborder, documenter, consacrer, examiner, disséquer, disserter.]

L’embedding a compris « traiter un sujet ». La phrase, elle, parle de traiter quelqu’un. Le joueur qui tape soigner ou ménager a parfaitement compris la phrase, pourtant le jeu lui répond qu’il en est loin. De cette injustice naît la frustration, et la frustration, ça mène à la guerre. Alors donner une phrase au joueur ne suffit pas. Il faut que l’embedding, lui aussi, lise la phrase.

## 3. Première idée brillante : lire dans les pensées de ChatGPT

Malgré l’immensité de l’univers, il n’y a à notre connaissance que deux types d’êtres capables de comprendre le langage humain. Les humains eux-mêmes, et depuis peu, GPT et ses confrères, les LLM. Le second présente également l’avantage de mieux manipuler les vecteurs à 300 dimensions, on va donc se tourner vers lui.

### Transformers

Avant de parler d’un LLM complet, commençons par la brique dont il est principalement constitué, le Transformer. On a vu comment représenter des mots sous la forme de vecteurs. Un Transformer reçoit plusieurs de ces vecteurs et les transforme pour que chacun puisse intégrer des informations provenant des autres mots de la phrase. Il suffit alors de faire passer une phrase à travers plusieurs couches de Transformers pour obtenir des vecteurs qui ne représentent plus seulement les mots eux-mêmes, mais les mots dans leur contexte. Sur le papier, les Transformers semblent être l’outil idéal pour résoudre notre problème.

Le mécanisme qui permet aux mots de récupérer de l’information les uns chez les autres s’appelle l’attention. Pour chaque mot, le Transformer fabrique trois nouveaux vecteurs à partir de sa représentation actuelle :

Q (query) : ce que je cherche
K (key) : dans quels cas je peux être pertinent
V (value) : l’information que je transmets si on m’écoute

Prenons la phrase suivante et intéressons-nous au mot vole :

Le pigeon vole dans le ciel

Le Transformer reçoit son vecteur et en calcule la Q (query). On peut imaginer qu’elle exprime quelque chose comme :

> Quelles informations du contexte sont importantes pour comprendre mon rôle ici ?

Les autres mots possèdent de leur côté une K (key), et pour déterminer lesquels sont intéressants, le Transformer compare la query de vole aux différentes keys grâce à un produit scalaire. Le produit scalaire dépend à la fois de la longueur des deux vecteurs et de l’angle qui les sépare. À longueur égale, plus ils pointent dans la même direction, plus le résultat est grand, perpendiculaires, on obtient zéro et dans des directions opposées, on passe dans le négatif. On peut donc l’utiliser comme un score de compatibilité entre une Q (query) et une K (key), et ces scores sont ensuite ramenés à des pourcentages dont la somme fait 100 % (grâce à un softmax pour les experts).

[Figure : la query de « vole » comparée aux keys de « Le » (10 %) et de « pigeon » (90 %) dans « Le pigeon vole dans le ciel » : « pigeon » l’emporte.]

Ces pourcentages servent à pondérer les values correspondantes, qui viennent enrichir le vecteur de vole.

[Figure : « vole » avant et après l’attention : la value de « pigeon » le rapproche de « planer » et l’éloigne de « dérober ».]

vole vient ainsi d’intégrer beaucoup d’information provenant de pigeon, sans que le modèle ait reçu une règle écrite à la main disant :

> Si le sujet est un pigeon, alors vole signifie probablement se déplacer dans les airs.

Le modèle a simplement appris que, dans ce genre de contexte, les informations contenues dans pigeon sont très utiles pour représenter correctement vole. Les matrices qui fabriquent Q, K et V sont elles-mêmes des paramètres du réseau. Au début de l’entraînement, elles produisent essentiellement n’importe quoi, puis elles sont progressivement ajustées par descente de gradient, comme nos embeddings.

Une fois l’attention terminée, chaque mot possède une nouvelle représentation, enrichie par ce qu’il a récupéré dans son contexte. Elle passe ensuite par un réseau de neurones plus classique, puis devient l’entrée de la couche Transformer suivante. Et on recommence quelques dizaines de fois. À chaque couche, de nouveaux Q, K et V sont calculés à partir des représentations produites par la précédente. Une première couche peut apprendre une relation relativement simple entre pigeon et vole, puis les suivantes travaillent à partir de cette information déjà intégrée et construisent progressivement des représentations plus riches.

Pour entraîner un modèle comme GPT, on lui donne une tâche assez proche de celle qu’on a utilisée pour les embeddings, prédire la suite d’un texte. On lui montre par exemple Le pigeon et il doit prédire vole, puis Le pigeon vole et il doit prédire dans, et ainsi de suite sur des milliards de morceaux de texte. À chaque prédiction, on calcule la loss, puis les gradients, et on modifie légèrement tous les paramètres. À force de prédire la suite de milliards de phrases, le modèle apprend progressivement quels mots doivent s’écouter et quelles informations doivent circuler entre eux. C’est ainsi qu’un immense empilement de couches Transformer, entraîné avec l’objectif assez basique de deviner le mot suivant, finit par construire quelque chose qui ressemble dangereusement à une compréhension fine du contexte.

### Ouvrir le capot

À chaque couche du réseau, chaque mot possède donc un vecteur qui a écouté son contexte. Ce vecteur intermédiaire porte un nom, le hidden state. C’est exactement ce qui manquait à Cémantix : un embedding qui a lu la phrase et qui peut faire la différence entre le vol du pigeon et le vol des terres en Cisjordanie. Dans l’utilisation normale d’un LLM, on ne regarde pas directement ces vecteurs, on laisse le modèle aller jusqu’au bout et on lit le texte qu’il produit. Mais rien ne nous interdit de l’arrêter en chemin et de récupérer le vecteur produit par la couche qui nous intéresse.

Rien, sauf OpenAI. ChatGPT ne laisse pas ouvrir son capot, il nous faut donc un modèle dont on puisse télécharger les paramètres et qu’on puisse faire tourner nous-mêmes. Heureusement, les voies du communisme de marché sont impénétrables, et Alibaba distribue gratuitement les poids de son modèle Qwen.

### Le plan

Reprenons notre phrase :

Le pigeon vole dans le ciel

- On prend les 10 000 mots les plus proches de vole selon notre embedding classique à la Cémantix.

[Voisins de « vole » selon l’embedding classique : tournoyer, tuer, virevolter, tomber, survoler, planquer, perdre, détruire, écraser, attaquer.]

- On écrit 10 000 versions de notre phrase en remplaçant vole par chacun de ces mots.

Le pigeon tournoie dans le ciel
Le pigeon tue dans le ciel
Le pigeon virevolte dans le ciel
...

-
On montre ces 10 000 phrases au LLM, on récupère à chaque fois le hidden state du mot testé, et on calcule sa distance avec celui de vole dans la phrase originale.

-
On trie à nouveau la liste, mais selon cette distance contextuelle.

[Retriés selon la distance contextuelle : envoler, tournoyer, planer, virevolter, flotter.]

On tient notre solution. On garde Cémantix pour trouver rapidement des candidats, puis on utilise un LLM pour éliminer ceux qui ont le mauvais sens. On ne compare plus voler et tuer dans le vide, on les laisse d’abord lire leur phrase respective, puis on compare ce qu’ils sont devenus. En théorie, l’idée est parfaite.

Pourtant, l’article n’en est pas encore à sa moitié. La théorie avait omis trois détails importants.

### Problème 1 : masque causal

Premier détail passé sous silence. Pendant l’attention, un mot ne peut écouter que ce qui le précède. On appelle ça le masque causal, et c’est logique : le modèle est entraîné à deviner la suite, on ne va pas la lui montrer. Prenons une nouvelle phrase :

Le pigeon vole de l’argent

[Figure : « Le pigeon vole de l’argent » — quand le modèle calcule « vole », « argent » n’est pas encore arrivé.]

Quand le modèle calcule le hidden state de vole, il a entendu Le et pigeon, mais il n’a jamais entendu parler d’argent. La partie la plus utile de la phrase lui est invisible et le modèle ignore tout de la kleptomanie du pigeon. Pour qu’un mot ait lu toute la phrase, il faut donc le placer après elle :

Contexte :
Le pigeon <CIBLE> de l’argent

Lexème :
voler

Cette fois, voler a tout lu. Malheureusement, rien ne le pousse vraiment à faire le lien avec la phrase du haut, et son vecteur retombe sur un sens assez général, proche de celui de l’embedding statique :

[Voisins de « voler » placé après la phrase : dérober, survoler, chiper, planer, chaparder, envoler, cambrioler.]

### Problème 2 : mot ≠ token

Depuis le début, je fais comme si un LLM lisait des mots. C’est faux. Il lit des tokens, des morceaux de texte choisis pour être réutilisables. Un mot courant peut tenir dans un seul token, un mot plus rare peut être découpé en plusieurs, et il a alors un hidden state par token. Il faut choisir lequel utiliser, et comme chaque token ne peut lire que ce qui le précède, le dernier est un candidat assez naturel : il a au moins vu tous les morceaux précédents du même mot.

Dans le cas de Qwen 3, par exemple, cafard est découpé en caf- et -ard. Voici ce qu’on retrouve alors parmi les plus proches voisins de son dernier token, -ard :

[« on différencie de moins en moins le cafard de l’homme » — voisins du dernier token « -ard » : canard, nanard, conard, bagnard, binoclard, sauciflard.]

Pas un seul insecte, alors que l’embedding statique proposait cancrelat, blatte et cloporte. On a juste transformé Cémantix en un dictionnaire de rimes.

À noter que le cloporte n’est pas un insecte mais un crustacé.

### Problème 3 : les LLM prédisent des tokens, pas des distances

Troisième détail, et le plus profond. Notre embedding à la Cémantix a été entraîné de manière à ce que les mots employés dans des contextes similaires obtiennent des vecteurs proches. Un LLM, lui, est entraîné avec un autre objectif : prédire le token suivant. Rien ne garantit donc que la géométrie brute de ses hidden states constitue une bonne distance sémantique. Ces vecteurs sont avant tout des représentations intermédiaires, utiles au modèle pour poursuivre son calcul.

Premier symptôme, les vecteurs se ressemblent beaucoup trop. Avec notre embedding statique, on mesurait la proximité entre deux mots avec la similarité cosinus, un produit scalaire entre deux vecteurs préalablement ramenés à une longueur de 1. Il ne reste alors que l’angle : deux vecteurs qui pointent dans la même direction sont considérés comme très similaires, peu importe leur longueur.

Dans un embedding idéal, les vecteurs seraient assez bien répartis dans toutes les directions. Mais les hidden states d’un LLM ont tendance à s’entasser dans une même région de l’espace. Résultat, même deux mots qui n’ont rien à voir partagent déjà une grande partie de leur direction. Dans mes tests, les similarités sont presque toujours comprises entre 0,45 et 0,88, sur une échelle où 1 signifie que deux vecteurs pointent exactement dans la même direction et 0 qu’ils sont perpendiculaires. Ce phénomène porte un nom, l’anisotropie.

On peut essayer d’en retirer une partie. Si tous les vecteurs ont tendance à pointer vers le même endroit, on calcule leur vecteur moyen, puis on le soustrait à chacun d’entre eux. En gros, on retire à tous ce qu’ils avaient en commun avant de recommencer à mesurer leurs différences. Ça étale un peu mieux les candidats et rend leurs similarités plus discriminantes. Mais pas suffisamment.

[Figure : des hidden states qui pointent tous à peu près dans la même direction, puis les mêmes une fois leur vecteur moyen retiré.]

Second symptôme, dans les dernières couches, le modèle ne pense plus seulement au sens du mot. Il prépare surtout ce qui ferait sens à cet endroit de la phrase :

[« jusqu’à sa retraite » — voisins dans les dernières couches : rentrée, mariage, grève.]

Des événements qui se placent très bien après « jusqu’à sa », mais qui n’ont que peu de rapport avec la retraite. Le modèle mesure en grande partie à quel point le candidat fonctionne bien avec ce qui l’entoure, alors que nous voulons mesurer à quel point son sens correspond à celui du mot caché. On voulait une distance sémantique, on a fabriqué un exercice à trous.

Le projet semblait voué à l’échec, mais trifouiller dans les entrailles d’un LLM m’amusait toujours davantage que de retourner sur Cémantix la queue entre les jambes pour deviner le mot « bistouquette » en 328 essais. Alors j’ai continué à chercher et j’ai fini par trouver (un peu).

### Retourner le problème contre lui-même

Puisque le modèle est obsédé par la suite de la phrase, autant retourner le problème contre lui et faire en sorte que la suite en question soit précisément la réponse qu’on cherche :

Contexte:
Une michtoneuse un mec fauché, ça va pas ensemble

Dans ce contexte, un mot proche de « fauché » :

Cette fois, on ne récupère plus le vecteur de fauché mais celui des deux-points, tout à la fin du prompt. Ce token-là a tout lu : la phrase, le mot qui nous intéresse et la consigne. Et comme son rôle est de préparer ce qui vient juste après, on peut imaginer qu’à cet instant le modèle se pose une question assez proche de la nôtre :

> Je vais devoir écrire un mot qui veut dire à peu près la même chose que fauché dans cette phrase.

On ne mesure donc plus la représentation du mot lui-même, avec son orthographe et son éventuelle découpe en plusieurs tokens, mais l’état du modèle juste avant qu’il propose une réponse. Ça résout au passage notre problème avec les mots découpés comme cafard : peu importe qu’ils occupent un ou cinq tokens, en arrivant aux deux-points le modèle les a déjà tous lus. Et en regardant couche par couche, sur un modèle qui en compte 36, on voit même la réponse se préciser progressivement :

[Voisins de « fauché » couche par couche. Couche 22 : fauchée, fauchage, faucheur, faucheux, fâché. Couche 28 : fauchée, faucheur, sans-le-sou, désargenté, pauvre. Couche 33 : désargenté, sans-le-sou, impécunieux, indigent, démuni.]

Au milieu du réseau, la représentation reste encore très sensible à la forme de fauché. Quelques couches plus tard, les voisins orthographiques disparaissent progressivement au profit de mots liés à son sens dans la phrase. Le modèle a fini par comprendre qu’on parlait d’un type sans argent, et quelques autres exemples choisis précisément pour leur ambiguïté commencent alors à fonctionner correctement :

[« Ne crains plus jamais le vide, c’est le refuge de ceux qui volent » — voisins : envoler, voltiger, planer.]

[« On me traite avec une douceur d’infirmière » — voisins : manier, dorloter, soigner.]

### C’est mieux mais c’est pas encore ça

Sauf que cette solution se généralise assez mal. Des sosies orthographiques continuent à remonter dans les classements, heures se retrouve par exemple 4e voisin de heureux, et le haut des listes reste parfois franchement bruité. Dans c’étaient des nerfs parfaits, nerfs se retrouve entouré d’organes, de thymus et de gut.

Surtout, je n’ai aucun moyen de vraiment parler au modèle. Un vecteur me donne une distance, mais il ne me permet pas de lui expliquer ce qui ne doit pas compter. Si un mot est récompensé simplement parce qu’il rime avec la réponse, je ne peux pas écrire quelque part « arrête avec les rimes ». Je peux seulement modifier le prompt et prier. J’ai d’ailleurs essayé plusieurs formulations, elles produisaient toutes des classements différents, mais aucune ne se distinguait vraiment par sa pertinence.

Pour éviter d’accuser injustement les LLM sur la base d’un seul modèle, j’ai répété l’expérience sur plusieurs générations et architectures :

### Qwen 3

J’ai d’abord testé Qwen 3, qui utilise l’architecture Transformer classique qu’on vient de décrire, dans plusieurs tailles de 0,6 à 14 milliards de paramètres, sans quantification. Augmenter la taille n’améliorait pas toujours les résultats, et les mêmes défauts de fond revenaient.

### Qwen 3.5

Qwen 3.5 utilise une architecture plus récente : dans trois couches sur quatre, l’attention classique est remplacée par un mécanisme de mémoire linéaire moins coûteux (Gated DeltaNet pour les experts encore). Ça n’a rien changé à notre problème. cafard continue à rimer, et sur six mots ambigus ce modèle s’est même montré moins efficace que sa génération précédente. Détail savoureux, pour volent, la version à 4 milliards de paramètres a compris le ciel, et celle à 9 milliards les portefeuilles. En faisant grossir le modèle, j’avais perdu en pertinence. Mon approche n’était clairement pas la bonne.

### Qwen 3 – Embedding

Il existe justement des LLM réentraînés pour fabriquer de bons vecteurs. Cette fois, on leur apprend explicitement que des textes sémantiquement proches doivent produire des représentations proches, et que des textes sans rapport doivent s’éloigner. Ce sont des modèles d’embedding, et c’est exactement la propriété qui manquait à nos hidden states bricolés à la main. Qwen propose ainsi Qwen3-Embedding, une famille construite à partir de Qwen 3 puis spécialement entraînée pour produire des représentations destinées à la recherche et à la comparaison sémantique. Je l’ai testé de plusieurs façons. Les résultats étaient au même niveau médiocre que mes hidden states.

### Qwen 3 – Reranker

Qwen distribue aussi Qwen3-Reranker, peut-être le candidat le plus prometteur sur le papier. Quand on fait une recherche sur Google, le moteur ramasse d’abord des milliers de pages potentiellement pertinentes, puis il les reclasse pour mettre les meilleures en tête. Ce second tri, c’est le travail d’un reranker, un modèle qui relit la recherche avec chaque page et juge si elle y répond. Ça ressemble à notre problème, formulé différemment. La phrase, avec son mot caché, c’est notre recherche Google, et l’embedding de Cémantix qui nous fournit 10 000 mots potentiellement pertinents, ce sont les résultats à reclasser. Cette fois, pas de distance à calculer ni d’entrailles de Transformer à trifouiller, on demande simplement au reranker de faire son travail.

Il comprend bien fauché et cafard comme la phrase l’entend, mais un reranker est d’abord conçu pour juger la pertinence d’un résultat par rapport à une recherche. Il fait donc remonter les mots qui vont bien avec la recherche, pas nécessairement ceux qui veulent dire la même chose, chômeur arrive deuxième pour fauché. Ce qui a du sens, mais c’est pas exactement ce qu’on cherche à obtenir ici.

Dans mes tests, il avait aussi une fâcheuse tendance à prendre la consigne pour un bout de la recherche. Même en lui indiquant explicitement qu’étouffer ne devait pas être considéré comme proche d’émotions, il continuait à le classer parmi les tout premiers. Un peu comme si j’avais tapé « recette sans cacahuètes » dans Google et que le moteur de recherche s’était focalisé sur recette et cacahuète.

Alors c’est tout ? Je ne suis qu’un bidouilleur de pacotille incapable d’améliorer l’horrible Cémantix et mon destin est de continuer à me faire torturer quotidiennement par des mots de plus en plus absurdes ?

## 4. La solution : arrêter de mesurer, poser la question

C’est à ce moment que je suis tombé sur Jev, un modèle de décision sorti en septembre 2026 par TypeSafe. Alors de quoi est fait ce fameux modèle qui a réussi là où les LLM ont échoué ? On ne sait pas exactement, TypeSafe parle d’une nouvelle architecture sans en publier les détails. Mais on peut quand même se faire une assez bonne idée du principe. Prendre un modèle capable de comprendre du texte, puis remplacer sa vocation d’écrivain par celle de juge. Un LLM classique termine son calcul en essayant de répondre à cette question :

> Quel token dois-je écrire ensuite ?

Un modèle de décision peut utiliser une représentation du même genre, mais terminer par une petite couche spécialisée, un classifier, qui répond plutôt à :

> Parmi ces réponses, laquelle semble correcte, et avec quelle probabilité ?

En simplifiant énormément, ça donne quelque chose comme :

[Figure : un LLM lit un texte, en fait une représentation, puis des probabilités sur tous les prochains tokens, et écrit du texte. Un modèle de décision lit un texte et une question, en fait une représentation, puis un classifier donne des probabilités sur les réponses proposées.]

Le gros du travail reste le même : lire le langage, comprendre les relations entre les mots et construire une représentation du contexte. C’est seulement à la fin qu’on lui demande autre chose, et c’est précisément ce dont on a besoin. On a passé tout ce temps à récupérer les vecteurs intermédiaires d’un modèle entraîné à écrire, en espérant que leur géométrie réponde malgré tout à notre objectif. Cette fois, on peut simplement poser la question :

> Dans cette phrase, à quel point ce mot est-il proche de celui-là ?

Étudions le nouveau plan.

### Une note pour chaque candidat

Cémantix garde son rôle de rabatteur. Il fournit les 10 000 voisins du mot caché, sans se soucier du contexte, et chacun reçoit ensuite une note de Jev :

0 : aucun rapport de sens avec le mot secret tel qu’employé dans la phrase
1 : rapport lointain, même domaine très général
2 : lié, même champ lexical ou idée voisine
3 : très proche, quasi-synonyme
4 : même sens, synonyme direct dans ce contexte

La consigne est écrite en français ordinaire : seul le sens compte, pas la grammaire, pas l’orthographe, pas le fait que le candidat puisse remplacer le mot dans la phrase. Reprenons nerfs :

[Voisins de « nerfs » dans « c’étaient des nerfs parfaits ». Qwen : organes, thymus, esprits, médicaux, moelles, gut. Jev : nervosité, excitabilité, nerveux, énervement, irritable.]

Jev a compris qu’on parlait de tempérament et pas de neurologie. Quant aux rimes et aux voisins orthographiques, ils ont disparu pour de bon. Au début, Jev faisait pourtant lui aussi des erreurs :

[« la force d’étouffer mes émotions » — « étouffer » classé 28e voisin d’« émotions ».]

étouffer n’est pas un mot proche d’émotions, c’est un mot de la phrase. Alors j’ai ajouté une ligne à la consigne :

> Un candidat qui figure dans la phrase, ou qui décrit ce que la phrase fait du mot secret, n’est pas plus proche pour autant.

étouffer est passé de la 28e à la 1 182e place. En trifouillant dans les hidden states, je pouvais constater qu’un résultat était mauvais, mais pas expliquer au vecteur pourquoi. Ici, si Jev se trompe pour une raison que je peux formuler, je peux simplement lui dire.

Tout ne se règle pas avec des mots pour autant. J’avais aussi écrit qu’un candidat qui n’est pas français méritait la note la plus basse, et Jev l’a superbement ignoré. retirement est resté premier voisin de retraite. J’ai fini par régler ça avec du code, en rétrogradant les mots trois fois plus fréquents dans un corpus anglais que dans un corpus français.

### Un tournoi pour départager les vainqueurs

Jev n’est pas non plus parfaitement stable. Si je lui demande plusieurs fois de noter le même candidat, sa réponse peut varier d’environ 0,1 point. Au fond du classement, ça ne change pas grand-chose. Le 7 400e mot peut devenir le 7 500e, ça ne bouleversera pas le jeu. En haut du classement, c’est différent. C’est là que l’ordre compte le plus, et si les mots classés 50e et 150e ont des notes presque identiques, une telle variation suffit à les rendre interchangeables. Jev sait donc assez bien quels mots méritent d’entrer dans les 200 premiers, mais beaucoup moins bien dans quel ordre les ranger.

Alors on va organiser un tournoi. Les 200 meilleurs candidats s’affrontent tous deux à deux, soit 19 900 duels, avec une seule question :

> Lequel de ces deux mots est le plus proche du mot secret dans cette phrase ?

Pour chaque duel, Jev donne une probabilité de victoire aux deux candidats, et le score final d’un mot est simplement sa probabilité moyenne de victoire sur l’ensemble de ses confrontations. Un algorithme de tri classique demanderait beaucoup moins de comparaisons. Mais un tri suppose qu’on puisse faire confiance à la fonction qui compare deux éléments. Si A > B et B > C, on aimerait raisonnablement pouvoir en déduire que A > C. Jev, lui, peut très bien répondre que A < C, il n’est ni parfaitement déterministe, ni parfaitement transitif. Dans un tri classique, une mauvaise comparaison pourrait envoyer un mot au mauvais endroit et influencer toute la suite. Dans un tournoi complet, chaque candidat affronte les 199 autres, et s’il prend une décision étrange, elle se retrouve diluée parmi 198 autres confrontations.

Et ça fonctionne vraiment. Pour le mot secret froidement, impassibilité passe de la 8e à la 2e place. Pour beauté, fascination remonte de la 152e à la 13e.

Enfin, au-delà du 300e rang environ, je conserve simplement l’ordre initial de Cémantix. Personne ne s’en rendra compte, mais maintenant vous le savez.

### Pourquoi ça marche ?

Il faut quand même rendre justice aux LLM. Rien de ce que je demande à Jev ne semble hors de leur portée. Je pourrais prendre un bon modèle, lui montrer la phrase et deux candidats, puis lui demander lequel est sémantiquement le plus proche du mot secret. Il répondrait probablement très bien. Le problème, c’est qu’il faudrait lui poser la question des dizaines de milliers de fois, et une idée parfaitement raisonnable sur le papier devient beaucoup moins séduisante quand chaque petite décision coûte quelques secondes et une requête à un gros modèle.

Jev ne sait rien faire qu’un LLM serait incapable de faire, mais il peut prendre une petite décision sémantique extrêmement vite et pour presque rien. Pour un mot secret, mon système lui fait traiter environ 3,1 millions de tokens, et en mettant la partie fixe de la consigne en cache, l’ensemble me coûte environ 0,13 $. Je peux donc me permettre une stratégie d’une brutalité remarquable : faire juger 10 000 candidats un par un, garder les 200 meilleurs, puis organiser 19 900 duels supplémentaires juste pour mieux les ranger. Avec un modèle plus lent ou plus cher, j’aurais passé mon temps à chercher un algorithme malin pour réduire le nombre de requêtes. Jev, lui, est suffisamment bon marché pour qu’on lui pose trente mille fois la question.

Une opération qui devient cent ou mille fois moins chère ne rend pas seulement la même solution plus économique, elle rend possibles des solutions qu’on aurait auparavant écartées avant même de les essayer.

## 5. Merci quand même

Quelques embeddings, plusieurs milliards de paramètres, des centaines de milliers de comparaisons et une quantité raisonnable d’acharnement plus tard, le problème est à peu près résolu et Cémantix peut enfin quitter définitivement mon quotidien.

Mais au final, aucun jeu daily ne m’aura autant diverti que lorsque j’ai tout fait pour ne plus jamais avoir à jouer à Cémantix.

Alors merci Cémantix.`;
