// THE ENGLISH ARTICLE LEVELS: the French levels (fr.ts) in English, block for block — the same
// content, the same cuts, the same rules (fr.ts's header holds them) — over the author's English
// article « I improved Semantle with an AI that can’t talk » (chqrles.me/en/words-in-context).
// Where a French level reuses a paragraph of the French article unedited, this one reuses the
// English article's paragraph, not a comma changed; where the French level changes one, the
// English one is changed the same way; the French levels' own sentences are translated. The
// examples are the English article's own (`bank` and the duck, the Ohio, `treats`, `nerves`,
// `coldly`), each figure redrawn with them, and its numbers are the French level's — the
// English article prints the French runs' numbers for its words, and so does this cut (the
// tournament's rows and the embedding's list for `nerves` are the French data, translated).
// What the French level replaced, this one replaces alike: the crime pages for Bonnie and
// Clyde, the game for Semantle.
import type { Article } from './types';

const SOURCE = {
  text: '“I improved Semantle with an AI that can’t talk”',
  href: 'https://chqrles.me/en/words-in-context/',
};

const distance: Article = {
  sections: [
    {
      blocks: [
        {
          p: 'How can the game calculate the distance between the meanings of words? A distance is a numerical value, so we have to find a way to express the meaning of words in numerical form too. Basically, expressing complex information as numbers has a name: it’s called an **embedding**. We could, for example, give words coordinates, which would then make it easy to measure how close two words are.',
        },
        {
          fig: {
            kind: 'plane',
            states: [
              [
                { word: 'cat', x: 1.5, y: 3.2 },
                { word: 'dog', x: 3, y: 3.6 },
                { word: 'wolf', x: 4.6, y: 1.6, label: 'below' },
              ],
            ],
            edges: [
              [0, 1],
              [1, 2],
              [0, 2],
            ],
          },
          caption: '`cat`, `dog` and `wolf` on a plane: two coordinates per word, one distance per pair.',
        },
        {
          p: 'The idea looks good, but the more words we add to our plane, the harder it gets to spread them out intelligently, and two dimensions won’t be enough for long. So we’ll go from 2 to, say, 300 dimensions. That’s much harder to draw, but far more practical for filing away hundreds of thousands of words. The real problem finally takes shape. How do we choose the 300 coordinates of each word?',
        },
      ],
    },
    {
      heading: 'Skip-gram / word2vec',
      blocks: [
        {
          p: 'We start by assigning a random vector to each word. At this stage, our coordinates mean absolutely nothing, and to give them meaning we’ll ask a neural network to do something fairly simple: given a word, predict the ones likely to appear around it. We give it `cat` and it assigns a probability to every word it knows. Since everything is still more or less random, its first answers look like this:',
        },
        {
          fig: {
            kind: 'bars',
            rows: [
              ['glass', 5],
              ['funny', 4.8],
              ['engine', 4.6],
              ['clavicle', 4.5],
              ['September', 4.4],
              ['casserole', 4.3],
            ],
          },
          caption: 'The network’s first predictions around `cat`, when its vectors still mean nothing.',
        },
        {
          p: 'Now we need a way to tell it that it’s talking nonsense. To do that, we build a large reference corpus from carefully selected texts: books, Wikipedia pages, academic papers, for example.\nLet’s take an ambitious sentence from our corpus:',
        },
        { sentence: ['The `cat` eats a mouse'] },
        {
          p: 'We pick `cat` and look at what appears around it: `the`, `eats`, `a`. That’s what the network is supposed to predict. If it considers `engine` far more likely than `eats`, it has obviously made a mistake. We still have to put a number on how wrong it is, so we sum up all its errors in a score we call the **loss**: the higher it is, the worse its predictions.',
        },
        {
          p: 'We now know how to measure the problem, but not yet how to fix it. The network contains a huge number of parameters, including the coordinates of our vectors, and we need to know which ones to move and in which direction. For each one, we calculate the effect a tiny change would have on the loss. Basically, for each vector we answer the question:',
        },
        { quote: 'If I change this coordinate very slightly, does the loss go up or down, and by how much?' },
        {
          p: 'All these variations make up the **gradient**, a vector that points in the direction in which the loss would increase the most, so we do something very sophisticated: we go the other way. We slightly change the parameters, make a new prediction, recalculate the error, then start over. That’s **gradient descent**.',
        },
        {
          fig: {
            kind: 'loop',
            steps: [
              'predicting',
              'comparing with the actual context',
              'computing the loss',
              'computing the gradients',
              'nudging the vectors',
            ],
          },
          caption: 'And we start over, a few billion times.',
        },
        {
          p: 'After “just” a few billion repetitions, the loss starts to come down in earnest. But what we really care about is what all these corrections did to our vectors. Say the network regularly comes across sentences like these:',
        },
        {
          sentence: [
            'The `cat` sleeps on the couch',
            'The `dog` sleeps on the rug',
            'I give my `cat` something to eat',
            'I give my `dog` something to eat',
            'The `cat` runs in the garden',
            'The `dog` runs in the garden',
          ],
        },
        {
          p: '`cat` and `dog` obviously live fairly similar lives. They `sleep`, `eat` and `run`, so they appear surrounded by comparable words. To predict their contexts correctly, the network ends up giving them representations that look alike. Nobody told it that a cat and a dog are two fairly similar domestic animals. In fact, it still doesn’t know what a cat is. It simply noticed that `cat` often hangs out with the same words as `dog`, and that’s enough.',
        },
        {
          p: 'As it keeps correcting its predictions, the completely random vectors we started with end up organizing themselves. Words used in similar contexts occupy similar regions of our 300-dimensional space. At the end of training, we take these vectors and use them directly as the semantic coordinates of our words: we’ve just created an **embedding**.',
        },
        { p: 'Yet this embedding has a birth defect, which we’ll look at in the next level.' },
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
          p: 'Our embedding has a birth defect: it’s **static**. It assigns a single vector to each word, whatever the sentence. But words don’t have just one meaning. During training, `bank` hung out as often with ducks as with tax advisers, and its vector ended up somewhere in between, a place that’s neither quite the shore nor quite an offshore account.',
        },
        {
          fig: {
            kind: 'plane',
            states: [
              [
                { word: 'riverside', x: 0.7, y: 4.9 },
                { word: 'shore', x: 1.2, y: 3.9 },
                { word: 'bank', x: 3, y: 3, focus: true },
                { word: 'loan', x: 4.8, y: 2.1, label: 'below' },
                { word: 'vault', x: 5.0, y: 0.9, label: 'below' },
              ],
            ],
            edges: [
              [1, 2],
              [2, 3],
            ],
          },
          caption: 'One point for two meanings: `bank`, halfway between the river and the vault.',
        },
        {
          p: 'As long as we’re guessing a word without context, this fuzziness isn’t really a problem, since the word to find itself has no precise meaning. But let’s take this sentence:',
        },
        { sentence: ['Down beside where the waters flow, down by the `banks` of the Ohio'] },
        {
          p: 'No robbers in sight. And yet, here are the neighbors of `banks^0` according to the embedding:',
        },
        {
          fig: {
            kind: 'words',
            lists: [
              {
                words: ['shore', 'loan', 'creek', 'vault', 'slope', 'deposit', 'riverside', 'robbery', 'heist', 'teller'],
                marked: ['loan', 'vault', 'deposit', 'robbery', 'heist', 'teller'],
                tone: 'wrong',
              },
            ],
          },
          caption: 'The ten nearest neighbors of `banks^0` according to the embedding. In color, the ones that have nothing to do with the river.',
        },
        {
          p: 'Half the list by the river, the other half in the crime pages. But let’s take another, more subtle example:',
        },
        {
          fig: {
            kind: 'words',
            sentence: 'She `treats` me with a nurse’s gentleness',
            lists: [{ words: ['address', 'document', 'cover', 'examine', 'dissect', 'discuss'] }],
          },
          caption: 'Among the nearest neighbors of `treats^0` according to the embedding.',
        },
        {
          p: 'The embedding read it as “to treat a subject.” The sentence, though, is about treating someone. A player who types `tend` or `coddle` has perfectly understood the sentence, yet the embedding tells them they’re far off. This injustice breeds frustration, and frustration leads to war. So giving the player a sentence isn’t enough. The embedding, too, has to read the sentence.',
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
          p: 'For all the vastness of the universe, as far as we know there are only two kinds of beings capable of understanding human language. Humans themselves and, very recently, GPT and its fellow LLMs. The latter also happen to be better at handling 300-dimensional vectors, so that’s where we’ll turn.',
        },
      ],
    },
    {
      heading: 'Transformers',
      blocks: [
        {
          p: 'Before talking about a full LLM, let’s start with the building block it’s mostly made of, the **Transformer**. We’ve seen how to represent words as vectors. A Transformer receives several of these vectors and transforms them so that each one can take in information coming from the other words in the sentence. Then all it takes is to run a sentence through several layers of Transformers to get vectors that no longer represent just the words themselves, but the words in their context. On paper, Transformers look like the ideal tool to solve our problem.',
        },
        {
          p: 'The mechanism that lets words pick up information from one another is called **attention**. For each word, the Transformer builds three new vectors from its current representation:',
        },
        {
          terms: [
            ['Q (query)', 'what I’m looking for'],
            ['K (key)', 'when I might be relevant'],
            ['V (value)', 'the information I pass on if anyone’s listening'],
          ],
        },
        { p: 'Let’s take the following sentence and focus on the word `bank`:' },
        { sentence: ['The duck swims to the `bank`'] },
        {
          p: 'The Transformer receives its vector and computes its **Q (query)**. We can imagine it expresses something like:',
        },
        { quote: 'What in the context matters for understanding my role here?' },
        {
          p: 'Each of the other words has a **K (key)**, and to determine which ones are interesting, the Transformer compares the query of `bank` with each of those keys using a **dot product**. The dot product depends on both the length of the two vectors and the angle between them. For a given length, the more they point in the same direction, the bigger the result: at right angles it’s zero, and in opposite directions it goes negative. We can therefore use it as a compatibility score between a **Q (query)** and a **K (key)**, and these scores are then converted to percentages that add up to 100% (via a softmax, for those who care).',
        },
        {
          fig: {
            kind: 'arcs',
            tokens: ['The', 'duck', 'swims', 'to', 'the', 'bank'],
            focus: 5,
            weights: [0.04, 0.7, 0.2, 0.03, 0.03, null],
          },
          caption: 'The query of `bank` compared with the keys of the words before it: `duck` wins.',
        },
        {
          p: 'These percentages are used to weight the corresponding **values**, which then enrich the vector of `bank`.',
        },
        {
          fig: {
            kind: 'plane',
            tabs: ['Before', 'After'],
            states: [
              [
                { word: 'shore', x: 0.9, y: 4.2 },
                { word: 'bank', x: 2.6, y: 3.4, focus: true, label: 'below' },
                { word: 'loan', x: 4.5, y: 2.9, label: 'below' },
              ],
              [
                { word: 'shore', x: 0.9, y: 4.2 },
                { word: 'bank', x: 1.5, y: 3.4, focus: true, label: 'below' },
                { word: 'loan', x: 4.5, y: 2.9, label: 'below' },
              ],
            ],
            edges: [
              [0, 1],
              [1, 2],
            ],
          },
          caption: '`bank` before and after attention: the value of `duck` brings it closer to `shore` and moves it away from `loan`.',
        },
        {
          p: 'So `bank` has just taken in a lot of information from `duck`, without anyone giving the model a handwritten rule saying:',
        },
        { quote: 'If the subject is a duck, then bank probably means the side of a river.' },
        {
          p: 'The model simply learned that, in this kind of context, the information contained in `duck` is very useful for correctly representing `bank`. The matrices that produce Q, K and V are themselves parameters of the network. At the start of training, they produce essentially nonsense, then they are gradually adjusted by **gradient descent**, like our **embeddings**.',
        },
        {
          p: 'Once attention is done, each word has a new representation, enriched by what it picked up from its context. It then goes through a more conventional neural network before becoming the input of the next Transformer layer. And the whole thing repeats a few dozen times. At each layer, new Q, K and V are computed from the representations produced by the previous one. An early layer might learn a fairly simple relationship between `duck` and `bank`, and later layers build on that to form progressively richer representations.',
        },
        {
          p: 'To train a model like GPT, we give it a task fairly close to the one we used for embeddings: predicting what comes next in a text. We show it, for example, `The duck`, and it has to predict `swims`, then `The duck swims`, and it has to predict `to`, and so on over billions of pieces of text. At each prediction, we calculate the **loss**, then the **gradients**, and we slightly change all the parameters. After predicting what comes next in billions of sentences, the model gradually learns which words should listen to each other and which information should flow between them. That’s how a huge stack of Transformer layers, trained with the rather basic goal of guessing the next word, ends up building something that looks dangerously like a nuanced understanding of context.',
        },
        {
          p: 'We could then use an LLM’s Transformers to adjust the vectors of our words according to their context. But in practice it doesn’t work very well, for several reasons detailed in [this article](https://chqrles.me/en/words-in-context/#opening-the-hood). To solve our problem, we will indeed use Transformers, but not an LLM.',
        },
      ],
    },
  ],
  source: SOURCE,
};

const judge: Article = {
  sections: [
    {
      heading: 'The solution: stop measuring, start asking',
      blocks: [
        {
          p: 'The game uses **Jev**, a decision model released in September 2026 by TypeSafe. So what is this wonder model actually made of? We don’t know exactly: TypeSafe mentions a new architecture but hasn’t published the details. But we can still get a fairly good idea of the principle. Take a model that understands text, then make it switch careers: from writer to judge. A standard LLM ends its calculation by trying to answer this question:',
        },
        { quote: 'Which word should I write next?' },
        {
          p: 'A decision model can use a representation of the same kind, but end with a small specialized layer, a **classifier**, which answers this instead:',
        },
        { quote: 'Among these answers, which one seems correct, and with what probability?' },
        { p: 'Grossly oversimplified, it looks something like this:' },
        {
          fig: {
            kind: 'flow',
            rows: [
              { name: 'LLM', steps: ['text', 'representation', 'probabilities over the next word', 'text'] },
              {
                name: 'Decision model',
                steps: ['text + question', 'representation', 'classifier', 'probabilities over the proposed answers'],
                marked: [0, 2],
              },
            ],
          },
          caption: 'The same reading, a different ending.',
        },
        {
          p: 'The bulk of the work stays the same: reading language, understanding the relationships between words and building a representation of the context. Only at the end do we ask it for something else, and that’s precisely what we need. We can simply ask the question:',
        },
        { quote: 'In this sentence, how close is this word to that one?' },
      ],
    },
    {
      heading: 'A rating for each candidate',
      blocks: [
        {
          p: 'The embedding stays on as the talent scout. It rounds up the 10,000 neighbors of the hidden word, without worrying about context, and Jev then rates each one:',
        },
        {
          code: [
            '0: no relation in meaning to the secret word as used in the sentence',
            '1: distant relation, same very general domain',
            '2: related, same semantic field or neighboring idea',
            '3: very close, near-synonym',
            '4: same meaning, direct synonym in this context',
          ],
        },
        {
          p: 'The instructions are written in plain English: only meaning counts, not grammar, not spelling, not whether the candidate can replace the word in the sentence. Let’s take `nerves^0`:',
        },
        {
          fig: {
            kind: 'words',
            sentence: 'They were bundles of `nerves`',
            tabs: true,
            lists: [
              { label: 'Embedding', words: ['muscles', 'neurons', 'nervous', 'intestines', 'kidneys'] },
              {
                label: 'Jev',
                words: ['nervousness', 'excitability', 'nervous', 'irritation', 'irritable'],
                marked: ['nervousness', 'excitability', 'nervous', 'irritation', 'irritable'],
                tone: 'right',
              },
            ],
          },
          caption: 'Among the nearest neighbors of `nerves^0` according to the embedding alone, then according to Jev in its sentence.',
        },
        {
          p: 'Jev understood we were talking about temperament and not neurology. Let’s take a new sentence:',
        },
        { sentence: ['the strength to stifle my `emotions`'] },
        {
          p: '`stifle` isn’t a word close to `emotions^0`, it’s a word from the sentence. Yet Jev would rank it 27th without this line in the instructions:',
        },
        {
          quote:
            'A candidate that appears in the sentence, or that describes what the sentence does with the secret word, isn’t any closer because of it.',
        },
        {
          p: 'With the line, it drops to 1,182nd place. If Jev gets it wrong for a reason I can put into words, I can simply tell it.',
        },
        {
          p: 'Foreign words go through another question, asked separately for each of the top 200: is this really an English word? A word that fails is sent to the very bottom; otherwise `retraite` would be the first neighbor of `retirement^0`.',
        },
      ],
    },
    {
      heading: 'A tournament to sort out the winners',
      blocks: [
        {
          p: 'Jev isn’t perfectly stable. If I ask it several times to rate the same candidate, its answer can vary by about 0.1 points. At the bottom of the ranking, that doesn’t change much. If the 7,400th word becomes the 5,000th, it won’t shake up the game. At the top of the ranking, it’s different. That’s where the order matters most, and if the words ranked 50th and 150th have almost identical ratings, such a variation is enough to make them interchangeable. So Jev is pretty good at telling which words belong in the top 200, but much worse at putting them in order.',
        },
        {
          p: 'Time for a tournament. Each of the top 200 candidates faces every other one, for a total of 19,900 duels, all on a single question:',
        },
        { quote: 'Which of these two words is closer to the secret word in this sentence?' },
        {
          p: 'For each duel, Jev gives both candidates a probability of winning, and a word’s final score is simply its average probability of winning across all its matchups. A standard sorting algorithm would need far fewer comparisons. But a sort assumes we can trust the function that compares two elements. If `A > B` and `B > C`, we’d reasonably like to be able to conclude that `A > C`. Jev, on the other hand, may very well answer that `A < C`: it’s neither perfectly deterministic nor perfectly transitive. In a standard sort, one bad comparison could send a word to the wrong place and influence everything that follows. In a full tournament, each candidate faces the other 199, and if Jev makes a strange call, it gets diluted among 198 other matchups.',
        },
        {
          p: 'For the secret word `coldly^0`, `impassivity` goes from 6th to 2nd place. For `beauty^0`, `fascination` climbs from 81st to 13th.',
        },
        {
          fig: {
            kind: 'tournament',
            heads: ['rating', 'tournament', 'average win'],
            labels: ['rank by rating', 'rank in the tournament', 'average probability of winning'],
            rows: [
              { word: 'impassively', from: 1, win: 0.9898 },
              { word: 'impassivity', from: 6, win: 0.977 },
              { word: 'composure', from: 2, win: 0.9763 },
              { word: 'imperturbably', from: 3, win: 0.9762 },
              { word: 'impassive', from: 4, win: 0.9681 },
              { word: 'undaunted', from: 7, win: 0.9562 },
              { word: 'icily', from: 5, win: 0.9357, to: 10 },
            ],
          },
          caption: 'The top of the ranking for `coldly^0`, from the rating to the tournament.',
        },
        {
          p: 'Finally, past 200th place, I just keep the order of Jev’s ratings. Nobody will notice, but now you know.',
        },
      ],
    },
  ],
  source: SOURCE,
};

export const EN_ARTICLES: Record<number, Article> = {
  2: distance,
  3: meanings,
  4: attention,
  5: judge,
};
